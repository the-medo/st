#!/usr/bin/env python3
"""Own a private, persistent React console preview for this checkout."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from sm_manager.config import load_config
from scripts.manage import unit_quote

KEY = hashlib.sha256(str(ROOT).encode()).hexdigest()[:10]
NAME = f'st-v2-{KEY}.service'
BASE = Path.home() / '.config/st-v2-preview' / KEY
DATA = Path.home() / '.local/share/st-v2-preview' / KEY
UNIT = Path.home() / '.config/systemd/user' / NAME
MARKER = '# Managed by ST preview-v2.py: ' + str(ROOT)


def run(*args):
    return subprocess.check_output(args, text=True)


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(text)
    path.chmod(0o600)


def wait(port, path='/api/ui-config'):
    until = time.monotonic() + 30
    while time.monotonic() < until:
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
        try:
            connection.request('GET', path)
            response = connection.getresponse()
            if response.status == 200:
                return
        except OSError:
            pass
        finally:
            connection.close()
        time.sleep(.3)
    raise SystemExit('Preview did not become ready; inspect its user service log.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'stop', 'status', 'restart'])
    parser.add_argument('--port', type=int, default=18790)
    parser.add_argument('--config', type=Path, help='Existing private access profile; read only')
    args = parser.parse_args()
    os.umask(0o077)
    saved = BASE / 'profile.json'
    profile = json.loads(saved.read_text()) if saved.exists() else None
    if profile and profile['source'] != str(ROOT):
        parser.error('Preview belongs to another checkout')
    if UNIT.exists() and MARKER not in UNIT.read_text():
        parser.error('The service name belongs to an unrelated unit')
    units = profile.get('units', [NAME]) if profile else [NAME]
    for name in units:
        owned = UNIT.with_name(name)
        if '/' in name or not owned.is_file() or MARKER not in owned.read_text():
            if profile:
                parser.error('Preview service ownership changed')
    if args.action == 'status':
        print(run('systemctl', '--user', 'status', *units, '--no-pager'))
        if profile:
            print(profile['url'])
        return
    if args.action in ('stop', 'restart') and not profile:
        parser.error('No preview configured')
    if args.action == 'restart':
        run('systemctl', '--user', 'restart', *units)
        wait(profile['port'])
        if profile.get('ovis'):
            wait(profile['ovis_port'], '/api/health?scope=bridge')
        print(profile['url'])
        return
    tailscale = shutil.which('tailscale')
    if not tailscale:
        parser.error('Add tailscale to PATH')
    serve = json.loads(run(tailscale, 'serve', 'status', '--json'))
    if args.action == 'stop':
        route = serve.get('Web', {}).get(profile['host'])
        expected = {'Handlers': {'/': {'Proxy': profile['target']}}}
        if route and route != expected:
            parser.error('Serve route has changed ownership')
        if route:
            run(tailscale, 'serve', f"--https={profile['port']}", 'off')
        run('systemctl', '--user', 'disable', '--now', *units)
        print('Preview stopped; data and profile retained.')
        return
    if not (ROOT / 'sm_manager/web/index.html').is_file():
        parser.error('Run bun run build first')
    if profile:
        route = serve.get('Web', {}).get(profile['host'])
        if route and route != {'Handlers': {'/': {'Proxy': profile['target']}}}:
            parser.error('Serve route has changed ownership')
        run('systemctl', '--user', 'enable', '--now', *units)
        run('systemctl', '--user', 'restart', *units)
        wait(profile['port'])
        run(tailscale, 'serve', '--bg', f"--https={profile['port']}", profile['target'])
        print(profile['url'])
        return
    if not 1024 <= args.port <= 65535:
        parser.error('Choose an unprivileged port')
    if str(args.port) in serve.get('TCP', {}):
        parser.error('Port already has a Serve owner')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', args.port))
    status = json.loads(run(tailscale, 'status', '--json'))
    dns = status['Self']['DNSName'].rstrip('.')
    host = f'{dns}:{args.port}'
    url = 'https://' + host
    target = f'http://127.0.0.1:{args.port}'
    config = load_config(args.config)
    for key in ('deployment_dir', 'serve_mapping', 'https_mapping'):
        config.pop(key, None)
    config.update(frontend='react', port=args.port, public_url=url,
                  allowed_hosts=['localhost', '127.0.0.1', dns], data_dir=str(DATA / 'monitor'))
    DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    write(BASE / 'monitor.json', json.dumps(config, indent=2) + '\n')
    write(UNIT, f'''{MARKER}
[Unit]
Description=ST v2 branch preview ({KEY})
After=network.target
[Service]
WorkingDirectory={str(ROOT).replace('%', '%%')}
ExecStart={unit_quote(sys.executable)} -m sm_manager --config {unit_quote(BASE / 'monitor.json')} serve
Environment={unit_quote('PATH=' + os.environ.get('PATH', '/usr/bin:/bin'))}
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=yes
[Install]
WantedBy=default.target
''')
    write(saved, json.dumps({'source': str(ROOT), 'host': host, 'port': args.port, 'target': target, 'url': url}) + '\n')
    run('systemctl', '--user', 'daemon-reload')
    run('systemctl', '--user', 'enable', '--now', NAME)
    wait(args.port)
    run(tailscale, 'serve', '--bg', f'--https={args.port}', target)
    print(url)


if __name__ == '__main__':
    main()
