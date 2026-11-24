#!/usr/bin/env python3
"""Enable packaged Ovis in this checkout's existing private v2 preview."""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import importlib.util

spec = importlib.util.spec_from_file_location('preview', Path(__file__).with_name('preview-v2.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def unit(name, command, env_file=None, environment=None):
    env = ''.join('Environment=' + p.unit_quote(f'{key}={value}') + '\n' for key, value in (environment or {}).items())
    if env_file:
        # EnvironmentFile wins over Environment= in systemd. Command arguments
        # deliberately apply the preview overrides after the private file.
        command = ['/usr/bin/env', *[f'{key}={value}' for key, value in (environment or {}).items()], *command]
        env = 'EnvironmentFile=' + str(env_file).replace('%', '%%').replace(' ', r'\x20') + '\n'
    return f'''{p.MARKER}
[Unit]
Description=ST v2 {name} ({p.KEY})
After=network.target
[Service]
WorkingDirectory={str(p.ROOT).replace('%', '%%')}
ExecStart={' '.join(p.unit_quote(arg) for arg in command)}
{env}Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=yes
[Install]
WantedBy=default.target
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, required=True, help='Private existing Ovis service environment')
    parser.add_argument('--bun', type=Path, default=shutil.which('bun'))
    args = parser.parse_args()
    if not args.env_file.is_file() or not args.bun or not args.bun.is_file():
        parser.error('An existing private Ovis environment file and Bun executable are required')
    os.umask(0o077)
    saved = p.BASE / 'profile.json'
    profile = json.loads(saved.read_text())
    if profile['source'] != str(p.ROOT) or p.MARKER not in p.UNIT.read_text():
        parser.error('Preview ownership changed')
    if profile.get('ovis'):
        parser.error('Ovis is already configured; use preview-v2.py restart')
    port = profile['port']
    ports = [port + 1, port + 2]
    if ports[-1] > 65535:
        parser.error('Not enough ports after the preview port')
    for internal in ports:
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(('127.0.0.1', internal))
            probe.listen(1)
    tailscale = shutil.which('tailscale')
    if not tailscale:
        parser.error('Add tailscale to PATH')
    serve = json.loads(p.run(tailscale, 'serve', 'status', '--json'))
    expected = {'Handlers': {'/': {'Proxy': profile['target']}}}
    if serve.get('Web', {}).get(profile['host']) != expected:
        parser.error('Preview Serve route changed ownership')
    status = json.loads(p.run(tailscale, 'status', '--json'))
    user = status.get('User', {}).get(str(status['Self']['UserID']), {})
    login = user.get('LoginName')
    if not login:
        parser.error('Could not identify this Tailscale owner')
    monitor_name = p.NAME.replace('.service', '-monitor.service')
    ovis_name = p.NAME.replace('.service', '-ovis.service')
    monitor_unit, ovis_unit = p.UNIT.with_name(monitor_name), p.UNIT.with_name(ovis_name)
    for path in [monitor_unit, ovis_unit]:
        if path.exists() and p.MARKER not in path.read_text():
            parser.error('Service name already belongs to another checkout')
    config_path = p.BASE / 'monitor.json'
    old_unit, old_config, old_profile = p.UNIT.read_text(), config_path.read_text(), saved.read_text()
    config = json.loads(old_config)
    config.update(port=ports[0], ovis_enabled=True)
    config['allowed_hosts'] = list(dict.fromkeys([*config['allowed_hosts'], profile['host'], f'127.0.0.1:{port}', f'localhost:{port}']))
    # This entry explicitly has no self updater. Existing private catalog, lock,
    # managed Codex socket and Herdr sessions are shared through the environment.
    # Ovis preferences/device state and monitor samples belong to this preview.
    p.write(monitor_unit, unit('monitor', [sys.executable, '-m', 'sm_manager', '--config', config_path, 'serve'], environment={'PATH': os.environ['PATH']}))
    p.write(ovis_unit, unit('Ovis', [args.bun, p.ROOT / 'services/ovis/index.ts'], args.env_file.resolve(), {
        'HOST':'127.0.0.1', 'PORT':ports[1], 'OVIS_STATE_DIR':p.DATA / 'ovis',
        'OVIS_TELEMETRY':'off', 'OVIS_AUTO_UPDATE':'0', 'OVIS_TAILSCALE_SERVE_ONLY':'1',
        'ST_OVIS_BASE_PATH':'/ovis', 'ST_OVIS_COOKIE_PREFIX':'st_ovis_' + p.KEY,
        'MEDO_PROJECTS':'1',
    }))
    p.write(config_path, json.dumps(config, indent=2) + '\n')
    p.write(p.BASE / 'gateway.json', json.dumps({'port':port,'publicOrigin':profile['url'],
        'monitorOrigin':f'http://127.0.0.1:{ports[0]}','ovisOrigin':f'http://127.0.0.1:{ports[1]}','ownerLogin':login}) + '\n')
    try:
        p.run('systemctl','--user','daemon-reload')
        p.run('systemctl','--user','enable','--now',monitor_name,ovis_name)
        p.wait(ports[0])
        # Only check bridge availability, never open a user's conversation as QA.
        wait_ovis(ports[1])
        p.write(p.UNIT, unit('gateway',[args.bun,p.ROOT / 'services/web-gateway/index.ts',p.BASE / 'gateway.json']))
        p.run('systemctl','--user','daemon-reload')
        p.run('systemctl','--user','restart',p.NAME)
        p.wait(port)
        profile.update(ovis=True, units=[monitor_name,ovis_name,p.NAME], monitor_port=ports[0], ovis_port=ports[1])
        p.write(saved,json.dumps(profile)+'\n')
    except BaseException:
        p.write(p.UNIT,old_unit)
        p.write(config_path,old_config)
        p.write(saved,old_profile)
        subprocess.run(['systemctl','--user','disable','--now',monitor_name,ovis_name],check=False)
        p.run('systemctl','--user','daemon-reload')
        p.run('systemctl','--user','restart',p.NAME)
        raise
    print(profile['url'] + '/ovis')


def wait_ovis(port):
    import http.client
    deadline=time.monotonic()+30
    while time.monotonic()<deadline:
        conn=http.client.HTTPConnection('127.0.0.1',port,timeout=2)
        try:
            conn.request('GET','/api/health?scope=bridge')
            response=conn.getresponse()
            if response.status==200 and isinstance(json.loads(response.read()),dict):
                return
        except (OSError,ValueError):
            pass
        finally:
            conn.close()
        time.sleep(.3)
    raise RuntimeError('Ovis did not become ready; inspect its preview service log')


if __name__=='__main__':
    main()
