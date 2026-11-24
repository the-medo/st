"""Production v2 units and reversible activation; private ingress and external agents stay owned elsewhere."""
import json
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time
from urllib.parse import urlsplit

from scripts import manage, updater

MONITOR = 'sm-manager-monitor.service'
OVIS = 'sm-manager-ovis.service'
PREPARE = 'sm-manager-prepare.service'
CHILDREN = (MONITOR, OVIS, PREPARE)
OWNER = 'ST v2 production v1'


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(value)
    temporary.chmod(0o600)
    temporary.replace(path)


def paths(config):
    base = manage.config_path().parent / 'v2'
    return base, base / 'monitor.json', base / 'gateway.json', base / 'ovis.env'


def unit_path(path):
    # EnvironmentFile is one absolute path, not an ExecStart-style quoted word.
    value = str(path)
    if not Path(value).is_absolute() or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError('Systemd environment files require an absolute path without control characters')
    return value.replace('%', '%%')


def render_units(config, runtime, service_path):
    settings = config['v2']
    base, monitor_path, gateway_path, environment = paths(config)
    marker = base / 'owner'
    if base.exists() and (not marker.is_file() or marker.read_text() != OWNER):
        raise RuntimeError('The v2 configuration directory belongs to another installation')
    write(marker, OWNER)
    previous = json.loads(gateway_path.read_text()) if gateway_path.exists() else {}
    token = previous.get('ovisToken') or secrets.token_urlsafe(48)
    gateway = {'port': config['port'], 'publicOrigin': config['public_url'],
               'monitorOrigin': f"http://127.0.0.1:{settings['monitor_port']}",
               'ovisOrigin': f"http://127.0.0.1:{settings['ovis_port']}",
               'ownerLogin': settings['owner_login'], 'ovisToken': token}
    identity_origin = settings['identity_origin']
    if identity_origin != config['public_url']:
        gateway['ownerAuth'] = {'origin': identity_origin,
            'sessionSecret': previous.get('ownerAuth', {}).get('sessionSecret') or secrets.token_urlsafe(48)}
    monitor = {**config, 'port': settings['monitor_port'], 'frontend': 'react', 'ovis_enabled': True}
    monitor.pop('v2', None)
    monitor.pop('deployment_dir', None)
    monitor['allowed_hosts'] = list(dict.fromkeys([*config['allowed_hosts'],
        urlsplit(config['public_url']).netloc, urlsplit(identity_origin).netloc,
        f"127.0.0.1:{config['port']}", f"localhost:{config['port']}"]))
    write(monitor_path, json.dumps(monitor, indent=2) + '\n')
    write(gateway_path, json.dumps(gateway, indent=2) + '\n')
    overrides = {'HOST': '127.0.0.1', 'PORT': settings['ovis_port'], 'OVIS_STATE_DIR': settings['state_dir'],
                 'OVIS_TOKEN': token, 'OVIS_TELEMETRY': 'off', 'OVIS_AUTO_UPDATE': '0',
                 'OVIS_TAILSCALE_SERVE_ONLY': '1', 'ST_OVIS_BASE_PATH': '/ovis',
                 'ST_OVIS_COOKIE_PREFIX': 'st_ovis_production', 'MEDO_PROJECTS': '1'}
    write(environment, '\n'.join(f'{key}={manage.unit_quote(value)}' for key, value in overrides.items()) + '\n')
    def unit(description, command, relation='', extra='', kind='simple'):
        return f'''{manage.MARKER}
[Unit]
Description={description}
{relation}
[Service]
Type={kind}
WorkingDirectory={str(runtime).replace('%', '%%')}
ExecStart={' '.join(manage.unit_quote(value) for value in command)}
Environment={manage.unit_quote('PATH=' + service_path)}
{extra}UMask=0077
NoNewPrivileges=true
TimeoutStartSec=15min
TimeoutStopSec=10
'''
    bun = settings['bun']
    main = unit('ST gateway', [bun, runtime / 'services/web-gateway/index.ts', gateway_path],
        f'Wants={manage.FACEPLATE_SERVICE} {MONITOR} {OVIS} {PREPARE}\nAfter={PREPARE} {MONITOR} {OVIS}',
        'Restart=on-failure\nRestartSec=5\n') + '\n[Install]\nWantedBy=default.target\n'
    child_relation = f'PartOf={manage.SERVICE}\nAfter={PREPARE}\nBefore={manage.SERVICE}'
    monitor_unit = unit('ST resource monitor', [sys.executable, '-m', 'sm_manager', '--config', monitor_path, 'serve'],
                        child_relation, 'Restart=on-failure\nRestartSec=3\n')
    ovis_unit = unit('ST Agents web bridge', [bun, runtime / 'services/ovis/index.ts'], child_relation,
        f'EnvironmentFile={unit_path(settings["env_file"])}\nEnvironmentFile={unit_path(environment)}\nRestart=on-failure\nRestartSec=3\n')
    prepare = unit('Prepare the installed ST release', [sys.executable, Path(config['deployment_dir']) / 'updater.py', 'prepare'],
                   f'Before={MONITOR} {OVIS} {manage.SERVICE}', kind='oneshot')
    return {manage.SERVICE: main, MONITOR: monitor_unit, OVIS: ovis_unit, PREPARE: prepare}


def backup(config):
    base, *private = paths(config)
    directory = Path(config['data_dir']) / 'v2-backups' / (time.strftime('%Y%m%d-%H%M%S') + '-' + secrets.token_hex(3))
    directory.mkdir(parents=True, mode=0o700)
    files = [manage.config_path(), manage.CLI, *[manage.UNIT.with_name(name) for name in
        (manage.SERVICE, manage.FACEPLATE_SERVICE, manage.UPDATE_SERVICE, manage.UPDATE_TIMER, *CHILDREN)],
        base / 'owner', base / 'rollback', *private, Path(config['deployment_dir']) / 'updater.py']
    entries = []
    for index, path in enumerate(files):
        exists = path.is_file()
        if exists:
            shutil.copy2(path, directory / str(index))
            (directory / str(index)).chmod(0o600)
        entries.append({'path': str(path), 'exists': exists, 'mode': path.stat().st_mode & 0o777 if exists else None})
    write(directory / 'manifest.json', json.dumps({'owner': OWNER, 'files': entries}) + '\n')
    return directory


def restore(directory):
    manifest = json.loads((directory / 'manifest.json').read_text())
    if manifest['owner'] != OWNER:
        raise RuntimeError('Unrecognized production backup')
    for index, item in enumerate(manifest['files']):
        path = Path(item['path'])
        if item['exists']:
            write(path, (directory / str(index)).read_text())
            path.chmod(item['mode'])
        else:
            path.unlink(missing_ok=True)
    # A failed first activation must be retryable without adopting an unowned directory.
    base = manage.config_path().parent / 'v2'
    if base.is_dir() and not any(base.iterdir()):
        base.rmdir()


def activate(config):
    saved = backup(config)
    try:
        manage.save(config)
        manage.install(False, auto_update=True)
        if not updater.Deployment(config['deployment_dir']).healthy(timeout=60):
            raise RuntimeError('ST v2 did not become healthy')
    except BaseException:
        # Only the web stack is owned here; shared Herdr/Codex/DAVe services are never stopped.
        manage.run(['systemctl', '--user', 'stop', manage.SERVICE, *CHILDREN], check=False)
        restore(saved)
        manage.run(['systemctl', '--user', 'daemon-reload'])
        manage.run(['systemctl', '--user', 'start', manage.SERVICE], timeout=900)
        raise
    return saved


def install(args):
    manage.check_units()
    config = manage.load_config()
    if not config.get('deployment_dir'):
        raise RuntimeError('Install the independent runtime with install --auto-update first')
    deployment = updater.Deployment(config['deployment_dir'])
    deployment.check_checkout()
    runtime = deployment.checkout / 'sm-manager'
    if not (runtime / 'services/web-gateway/index.ts').is_file() or not (runtime / 'sm_manager/web/release.json').is_file():
        raise RuntimeError('Update the runtime to the built ST v2 release before activation')
    bun = Path(args.bun or shutil.which('bun') or '').resolve()
    environment = args.ovis_env_file.resolve() if args.ovis_env_file else None
    if not bun.is_file() or not environment or not environment.is_file():
        raise RuntimeError('Supply --bun and --ovis-env-file for the existing private Herdr configuration')
    expected = json.loads((runtime / 'package.json').read_text())['packageManager'].split('@')[1]
    if subprocess.check_output([str(bun), '--version'], text=True).strip() != expected:
        raise RuntimeError(f'This release requires Bun {expected}')
    ports = [args.monitor_port or int(config['port']) + 1, args.ovis_port or int(config['port']) + 2]
    if len(set([*ports, int(config['port'])])) != 3 or any(not 1024 <= port <= 65535 for port in ports):
        raise RuntimeError('Choose two distinct unprivileged internal ports')
    previous = config.get('v2', {})
    for name, port, field in zip((MONITOR, OVIS), ports, ('monitor_port', 'ovis_port')):
        active = manage.run(['systemctl', '--user', 'is-active', '--quiet', name], check=False).returncode == 0
        if active and previous.get(field) != port:
            raise RuntimeError(f'An existing {name} uses a different port')
        if not active:
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', port))
    route = config.get('serve_mapping')
    if not route or manage.serve_state().get('Web', {}).get(route['host']) != {'Handlers': {'/': {'Proxy': route['target']}}}:
        raise RuntimeError('The existing private Tailscale identity route must still belong to ST')
    status = json.loads(manage.run([manage.tailscale(), 'status', '--json'], capture=True).stdout)
    owner = status.get('User', {}).get(str(status['Self']['UserID']), {}).get('LoginName')
    if not owner:
        raise RuntimeError('Cannot establish the Tailscale owner')
    state = Path(config['data_dir']) / 'v2' / 'ovis'
    if not state.exists():
        state.mkdir(parents=True, mode=0o700)
        if args.state_source:
            # Persisted JSON/preferences only; never copy runtime sockets, locks or request logs.
            for source in args.state_source.resolve().glob('*.json'):
                if source.is_symlink():
                    continue
                value = json.loads(source.read_text())
                write(state / source.name, json.dumps(value) + '\n')
    config.update(frontend='react', ovis_enabled=True, v2={
        'bun': str(bun), 'env_file': str(environment), 'monitor_port': ports[0], 'ovis_port': ports[1],
        'state_dir': str(state), 'owner_login': owner, 'identity_origin': 'https://' + route['host'],
    })
    saved = activate(config)
    write(manage.config_path().parent / 'v2' / 'rollback', str(saved))
    print(f"ST v2 ready: {config['public_url']}\nRollback configuration: {saved}")


def rollback():
    config = manage.load_config()
    base, *_ = paths(config)
    saved = Path((base / 'rollback').read_text())
    manage.check_units()
    manage.run(['systemctl', '--user', 'stop', manage.SERVICE, *CHILDREN], check=False)
    restore(saved)
    manage.run(['systemctl', '--user', 'daemon-reload'])
    manage.run(['systemctl', '--user', 'start', manage.SERVICE], timeout=900)
    print('Restored the previous web configuration. History and chat data were retained.')
