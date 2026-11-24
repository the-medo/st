#!/usr/bin/env python3
"""Private Herdr sidebar bridge. History is read-only; launching is explicit."""
import argparse
import base64
from contextlib import closing
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
import uuid

if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    __package__ = 'integrations.ovis.bridge'

ROOT = Path(os.environ.get('ST_OVIS_SIDEBAR_DATA', os.environ.get('MEDO_SIDEBAR_ROOT', str(Path.home()/'.local/share/st-ovis/sidebar')))).expanduser()
CODEX_HOME = Path(os.environ.get('CODEX_HOME', str(Path.home()/'.codex'))).expanduser()
HC = os.environ.get('ST_OVIS_HC_BIN', str(Path.home()/'.local/bin/hc'))
CODEX = os.environ.get('ST_OVIS_CODEX_BIN', str(Path.home()/'.local/bin/codex'))


def config():
    return json.loads((ROOT / 'projects.json').read_text())


def origin(url):
    url = (url or '').strip().removesuffix('.git').rstrip('/')
    return re.sub(r'^(?:https?://|ssh://)?(?:git@)?', '', url).replace(':', '/').lower()


def inside(path, parent):
    return path == parent or path.startswith(parent.rstrip('/') + '/')


def human(row):
    source = row.get('source', '')
    return source in ('vscode', 'cli', 'app') and not row.get('agent_path')


def project_for(row, cfg):
    projects = cfg['projects']
    known = cfg.get('threadProjects', {}).get(row['id']) or row.get('project_id')
    if any(p['id'] == known for p in projects):
        return known
    cwd = row.get('cwd') or ''
    aliases = [p for p in projects if any(inside(cwd, a) for a in p.get('aliases', []))]
    if len(aliases) == 1:
        return aliases[0]['id']
    matches = sorted((p for p in projects if inside(cwd, p['path'])), key=lambda p: len(p['path']), reverse=True)
    if matches and matches[0]['path'] != cfg.get('workspaceRoot', str(Path.home()/'dev')):
        return matches[0]['id']
    remote = origin(row.get('git_origin_url'))
    owners = [p for p in projects if remote and remote in p.get('origins', [])]
    if len(owners) == 1:
        return owners[0]['id']
    # A saved worktree can lose its origin metadata; resolve its common directory.
    if Path(cwd).is_dir() and '/.codex/worktrees/' in cwd:
        result = subprocess.run(['git', '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], capture_output=True, text=True, timeout=3)
        if result.returncode == 0:
            common = result.stdout.strip()
            owners = sorted((p for p in projects if inside(common, p['path'])), key=lambda p: len(p['path']), reverse=True)
            if owners:
                return owners[0]['id']
    return matches[0]['id'] if matches else 'other'


def read_rows(db=None):
    db = db or CODEX_HOME / 'state_5.sqlite'
    with closing(sqlite3.connect(db.as_uri() + '?mode=ro', uri=True, timeout=4)) as conn:
        conn.execute('PRAGMA query_only=ON')
        conn.row_factory = sqlite3.Row
        return [dict(r) for r in conn.execute('SELECT * FROM threads ORDER BY updated_at DESC') if human(dict(r))]


def display(row, cfg):
    title = row.get('name') or row.get('title') or row.get('first_user_message') or 'Untitled chat'
    title = ' '.join(title.split())[:140]
    cwd = row.get('cwd') or ''
    rollout = row.get('rollout_path') or ''
    missing = 'The original checkout is no longer on the Steam Machine.' if not Path(cwd).is_dir() else None
    history_exists = (CODEX_HOME / 'thread_history_1.sqlite').is_file() if row.get('history_mode') == 'paginated' else Path(rollout).is_file()
    if not history_exists:
        missing = 'The saved conversation file is unavailable.'
    return dict(id=row['id'], title=title, project=project_for(row, cfg), cwd=cwd,
                updated=row.get('updated_at_ms') or row['updated_at'] * 1000,
                archived=bool(row.get('archived')), unavailable=missing)


def empty_thread_ids(rows):
    """Exclude only proven empty paginated placeholders, never deduplicate by name.

    Desktop setup can persist a named thread before its first turn. Keep unknown
    or legacy history visible if its store cannot be inspected.
    """
    candidates = [r['id'] for r in rows if r.get('history_mode') == 'paginated'
                  and not (r.get('title') or '').strip()
                  and not (r.get('first_user_message') or '').strip()]
    if not candidates:
        return set()
    try:
        db = CODEX_HOME / 'thread_history_1.sqlite'
        with closing(sqlite3.connect(db.as_uri() + '?mode=ro', uri=True, timeout=4)) as conn:
            conn.execute('PRAGMA query_only=ON')
            return {thread for thread in candidates if not conn.execute('''
                SELECT EXISTS(SELECT 1 FROM thread_turns WHERE thread_id=?)
                    OR EXISTS(SELECT 1 FROM thread_items WHERE thread_id=?)
                    OR EXISTS(SELECT 1 FROM thread_realtime_items WHERE thread_id=?)
            ''', (thread, thread, thread)).fetchone()[0]}
    except sqlite3.Error:
        return set()


def catalog(cfg=None, rows=None):
    from . import organization
    cfg = cfg or config()
    rows = rows if rows is not None else read_rows()
    empty = empty_thread_ids(rows)
    chats = [display(r, cfg) for r in rows if r['id'] not in empty]
    saved = json.loads((ROOT / 'appearance.json').read_text()) if (ROOT / 'appearance.json').is_file() else {}
    projects = [dict(id=p['id'], name=p['name'], path=p['path'], appearance={**p.get('appearance', {}), **saved.get(p['id'], {})}) for p in cfg['projects']]
    if any(c['project'] == 'other' for c in chats):
        projects.append(dict(id='other', name='Other conversations', path=''))
    folders = organization.load(ROOT)
    for project in projects:
        group = folders['projects'].get(project['id'], {})
        project['folders'] = group.get('folders', [])
        known = {f['id'] for f in project['folders']}
        for chat in chats:
            if chat['project'] == project['id']:
                folder = group.get('chats', {}).get(chat['id'])
                chat['folder'] = folder if folder in known else None
    return dict(version=2, coreId=cfg['coreId'], generated=int(time.time()), projects=projects, chats=chats,
                organizationRevision=folders['revision'])


def save_style(project_id, style):
    if not any(p['id'] == project_id for p in config()['projects']):
        raise ValueError('Unknown project.')
    if not isinstance(style, dict) or set(style) - {'iconText','titleColor','sectionColor','iconColor','image'}:
        raise ValueError('Invalid project appearance.')
    clean = {}
    for key, value in style.items():
        if not isinstance(value, str):
            raise ValueError('Appearance values must be text.')
        value = value.strip()
        if key.endswith('Color') and value and not re.fullmatch(r'#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?', value):
            raise ValueError('Colors must use #RRGGBB or #RRGGBBAA.')
        if key == 'iconText' and len(value) > 12:
            raise ValueError('Use an emoji or a short label (12 characters maximum).')
        if key == 'image' and value and (not re.fullmatch(r'[0-9a-f]{64}\.(png|jpg|webp)', value) or not (ROOT/'icons'/value).is_file()):
            raise ValueError('Upload the image before saving.')
        clean[key] = value
    with (ROOT/'appearance.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = ROOT/'appearance.json'
        saved = json.loads(path.read_text()) if path.is_file() else {}
        saved[project_id] = clean
        temporary = ROOT/'appearance.json.tmp'
        temporary.write_text(json.dumps(saved,ensure_ascii=False,indent=2)+'\n')
        temporary.chmod(0o600)
        temporary.replace(path)
    return {'ok':True}


def put_icon(encoded):
    if len(encoded) > 710000:
        raise ValueError('Choose an image smaller than 512 KiB.')
    data = base64.b64decode(encoded,validate=True)
    if len(data) > 524288:
        raise ValueError('Choose an image smaller than 512 KiB.')
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        ext = 'png'
    elif data.startswith(b'\xff\xd8\xff'):
        ext = 'jpg'
    elif data.startswith(b'RIFF') and data[8:12] == b'WEBP':
        ext = 'webp'
    else:
        raise ValueError('Choose a PNG, JPEG or WebP image.')
    name = hashlib.sha256(data).hexdigest()+'.'+ext
    folder = ROOT/'icons'
    folder.mkdir(mode=0o700,exist_ok=True)
    (folder/name).write_bytes(data)
    return {'image':name}


def get_icon(name):
    if not re.fullmatch(r'[0-9a-f]{64}\.(png|jpg|webp)',name):
        raise ValueError('Invalid image name.')
    return {'base64':base64.b64encode((ROOT/'icons'/name).read_bytes()).decode()}


def checked_thread(thread_id):
    uuid.UUID(thread_id)
    rows = [r for r in read_rows() if r['id'] == thread_id]
    if not rows:
        raise ValueError('Conversation not found in the Steam Machine history.')
    row = rows[0]
    item = display(row, config())
    if item['unavailable']:
        raise ValueError(item['unavailable'])
    return row, item


def hc(*args):
    p = subprocess.run([HC, *args], capture_output=True, text=True, timeout=25)
    if p.returncode:
        raise RuntimeError((p.stderr or p.stdout).strip()[:500])
    return json.loads(p.stdout)


def launch(thread_id):
    row, item = checked_thread(thread_id)
    project_id = item['project']
    cwd, title = item['cwd'], item['title']
    token = thread_id.replace('-', '')[:28]
    argv = [sys.executable, str(Path(__file__).resolve()), 'resume', thread_id]
    name = 'cx-' + token
    space, tab = 'codex-' + project_id, 'codex-' + token
    state = Path.home() / '.local/state/herdr-codex-sidebar'
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Serialize open requests from multiple desktops so one chat has one live terminal.
    with (state / 'launch.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        existing = next((t for t in hc('ls', '--json')['terminals'] if t.get('name') == name and t.get('state') == 'live'), None)
        if existing:
            return dict(address=existing['address'], space=space, tab=tab, title=title, project=project_id, reused=True)
        terminal = hc('run', '--bg', '--keep', '--no-parent', '--json', '--name', name,
                      '--cwd', cwd, '--label', 'herdr.space=' + space, '--label', 'herdr.tab=' + tab,
                      '--label', 'medo.codex.thread=' + (thread_id or ''), '--', *argv)
    return dict(address=terminal['address'], space=space, tab=tab, title=title, project=project_id, reused=False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['index', 'open', 'resume', 'style', 'icon-put', 'icon-get', 'organize', 'chat'])
    parser.add_argument('id', nargs='?')
    parser.add_argument('payload', nargs='*')
    args = parser.parse_args()
    if args.command == 'index':
        result = catalog()
        try:
            from .chat_service import request, SOCKET
            result['activity'] = request({'operation': 'activity'}) if SOCKET.exists() else {}
        except Exception:
            result['activity'] = {}
    elif args.command == 'open':
        result = launch(thread_id=args.id)
    elif args.command == 'style':
        result = save_style(args.id,json.loads(args.payload[0]))
    elif args.command == 'icon-put':
        result = put_icon(''.join([args.id or '',*args.payload]))
    elif args.command == 'icon-get':
        result = get_icon(args.id)
    elif args.command == 'organize':
        from . import organization
        cfg = config()
        rows = read_rows()
        result = organization.update(ROOT, {p['id'] for p in cfg['projects']} | {'other'},
                                     {r['id']: project_for(r, cfg) for r in rows},
                                     json.loads(''.join([args.id or '', *args.payload])))
    elif args.command == 'chat':
        from .chat_service import request
        result = request(json.loads(''.join([args.id or '', *args.payload])))
    else:
        row, item = checked_thread(args.id)
        os.chdir(item['cwd'])
        # No prompt: restoring history never sends a model request by itself.
        os.execv(CODEX, [CODEX, 'resume', '--cd', item['cwd'], args.id])
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({'error': str(e)}), file=sys.stderr)
        sys.exit(1)
