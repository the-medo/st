"""Browser acceptance against real receipt storage and synthetic native history only."""
from contextlib import closing
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sm_manager.server import handler_for
from integrations.ovis.bridge import activity

apis = json.loads(sys.stdin.readline())
temporary = tempfile.TemporaryDirectory(prefix='completion-browser-')
home = Path(temporary.name)
root = home/'sidebar'
history = home/'thread_history_1.sqlite'
ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']
rows = [dict(id=thread, history_mode='paginated') for thread in ids]
metadata = {thread: dict(title=title, updated=1, status='idle') for thread, title in zip(ids, ['Fixture desk mount', 'Fixture camera setup'])}
history_ready = threading.Event()
history_ready.set()
receipt_failure = False
with closing(sqlite3.connect(history)) as db, db:
    db.execute('''CREATE TABLE thread_turns (thread_id, turn_id, rollout_ordinal, status, completed_at,
        PRIMARY KEY (thread_id, turn_id))''')
    for thread in ids:
        db.execute('INSERT INTO thread_turns VALUES (?, ?, 1, ?, 1)', (thread, 'old-'+thread, 'completed'))


def catalog():
    chats = [dict(id=thread, project='fixture', cwd='/fixture', archived=False, unavailable=None,
                  folder=None, **metadata[thread]) for thread in ids]
    activity.observe(root, home, rows, chats)
    return dict(projects=[dict(id='fixture', name='Fixture project', path='/fixture', folders=[])],
                chats=chats, organizationRevision=1)


config = dict(frontend='react', port=0, allowed_hosts=['127.0.0.1'])
Base = handler_for(None, config)


class Fixture(Base):
    def do_GET(self):
        from urllib.parse import urlsplit, parse_qs
        url = urlsplit(self.path)
        if url.path in apis:
            return self.respond(200, apis[url.path])
        if url.path == '/agents/api/medo/catalog':
            return self.respond(200, catalog())
        if url.path == '/agents/api/medo/conversation':
            if not history_ready.wait(20):
                return self.respond(503, {'error': 'Fixture history held'})
            thread = parse_qs(url.query)['pane_id'][0].removeprefix('medo:')
            with closing(sqlite3.connect(history)) as db:
                turn = db.execute('SELECT turn_id FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1', (thread,)).fetchone()[0]
            return self.respond(200, dict(source='codex-transcript', history_id='medo:'+thread,
                turns=[dict(role='user', ts='2026-01-01T00:00:00Z', turn_id=turn, parts=[dict(kind='text', text='Build the fixture.')]),
                       dict(role='assistant', ts='2026-01-01T00:00:00Z', end_ts='2026-01-01T00:01:00Z', turn_id=turn,
                            parts=[dict(kind='text', phase='final_answer', text='The synthetic fixture is complete. '+turn)])],
                version=turn, cursor=None, activity='idle', metadata={}, server_time='2026-01-01T00:01:00Z'))
        return super().do_GET()

    def do_POST(self):
        global receipt_failure
        body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))))
        if self.path == '/agents/api/medo/read-completion':
            if receipt_failure:
                return self.respond(503, {'error': 'Synthetic write failure'})
            return self.respond(200, activity.acknowledge(root, home, rows, body['threadId'], body['completionId']))
        if self.path == '/fixture':
            if 'hold' in body:
                history_ready.clear() if body['hold'] else history_ready.set()
            if 'receiptFailure' in body:
                receipt_failure = body['receiptFailure']
            thread = body.get('thread', ids[0])
            metadata[thread].update(body.get('metadata', {}))
            if 'turn' in body:
                with closing(sqlite3.connect(history)) as db, db:
                    db.execute('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?)',
                               (thread, body['turn'], body['ordinal'], 'completed', 2_000_000_000))
            return self.respond(200, catalog())
        return super().do_POST()


catalog()  # quiet historical baseline before any browser opens
server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
config['port'] = server.server_port
print(server.server_port, flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
    temporary.cleanup()
