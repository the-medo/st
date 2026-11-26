"""Bounded local transport to STapp; no browser-supplied device identity."""
import json
import os
from pathlib import Path
import socket
import time


def data_dir():
    return Path(os.environ.get('STAPP_DATA', Path.home() / '.local/share/stapp'))


def rpc(payload):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(5)
        connection.connect(os.environ.get('STAPP_SOCKET', str(data_dir() / 'control.sock')))
        connection.sendall((json.dumps({**payload, 'device': 'owner'}) + '\n').encode())
        with connection.makefile('rb') as stream:
            raw = stream.readline(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError('Assistant reply exceeds the display limit')
        result = json.loads(raw)
    if 'error' in result:
        raise ValueError(result['error'])
    return result['result']


def status():
    try:
        result = rpc({'op': 'assistant_status'})
    except (OSError, ValueError):
        return {'available': False, 'error': 'The assistant service is unavailable.', 'devices': [], 'requests': [], 'commands': []}
    try:
        with (data_dir() / 'router-health.json').open() as f:
            health = json.loads(f.read(4096))
        router = {key: health.get(key) for key in ('status', 'checked_at', 'provider', 'model')}
    except (OSError, ValueError, TypeError):
        router = {'status': 'unknown'}
    try:
        worker = json.loads((data_dir() / 'worker-health.json').read_text())
        worker_online = time.time() - worker['checked_at'] < 30
    except (OSError, ValueError, KeyError, TypeError):
        worker_online = False
    return {**result, 'available': True, 'router': router, 'worker_online': worker_online, 'now': time.time()}


def action(payload):
    operation = payload.get('action')
    if operation == 'settings':
        return rpc({'op': 'assistant_settings', 'target': payload.get('device'),
                    'settings': payload.get('settings'), 'revision': payload.get('revision')})
    if operation in ('stop', 'record', 'test_recording', 'test_speaker'):
        return rpc({'op': 'assistant_command', 'target': payload.get('device'),
                    'action': operation, 'id': payload.get('id')})
    raise ValueError('Unknown assistant action')
