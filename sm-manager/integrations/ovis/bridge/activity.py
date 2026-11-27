"""Shared conversation activity. Native history is read-only; receipts belong to ST.

Completion identities come from actual Codex turns, never thread updated_at,
terminal transitions, browser storage, or the lifetime of an Ovis process.
"""
from contextlib import closing
import os
import sqlite3
import time


def _connect(root):
    root.mkdir(parents=True, exist_ok=True)
    path = root / 'conversation-activity.sqlite3'
    # The catalogue is private even on machines with a permissive umask.
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    os.close(fd)
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        db.execute('BEGIN IMMEDIATE')
        version = db.execute('PRAGMA user_version').fetchone()[0]
        if version not in (0, 1):
            raise ValueError('Conversation activity was saved by a newer ST version.')
        if version == 0:
            db.execute('CREATE TABLE activity_meta (started_at INTEGER NOT NULL)')
            db.execute('INSERT INTO activity_meta VALUES (?)', (int(time.time()),))
            db.execute('''CREATE TABLE conversation_activity (
                thread_id TEXT PRIMARY KEY, completion_id TEXT, completion_ordinal INTEGER NOT NULL,
                read_ordinal INTEGER NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL)''')
            db.execute('PRAGMA user_version=1')
        return db
    except BaseException:
        db.close()
        raise


def _history(home, rows):
    """Indexed turn headers only; never load message bodies or resume a conversation."""
    wanted = [row['id'] for row in rows if row.get('history_mode') == 'paginated']
    if not wanted:
        return {}
    path = home / 'thread_history_1.sqlite'
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=4)) as db:
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        result = {}
        for thread in wanted:
            latest = db.execute('''SELECT turn_id, status FROM thread_turns
                WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1''', (thread,)).fetchone()
            completed = db.execute('''SELECT turn_id, rollout_ordinal, completed_at FROM thread_turns
                WHERE thread_id=? AND (status='completed' OR status='failed')
                ORDER BY rollout_ordinal DESC LIMIT 1''', (thread,)).fetchone()
            result[thread] = (latest, completed)
        return result


def _public(record):
    return dict(revision=record['revision'], completionId=record['completion_id'],
                unread=record['completion_ordinal'] > record['read_ordinal'], status=record['status'])


def _observe(db, chat, history, started, preserve_status=False):
    thread = chat['id']
    before = db.execute('SELECT * FROM conversation_activity WHERE thread_id=?', (thread,)).fetchone()
    latest, completed = history.get(thread, (None, None))
    # A catalogue without a terminal is idle. A receipt has no terminal snapshot,
    # so it preserves the last known live status until the next catalogue arrives.
    status = chat.get('status', before['status'] if before and preserve_status else 'idle')
    # A terminal can briefly report idle/done while a native turn is still running.
    # Its blocked report remains useful for approvals/questions during that turn.
    if latest:
        if latest['status'] == 'inProgress':
            status = 'blocked' if status == 'blocked' else 'working'
        elif status not in ('working', 'blocked', 'waiting'):
            status = 'idle'
    elif status == 'done':
        status = 'idle'
    completion = completed['turn_id'] if completed else None
    ordinal = completed['rollout_ordinal'] if completed else -1
    read = before['read_ordinal'] if before else -1
    if before is None and completed:
        # Existing history starts quietly, including history first discovered later.
        # A new turn finishing after installation is unread even if no browser was open.
        ended = completed['completed_at']
        if ended is None or ended <= started:
            read = ordinal
    # A temporarily incomplete index must not forget a completion or its receipt.
    if before and ordinal < before['completion_ordinal']:
        completion, ordinal = before['completion_id'], before['completion_ordinal']
    if status == 'idle' and ordinal > read:
        status = 'done'
    values = (completion, ordinal, read, status)
    old = tuple(before[key] for key in ('completion_id', 'completion_ordinal', 'read_ordinal', 'status')) if before else None
    if old != values:
        revision = before['revision'] + 1 if before else 1
        db.execute('''INSERT INTO conversation_activity VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET completion_id=excluded.completion_id,
            completion_ordinal=excluded.completion_ordinal, read_ordinal=excluded.read_ordinal,
            status=excluded.status, revision=excluded.revision''', (thread, *values, revision))
    return db.execute('SELECT * FROM conversation_activity WHERE thread_id=?', (thread,)).fetchone()


def observe(root, home, rows, chats):
    # Serialize native reads with receipts, so a slow older catalogue cannot resurrect
    # a read completion. Revisions let browsers reject responses delivered out of order.
    with closing(_connect(root)) as db, db:
        history = _history(home, rows)
        started = db.execute('SELECT started_at FROM activity_meta').fetchone()[0]
        for chat in chats:
            state = _public(_observe(db, chat, history, started))
            chat['activity'] = state
            chat['status'] = state['status']


def acknowledge(root, home, rows, thread, completion):
    if not isinstance(thread, str) or not isinstance(completion, str) or not completion or len(completion) > 300:
        raise ValueError('Choose the completed turn you read.')
    row = next((row for row in rows if row['id'] == thread), None)
    if row is None:
        raise ValueError('Conversation not found in the Steam Machine history.')
    with closing(_connect(root)) as db, db:
        history = _history(home, [row])
        started = db.execute('SELECT started_at FROM activity_meta').fetchone()[0]
        record = _observe(db, {'id': thread}, history, started, preserve_status=True)
        # A late/offline read of turn A never acknowledges turn B.
        if record['completion_id'] == completion and record['read_ordinal'] < record['completion_ordinal']:
            db.execute('''UPDATE conversation_activity SET read_ordinal=completion_ordinal,
                status=CASE WHEN status='done' THEN 'idle' ELSE status END,
                revision=revision+1 WHERE thread_id=?''', (thread,))
            record = db.execute('SELECT * FROM conversation_activity WHERE thread_id=?', (thread,)).fetchone()
        return dict(threadId=thread, activity=_public(record))
