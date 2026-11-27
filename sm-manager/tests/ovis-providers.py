"""Real Herdr launch/resume check with fake CLIs and an isolated home/socket/store."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HC = os.environ.get('ST_OVIS_HC_BIN')
if not HC:
    raise SystemExit('Set ST_OVIS_HC_BIN to the installed hc executable.')
CACHE = Path.home() / '.cache/st-provider-tests'
CACHE.mkdir(parents=True, exist_ok=True)

FAKE = r'''#!/usr/bin/python3
import ctypes,json,os,sys
from pathlib import Path
ctypes.CDLL(None).prctl(15,b'claude',0,0,0)
store=Path(os.environ['CLAUDE_CONFIG_DIR'])
store.joinpath('sessions').mkdir(parents=True,exist_ok=True)
pid=os.getpid()
birth=Path('/proc/'+str(pid)+'/stat').read_text().rsplit(') ',1)[1].split()[19]
flag='--resume' if '--resume' in sys.argv else '--session-id'
session=sys.argv[sys.argv.index(flag)+1]
def record():
    store.joinpath('sessions',str(pid)+'.json').write_text(json.dumps(dict(pid=pid,kind='interactive',procStart=birth,sessionId=session)))
def message(text):
    path=store/'projects'/'fixture'/(session+'.jsonl')
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('a') as f: f.write(json.dumps(dict(type='user',sessionId=session,cwd=os.getcwd(),message=dict(content=text)))+'\n')
record()
Path(os.environ['FIXTURE_ARGS']).write_text(json.dumps(sys.argv[1:]))
print('provider-fixture-ready',flush=True)
for line in sys.stdin:
    line=line.strip()
    if line.startswith('switch:'):
        session=line[7:];record();message('A separate task')
        print('provider-fixture-switched',flush=True)
    else:
        message(line)
        print('provider-fixture-received',flush=True)
'''

with tempfile.TemporaryDirectory(prefix='run-', dir=CACHE) as directory:
    fixture = Path(directory)
    for name in ('run', 'codex', 'sidebar', 'project', 'bin'):
        (fixture / name).mkdir()
    fake = fixture / 'bin/claude'
    fake.write_text(FAKE)
    fake.chmod(0o700)
    env = {**os.environ, 'HOME': directory, 'XDG_RUNTIME_DIR': str(fixture/'run'),
           'XDG_CONFIG_HOME': str(fixture/'config'), 'XDG_STATE_HOME': str(fixture/'state'),
           'HC_SESSION': 'st-provider-fixture', 'HC_SOCKET': str(fixture/'core.sock'),
           'CODEX_HOME': str(fixture/'codex'), 'CLAUDE_CONFIG_DIR': str(fixture/'claude'),
           'ST_OVIS_SIDEBAR_DATA': str(fixture/'sidebar'), 'OVIS_STATE_DIR': str(fixture/'ovis'),
           'ST_OVIS_CLAUDE_BIN': str(fake), 'ST_OVIS_HC_BIN': HC, 'FIXTURE_ARGS': str(fixture/'args.json')}
    for key in ('HERDR_SOCKET', 'OVIS_HC_ENV', 'OVIS_HC_MACHINE', 'OVIS_HC_MACHINE_ID', 'OVIS_TOKEN', 'OVIS_TAILSCALE_OWNER', 'HC_PARENT', 'HC_TERMINAL'):
        env.pop(key, None)
    project = {'id': 'fixture', 'name': 'Fixture', 'path': str(fixture/'project')}
    (fixture/'sidebar/projects.json').write_text(json.dumps({'projects': [project], 'coreId': 'fixture'}))
    with sqlite3.connect(fixture/'codex/state_5.sqlite') as db:
        db.execute('CREATE TABLE threads(id TEXT, updated_at INTEGER)')
    def hc(*args):
        result = subprocess.run([HC, *args], env=env, capture_output=True, text=True, timeout=20)
        if result.returncode: raise AssertionError(result.stderr)
        return json.loads(result.stdout or '{}')
    panes = []
    try:
        with patch.dict(os.environ, env, clear=True):
            spec = importlib.util.spec_from_file_location('provider_fixture_bridge', ROOT/'integrations/ovis/app/server/medo-bridge.py')
            bridge = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(bridge)
            first = bridge.handle({'operation': 'new', 'projectId': 'fixture', 'provider': 'claude', 'model': 'opus', 'effort': 'high'})
            panes.append(first['address'])
            hc('wait', first['address'], '--output', 'provider-fixture-ready', '--timeout', '5', '--json')
            args = json.loads((fixture/'args.json').read_text())
            assert args[-4:] == ['--model', 'opus', '--effort', 'high'], args
            session = args[args.index('--session-id')+1]
            hc('send', first['address'], 'Inspect the fixture release', '--json')
            hc('wait', first['address'], '--output', 'provider-fixture-received', '--timeout', '5', '--json')
            catalog = bridge.handle({'operation': 'index'})
            row = next(c for c in catalog['chats'] if c['id'] == 'claude:'+session)
            assert row['provider'] == 'claude' and row['paneId'] == first['address'], row
            assert row['title'] == 'Inspect the fixture release', row
            reopened = bridge.handle({'operation': 'open', 'threadId': row['id']})
            assert reopened == {'address': first['address'], 'reused': True}, reopened
            # /clear or /resume changes the native PID record: the old launch label must not follow it.
            second = '00000000-0000-4000-8000-000000000002'
            hc('send', first['address'], 'switch:'+second, '--json')
            hc('wait', first['address'], '--output', 'provider-fixture-switched', '--timeout', '5', '--json')
            rows = {c['id']: c for c in bridge.handle({'operation': 'index'})['chats']}
            assert 'paneId' not in rows['claude:'+session], rows
            assert rows['claude:'+second]['paneId'] == first['address'], rows
            resumed = bridge.handle({'operation': 'open', 'threadId': 'claude:'+session})
            panes.append(resumed['address'])
            assert resumed['address'] != first['address'] and not resumed['reused'], resumed
            hc('wait', resumed['address'], '--output', 'provider-fixture-ready', '--timeout', '5', '--json')
            assert json.loads((fixture/'args.json').read_text()) == ['--resume', session]
            saved = bridge.handle({'operation': 'claude-history', 'threadId': 'claude:'+session})
            assert Path(saved['path']).is_relative_to(fixture/'claude')
        print('Isolated Herdr provider check passed: Claude arguments, native identity, sidebar, reuse, session switch and resume.')
    finally:
        for pane in panes:
            try: hc('kill', pane, '--json')
            except Exception: pass
        hc('server', 'stop')
