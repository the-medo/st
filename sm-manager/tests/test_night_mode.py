import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch, Mock
from http.server import ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from sm_manager.night_mode import Faceplate, ControlError, run
from sm_manager.server import handler_for
from sm_manager import __main__ as cli


class PowerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.mode = 'gamescope'
        self.socket_name = 'gamescope-7'
        self.commands = []
        self.connector('card0-HDMI-A-1', b'faceplate')
        self.f = Faceplate({'faceplate_edid_sha256': hashlib.sha256(b'faceplate').hexdigest()}, self.root, self.command)

    def connector(self, name, edid):
        d = self.root / name
        d.mkdir()
        for filename, value in [('status', b'connected'), ('edid', edid), ('dpms', b'On')]:
            (d / filename).write_bytes(value)
        return d

    def command(self, args):
        self.commands.append(args)
        if 'show-seat' in args:
            return 'c42\n'
        if 'show-session' in args:
            return f'User=9999\nType=wayland\nDesktop={self.mode}\nActive=yes\n'
        if 'show-environment' in args:
            return 'WAYLAND_DISPLAY=wayland-8\n'
        if 'cat' in args:
            return f'GAMESCOPE_WAYLAND_DISPLAY={self.socket_name}\n'
        if '--json' in args:
            return json.dumps({'outputs': [{'name': d.name.split('-', 1)[1], 'connected': True} for d in self.root.iterdir()]})
        if 'drm_sleep_external_screen' in args or '--dpms' in args:
            off = args[-1] == '1' if 'gamescopectl' in args else args[args.index('--dpms') + 1] == 'off'
            (self.root / 'card0-HDMI-A-1/dpms').write_text('Off' if off else 'On')
        return ''

    def writes(self):
        return [args for args in self.commands if 'drm_sleep_external_screen' in args or '--dpms' in args]

    def test_gaming_on_off_toggle_and_fresh_session_environment(self):
        self.assertTrue(self.f.apply('on')['night_mode'])
        self.assertFalse(self.f.apply('off')['night_mode'])
        self.socket_name = 'gamescope-9'
        self.assertTrue(self.f.apply('toggle')['night_mode'])
        self.assertIn('GAMESCOPE_WAYLAND_DISPLAY=gamescope-9', self.writes()[-1])
        self.assertIn('#9999', self.writes()[-1])

    def test_desktop_after_mode_switch_excludes_tv_without_disabling_outputs(self):
        self.f.apply('on')
        self.mode = 'KDE'
        tv = self.connector('card0-DP-1', b'tv')
        self.assertFalse(self.f.apply('off')['night_mode'])
        command = self.writes()[-1]
        self.assertEqual(command[-4:], ['--dpms', 'on', '--dpms-excluded', 'DP-1'])
        self.assertIn('WAYLAND_DISPLAY=wayland-8', command)
        self.assertEqual((tv / 'dpms').read_text(), 'On')

    def test_no_action_when_gaming_could_blank_tv(self):
        self.connector('card0-DP-1', b'tv')
        self.assertIn('independently', self.f.status()['error'])
        with self.assertRaises(ControlError):
            self.f.apply('on')
        self.assertFalse(self.writes())

    def test_disconnected_replaced_or_duplicate_faceplate_never_controls_tv(self):
        (self.root / 'card0-HDMI-A-1/edid').write_bytes(b'tv')
        self.assertFalse(self.f.status()['available'])
        with self.assertRaises(ControlError):
            self.f.apply('off')
        (self.root / 'card0-HDMI-A-1/edid').write_bytes(b'faceplate')
        self.connector('card1-HDMI-A-1', b'faceplate')
        with self.assertRaises(ControlError):
            self.f.apply('on')
        self.assertFalse(self.writes())

    def test_unknown_state_unpaired_invalid_command_and_missing_socket_fail_closed(self):
        for action in ['reboot', 'on; reboot']:
            with self.assertRaises(ControlError):
                self.f.apply(action)
        (self.root / 'card0-HDMI-A-1/dpms').write_text('Unknown')
        with self.assertRaises(ControlError):
            self.f.apply('toggle')
        self.f.fingerprint = ''
        self.assertFalse(self.f.status()['available'])
        self.assertFalse(self.writes())

    def test_multiple_gpus_with_same_connector_names_are_ambiguous(self):
        self.mode = 'KDE'
        self.connector('card1-HDMI-A-1', b'tv')
        with self.assertRaisesRegex(ControlError, 'ambiguous connector'):
            self.f.apply('on')
        self.assertFalse(self.writes())

    def test_changed_topology_between_inspection_and_command_aborts(self):
        original = self.f.environment
        def environment(session):
            result = original(session)
            self.connector('card0-DP-1', b'tv')
            return result
        self.f.environment = environment
        with self.assertRaises(ControlError):
            self.f.apply('on')
        self.assertFalse(self.writes())

    def test_command_success_without_power_change_is_not_success(self):
        self.f.run = lambda args: '' if 'drm_sleep_external_screen' in args else self.command(args)
        with patch('sm_manager.night_mode.time.sleep'), self.assertRaisesRegex(ControlError, 'did not confirm'):
            self.f.apply('on')

    def test_no_active_session_and_unsupported_session_are_unavailable(self):
        self.f.run = lambda args: ''
        self.assertFalse(self.f.status()['available'])
        self.f.run = self.command
        self.mode = 'unknown'
        self.assertFalse(self.f.status()['available'])

    def test_tv_hotplug_releases_owned_sleep_flag_even_after_helper_restart(self):
        self.f.state_path = self.root / 'owned-sleep.json'
        self.f.apply('on')
        replacement = Faceplate({'faceplate_edid_sha256': self.f.fingerprint}, self.root, self.command, self.f.state_path)
        replacement.guard()
        self.assertTrue(replacement.forced_sleep)
        self.connector('card0-DP-1', b'tv')
        replacement.guard()
        self.assertEqual(self.writes()[-1][-2:], ['drm_sleep_external_screen', '0'])
        self.assertIsNone(replacement.forced_sleep)
        self.assertIsNone(json.loads(self.f.state_path.read_text()))

    def test_subprocess_is_bounded_and_never_uses_shell(self):
        with patch('sm_manager.night_mode.subprocess.run', side_effect=subprocess.TimeoutExpired('test', 4)) as proc:
            with self.assertRaisesRegex(ControlError, 'timed out'):
                run(['test'])
        self.assertEqual(proc.call_args.kwargs['timeout'], 4)
        self.assertNotIn('shell', proc.call_args.kwargs)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.control = Mock(return_value={'available': True, 'night_mode': True, 'mode': 'gaming', 'error': None})
        self.config = {'port': 8790, 'allowed_hosts': ['127.0.0.1']}
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(None, self.config, night_control=self.control))
        self.config['port'] = self.server.server_port
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)
        with urlopen(self.base + '/api/night-mode') as response:
            self.token = json.load(response)['token']
        self.control.reset_mock()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def post(self, body=b'{"action":"on"}', **headers):
        return urlopen(Request(self.base + '/api/night-mode', body, headers={
            'Content-Type': 'application/json', 'X-SM-Token': self.token, **headers}))

    def test_explicit_action_goes_through_shared_controller(self):
        with self.post() as response:
            self.assertTrue(json.load(response)['night_mode'])
        self.control.assert_called_once_with('on')

    def test_cross_origin_rebinding_missing_token_and_invalid_body_never_act(self):
        for headers in [{'Origin': 'https://evil.invalid'}, {'Host': 'evil.invalid'},
                        {'Sec-Fetch-Site': 'cross-site'}, {'X-SM-Token': ''},
                        {'Content-Type': 'text/plain'}]:
            with self.assertRaises(HTTPError) as error:
                self.post(**headers)
            error.exception.close()
        for body in [b'{}', b'[]', b'{"action":"reboot"}', b'{"action":[]}', b'{"action":"on","command":"x"}', b'x' * 129]:
            with self.assertRaises(HTTPError) as error:
                self.post(body)
            error.exception.close()
        self.control.assert_not_called()

    def test_control_error_does_not_claim_success(self):
        self.control.return_value = {'available': False, 'error': 'Display changed'}
        with self.assertRaises(HTTPError) as error:
            self.post()
        self.assertEqual(error.exception.code, 409)
        error.exception.close()

    def test_cli_uses_same_api_and_hides_token(self):
        stdout = io.StringIO()
        with patch.object(cli, 'load_config', return_value=self.config), patch('sys.argv', ['sm', 'night', 'toggle', '--json']), patch('sys.stdout', stdout):
            cli.main()
        self.assertTrue(json.loads(stdout.getvalue())['night_mode'])
        self.assertNotIn('token', stdout.getvalue())
        self.control.assert_any_call('toggle')

    def test_cli_error_exits_nonzero_with_useful_reason(self):
        self.control.return_value = {'available': False, 'error': 'TV connected'}
        stderr = io.StringIO()
        with patch.object(cli, 'load_config', return_value=self.config), patch('sys.argv', ['sm', 'night', 'on']), patch('sys.stderr', stderr), self.assertRaises(SystemExit) as error:
            cli.main()
        self.assertEqual(error.exception.code, 1)
        self.assertIn('TV connected', stderr.getvalue())
