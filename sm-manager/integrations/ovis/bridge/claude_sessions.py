"""S.T.'s Claude conversation identities; transcripts remain in Claude's own store."""
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid

SESSION = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)


def config_dir():
    return Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home() / '.claude').expanduser().resolve()


def load(root):
    try:
        value = json.loads((root / 'claude-conversations.json').read_text())
    except FileNotFoundError:
        return {}
    if not isinstance(value, dict) or value.get('version') != 1 or not isinstance(value.get('sessions'), dict):
        raise ValueError('The Claude conversation index could not be read.')
    return value['sessions']


def update(root, session, change):
    if not SESSION.fullmatch(session):
        raise ValueError('Choose a Claude conversation.')
    root.mkdir(parents=True, exist_ok=True)
    with (root / 'claude-conversations.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        sessions = load(root)
        sessions[session] = {**sessions.get(session, {}), **change}
        temporary = root / ('claude-conversations.' + uuid.uuid4().hex + '.tmp')
        try:
            with temporary.open('x') as output:
                temporary.chmod(0o600)
                json.dump({'version': 1, 'sessions': sessions}, output, ensure_ascii=False)
            temporary.replace(root / 'claude-conversations.json')
        finally:
            temporary.unlink(missing_ok=True)
        return sessions[session]


def small_json(path):
    """No symlink, FIFO or unbounded read for a process identity record."""
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        raw = os.read(fd, 16 * 1024 + 1)
        return json.loads(raw) if len(raw) <= 16 * 1024 else None
    finally:
        os.close(fd)


def process_session(pid, store, proc=Path('/proc')):
    # Match Ovis's claudeProcessSession: a reused PID cannot claim an old chat.
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    try:
        record = small_json(Path(store) / 'sessions' / f'{pid}.json')
        if not isinstance(record, dict) or record.get('pid') != pid or record.get('kind') != 'interactive':
            return None
        session = record.get('sessionId')
        birth = record.get('procStart')
        if not isinstance(session, str) or not SESSION.fullmatch(session) or not isinstance(birth, str) or not birth.isdigit():
            return None
        fields = (proc / str(pid) / 'stat').read_text().rsplit(') ', 1)[1].split()
        return session if fields[19] == birth else None
    except (OSError, ValueError, IndexError):
        return None


def terminal_session(terminal, store):
    foreground = terminal.get('foreground') or {}
    # The terminal's root is also checked: Claude may have a git child in front.
    for pid in dict.fromkeys([foreground.get('pid'), terminal.get('pid')]):
        session = process_session(pid, store)
        if session:
            return session
    return None


def project_slug(cwd):
    name = re.sub(r'[^a-zA-Z0-9]', '-', cwd)
    if len(name) <= 200:
        return name
    code = cwd.encode('utf-16-le')
    hashed = 0
    for i in range(0, len(code), 2):
        hashed = (31 * hashed + int.from_bytes(code[i:i+2], 'little')) & 0xffffffff
    hashed = abs(hashed if hashed < 0x80000000 else hashed - 0x100000000)
    digits = ''
    while hashed:
        hashed, digit = divmod(hashed, 36)
        digits = '0123456789abcdefghijklmnopqrstuvwxyz'[digit] + digits
    return name[:200] + '-' + (digits or '0')


def transcript(session, entry):
    root = Path(entry['store']) / 'projects'
    candidate = root / project_slug(entry['cwd']) / (session + '.jsonl')
    # A resumed conversation can have started in a different folder.
    candidates = [candidate] if candidate.is_file() else root.glob('*/' + session + '.jsonl')
    for path in candidates:
        resolved = path.resolve()
        if resolved.is_relative_to(root.resolve()) and resolved.is_file():
            return resolved
    return None


def metadata(session, entry):
    path = transcript(session, entry)
    title = entry.get('title') or 'New conversation'
    updated = entry.get('created', 0)
    if path:
        updated = path.stat().st_mtime_ns // 1_000_000
        # Bounded title discovery; no transcript is copied to S.T.'s index.
        with path.open('rb') as source:
            head = source.read(64 * 1024)
            source.seek(max(0, path.stat().st_size - 64 * 1024))
            tail = source.read(64 * 1024)
        first = None
        native_title = None
        for line in (head + b'\n' + tail).splitlines():
            try:
                value = json.loads(line)
                if not isinstance(value, dict):
                    continue
                native_title = value.get('customTitle') or value.get('aiTitle') or native_title
                if first is None and value.get('type') == 'user' and not value.get('isMeta') and not value.get('isSidechain'):
                    content = (value.get('message') or {}).get('content')
                    if isinstance(content, list):
                        content = ' '.join(x.get('text', '') for x in content if isinstance(x, dict) and x.get('type') == 'text')
                    if isinstance(content, str) and not content.startswith(('<command-', '<local-command-', 'Caveat:')):
                        first = content
            except (ValueError, TypeError, AttributeError):
                continue
        title = entry.get('renamed') or native_title or first or title
    missing = None if Path(entry['cwd']).is_dir() else 'The original checkout is no longer available.'
    return {'id': 'claude:' + session, 'provider': 'claude', 'title': ' '.join(str(title).split())[:140],
            'project': entry['project'], 'cwd': entry['cwd'], 'updated': updated,
            'archived': False, 'unavailable': missing, 'folder': None}


def register(root, session, project, title='New conversation'):
    return update(root, session, {'cwd': project['path'], 'project': project['id'],
                                'store': str(config_dir()), 'created': int(time.time() * 1000), 'title': title})
