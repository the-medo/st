"""Faceplate power control using the paired display and current graphical session."""
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import socket
import socketserver
import subprocess
import threading
import time


class ControlError(RuntimeError):
    pass


def run(args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=4, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ControlError(f"Display command unavailable or timed out: {args[0]}") from error
    if result.returncode:
        raise ControlError("Cannot access the graphical session. Check the display helper's session permissions.")
    return result.stdout


def properties(text):
    return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)


class Faceplate:
    def __init__(self, config, drm=Path('/sys/class/drm'), runner=run, state_path=None):
        self.fingerprint = config.get('faceplate_edid_sha256', '').lower()
        self.drm = Path(drm)
        self.run = runner
        self.lock = threading.Lock()
        self.state_path = state_path
        self.forced_sleep = None
        if state_path and state_path.exists():
            try:
                saved = json.loads(state_path.read_text())
                if isinstance(saved, dict) and set(saved) == {'session', 'fingerprint'}:
                    self.forced_sleep = saved
            except (OSError, ValueError):
                pass

    def remember(self, value):
        if self.state_path:
            temporary = self.state_path.with_suffix('.tmp')
            temporary.write_text(json.dumps(value))
            temporary.chmod(0o600)
            temporary.replace(self.state_path)
        self.forced_sleep = value

    def guard(self):
        """Release our global Gamescope sleep flag when a TV is hot-plugged.

        Keep ownership across helper restarts; never keep a newly attached TV
        asleep because a prior night-mode command targeted the faceplate.
        """
        with self.lock:
            if not self.forced_sleep:
                return
            session = self.session()
            if session != self.forced_sleep['session']:
                return
            external = [d for d in self.displays() if not d['name'].startswith(('eDP-', 'LVDS-', 'DSI-'))]
            if len(external) != 1 or external[0]['fingerprint'] != self.forced_sleep['fingerprint']:
                self.run(self.command(session, 'gamescopectl', 'drm_sleep_external_screen', '0', extra=self.environment(session)))
                self.remember(None)

    def displays(self):
        result = []
        for path in sorted(self.drm.glob('card*-*')):
            if not (path / 'status').exists() or (path / 'status').read_text().strip() != 'connected':
                continue
            edid = (path / 'edid').read_bytes()
            dpms = (path / 'dpms').read_text().strip().lower()
            result.append({'path': path, 'name': path.name.split('-', 1)[1],
                           'fingerprint': hashlib.sha256(edid).hexdigest() if edid else '',
                           'night_mode': False if dpms == 'on' else True if dpms in {'off', 'standby', 'suspend'} else None})
        return result

    def session(self):
        sid = self.run(['loginctl', 'show-seat', 'seat0', '-p', 'ActiveSession', '--value']).strip()
        if not re.fullmatch(r'[a-zA-Z0-9]+', sid):
            raise ControlError('No active graphical session. Log in to Desktop or Gaming Mode.')
        session = properties(self.run(['loginctl', 'show-session', sid, '-p', 'User', '-p', 'Type', '-p', 'Desktop', '-p', 'Active']))
        if session.get('Active') != 'yes' or session.get('Type') != 'wayland' or not session.get('User', '').isdigit():
            raise ControlError('Night mode requires an active Wayland desktop or Gaming Mode session.')
        desktop = session.get('Desktop', '').lower()
        mode = 'gaming' if 'gamescope' in desktop else 'desktop' if any(s in desktop for s in ('kde', 'plasma')) else None
        if not mode:
            raise ControlError('This graphical session does not support faceplate control.')
        return {'id': sid, 'uid': int(session['User']), 'mode': mode}

    def command(self, session, *args, extra=()):
        uid = session['uid']
        prefix = ['sudo', '-n', '-u', f'#{uid}', '--'] if uid != os.getuid() else []
        return prefix + ['env', f'XDG_RUNTIME_DIR=/run/user/{uid}',
                         f'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus', *extra, *args]

    def environment(self, session):
        if session['mode'] == 'gaming':
            text = self.run(self.command(session, 'cat', f"/run/user/{session['uid']}/gamescope-environment"))
            key = 'GAMESCOPE_WAYLAND_DISPLAY'
        else:
            text = self.run(self.command(session, 'systemctl', '--user', 'show-environment'))
            key = 'WAYLAND_DISPLAY'
        value = properties(text).get(key, '')
        if not re.fullmatch(r'[a-zA-Z0-9_-]+', value):
            raise ControlError('The graphical session is starting or its display socket is unavailable. Try again shortly.')
        self.run(self.command(session, 'test', '-S', f"/run/user/{session['uid']}/{value}"))
        return [f'{key}={value}', 'QT_QPA_PLATFORM=wayland']

    def inspect(self):
        if not re.fullmatch(r'[0-9a-f]{64}', self.fingerprint):
            raise ControlError('Pair the faceplate first with scripts/manage.py pair-faceplate --connector NAME.')
        displays = self.displays()
        matches = [d for d in displays if d['fingerprint'] == self.fingerprint]
        if len(matches) != 1:
            raise ControlError('The paired faceplate is disconnected or its identity is ambiguous.')
        target = matches[0]
        session = self.session()
        reason = None
        if len({d['name'] for d in displays}) != len(displays):
            reason = 'Connected displays have ambiguous connector names; no power change is safe.'
        if target['night_mode'] is None:
            reason = 'The faceplate power state is unavailable.'
        if session['mode'] == 'gaming' and any(d != target and not d['name'].startswith(('eDP-', 'LVDS-', 'DSI-')) for d in displays):
            reason = 'Gaming Mode cannot control this faceplate independently while another external display is connected. Use Desktop Mode for separate display control.'
        return target, displays, session, reason

    def status(self):
        try:
            target, _, session, reason = self.inspect()
            return {'available': reason is None, 'night_mode': target['night_mode'],
                    'mode': session['mode'], 'connector': target['name'], 'error': reason}
        except (ControlError, OSError) as error:
            return {'available': False, 'night_mode': None, 'mode': None, 'error': str(error)}

    def apply(self, action):
        if action not in {'on', 'off', 'toggle'}:
            raise ControlError('Use on, off, toggle, or status.')
        with self.lock:
            target, displays, session, reason = self.inspect()
            if reason:
                raise ControlError(reason)
            night = not target['night_mode'] if action == 'toggle' else action == 'on'
            extra = self.environment(session)
            if session['mode'] == 'gaming':
                args = ['gamescopectl', 'drm_sleep_external_screen', '1' if night else '0']
                if target['name'].startswith(('eDP-', 'LVDS-', 'DSI-')):
                    raise ControlError('The paired faceplate must be an external display.')
            else:
                outputs = json.loads(self.run(self.command(session, 'kscreen-doctor', '--json', extra=extra)))['outputs']
                names = {o['name'] for o in outputs if o.get('connected')}
                if target['name'] not in names:
                    raise ControlError('Desktop Mode has not detected the paired faceplate.')
                args = ['kscreen-doctor', '--dpms', 'off' if night else 'on']
                for name in sorted(names - {target['name']}):
                    args.extend(['--dpms-excluded', name])
            # Avoid sending a command across a mode switch or cable change.
            _, fresh_displays, fresh_session, reason = self.inspect()
            identity = lambda ds: [(d['path'], d['fingerprint']) for d in ds]
            if reason or fresh_session != session or identity(displays) != identity(fresh_displays):
                raise ControlError('The session or connected displays changed. Try again.')
            if session['mode'] == 'gaming' and night:
                self.remember({'session': session, 'fingerprint': self.fingerprint})
            self.run(self.command(session, *args, extra=extra))
            if session['mode'] == 'gaming' and not night:
                self.remember(None)
            for _ in range(15):
                state = self.status()
                if state['available'] and state['mode'] == session['mode'] and state['night_mode'] is night:
                    return state
                time.sleep(0.1)
            raise ControlError('The screen did not confirm the requested power state. Refresh and try again.')


def socket_path():
    return Path(os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')) / 'sm-manager' / 'faceplate.sock'


def request(action='status'):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(30)
            client.connect(str(socket_path()))
            client.sendall((action + '\n').encode())
            with client.makefile('rb') as stream:
                return json.loads(stream.readline(8192))
    except (OSError, ValueError):
        return {'available': False, 'night_mode': None, 'mode': None,
                'error': 'Display control is unavailable. Start sm-manager-faceplate.service.'}


def serve(config):
    path = socket_path()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    controller = Faceplate(config, state_path=path.parent / 'forced-sleep.json')

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            self.request.settimeout(2)
            try:
                action = self.rfile.readline(32).decode().strip()
                result = controller.status() if action == 'status' else controller.apply(action)
            except (ControlError, OSError, ValueError, KeyError) as error:
                result = {**controller.status(), 'error': str(error), 'available': False}
            self.wfile.write(json.dumps(result).encode() + b'\n')

    class Server(socketserver.UnixStreamServer):
        next_guard = 0

        def service_actions(self):
            if time.monotonic() < self.next_guard:
                return
            self.next_guard = time.monotonic() + 2
            try:
                controller.guard()
            except (ControlError, OSError, ValueError):
                logging.debug('Cannot check display topology during session transition', exc_info=True)

    with Server(str(path), Handler) as server:
        path.chmod(0o600)
        try:
            server.serve_forever()
        finally:
            path.unlink(missing_ok=True)
