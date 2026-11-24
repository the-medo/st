"""Private adapter: the existing sidebar store and explicitly owned Ovis terminals."""
import base64
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import uuid

root = Path(os.environ.get('MEDO_SIDEBAR_ROOT', '/home/medo/dev/herdr-codex-sidebar'))
sys.path.insert(0, str(root))
import server as sidebar
import organization
from chat_service import request, Bridge


def terminal_thread(terminal, rows):
    if terminal.get('foreground', {}).get('name') != 'codex':
        return None
    # Our launches opt into thread-id-only titles. The title follows /new and /resume,
    # unlike an argv or label which would keep showing the old conversation.
    title = (terminal.get('title') or '').strip()
    match = re.fullmatch(r'(?:[\u2800-\u28ff]\s+)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{5}(?:[0-9a-f]{7}|\.\.\.))', title)
    if not match:
        return None
    prefix = match[1].removesuffix('...')
    found = [row['id'] for row in rows if row['id'].startswith(prefix)]
    return found[0] if len(found) == 1 else None


def launch(project, thread=None, title="New conversation"):
    if not Path(project['path']).is_dir():
        raise ValueError('This project folder is no longer available.')
    state = Path(os.environ.get('OVIS_STATE_DIR', str(Path.home()/'.local/state/medo-ovis')))
    state.mkdir(parents=True, exist_ok=True)
    with (state/'launch.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if thread:
            rows = sidebar.read_rows()
            for terminal in sidebar.hc('ls', '--json')['terminals']:
                if terminal.get('state') != 'live': continue
                detail = sidebar.hc('get', terminal['address'], '--json')
                if detail.get('labels', {}).get('medo.ovis.project') and terminal_thread(detail, rows) == thread:
                    return {'address':terminal['address'], 'reused':True}
        key = uuid.uuid4().hex[:20]
        args = [sidebar.CODEX, '--remote', 'unix://' + str(Path.home()/'.codex/app-server-control/app-server-control.sock'), '-c', 'tui.terminal_title=["thread-id"]']
        if thread: args += ['resume', '--cd', project['path'], thread]
        else: args += ['--cd', project['path']]
        result = sidebar.hc('run', '--bg', '--keep', '--no-parent', '--json', '--name', 'ovis-'+key,
            '--cwd', project['path'], '--label', 'herdr.space=medo-ovis-'+project['id'],
            '--label', 'herdr.tab=medo-ovis-'+key, '--label', 'ovis.tab='+title,
            '--label', 'ovis.workspace='+project['name'], '--label', 'medo.ovis.project='+project['id'],
            '--label', 'where='+project['name'], '--', *map(str,args))
        return {'address':result['address'], 'reused':False}


def cursor(thread, page):
    if not page.get('nextCursor') or not page['turns']: return None
    return base64.urlsafe_b64encode(json.dumps([thread, page['turns'][0]['id'], page['nextCursor']]).encode()).decode().rstrip('=')


def history(thread, p):
    held = p.get('before') or p.get('from')
    boundary = None
    if held:
        try:
            binding, boundary, native = json.loads(base64.urlsafe_b64decode(held+'='*(-len(held)%4)))
            if binding != thread: return {'historyChanged':True}
        except (ValueError, TypeError): return {'historyChanged':True}
    data = request({'operation':'read', 'threadId':thread, 'cursor':native if p.get('before') else None})
    if p.get('from'):
        newest = data
        turns = list(data['turns'])
        for _ in range(200):
            at = next((i for i,t in enumerate(turns) if t['id'] == boundary), None)
            if at is not None:
                data = {**newest, 'turns':turns[at:], 'ovisCursor':held}
                return data
            if not data.get('nextCursor'): return {'historyChanged':True}
            data = request({'operation':'read', 'threadId':thread, 'cursor':data['nextCursor']})
            turns = data['turns'] + turns
        raise ValueError('This view is too large. Reload the conversation to its newest messages.')
    data['ovisCursor'] = cursor(thread, data)
    return data


def handle(p):
    op = p['operation']
    if op == 'index':
        result = sidebar.catalog()
        rows = sidebar.read_rows()
        by_thread = {}
        drafts = []
        for terminal in sidebar.hc('ls', '--json')['terminals']:
            if terminal.get('state') != 'live' or not (terminal.get('name') or '').startswith('ovis-'): continue
            detail = sidebar.hc('get', terminal['address'], '--json')
            project = detail.get('labels', {}).get('medo.ovis.project')
            if not project: continue
            thread = terminal_thread(detail, rows)
            if thread: by_thread[thread] = detail
            else: drafts.append({'address':detail['address'], 'project':project, 'title':'New conversation'})
        for chat in result['chats']:
            terminal = by_thread.get(chat['id'])
            if terminal:
                chat['paneId'] = terminal['address']
                chat['status'] = (terminal.get('status') or {}).get('state','idle')
                if terminal.get('labels', {}).get('ovis.tab') != chat['title']:
                    sidebar.hc('label', terminal['address'], 'ovis.tab='+chat['title'])
        result['drafts'] = drafts
        return result
    if op == 'open':
        row, item = sidebar.checked_thread(p['threadId'])
        if row.get('archived'): raise ValueError('Unarchive this conversation in Codex before continuing.')
        project = next((x for x in sidebar.config()['projects'] if x['id']==item['project']), {'id':'other','name':'Other'})
        client = Bridge()
        try:
            client.rpc('thread/resume', {'threadId':p['threadId'], 'excludeTurns':True})
        except Exception as error:
            if 'active writer' in str(error):
                raise ValueError('This conversation is open in a standalone Codex terminal. Close that terminal first, then reopen the conversation here. Its saved history is kept.') from None
            raise
        finally:
            client.process.terminate()
        return launch({**project, 'path':item['cwd']}, p['threadId'], item['title'])
    if op == 'new':
        project = next((x for x in sidebar.config()['projects'] if x['id']==p['projectId']), None)
        if not project: raise ValueError('Choose a project for this conversation.')
        return launch(project)
    if op == 'organize':
        cfg = sidebar.config()
        return organization.update(root, {x['id'] for x in cfg['projects']} | {'other'},
            {x['id']: sidebar.project_for(x, cfg) for x in sidebar.read_rows()}, p['change'])
    if op == 'style': return sidebar.save_style(p['projectId'], p['style'])
    if op == 'icon-put': return sidebar.put_icon(p['base64'])
    if op == 'icon-get': return sidebar.get_icon(p['name'])
    if op in ('models', 'settings'):
        terminal = sidebar.hc('get', p['paneId'], '--json')
        if not terminal.get('labels', {}).get('medo.ovis.project'):
            raise ValueError('Open this conversation from the project sidebar first.')
        thread = terminal_thread(terminal, sidebar.read_rows())
        if thread:
            return request({'operation':op,'threadId':thread,'model':p.get('model'),'effort':p.get('effort')})
        # A brand-new TUI has a daemon thread before its first persisted message.
        # Resolve it only by the same live thread-id title, never by folder or recency.
        client = Bridge()
        try:
            loaded, next_cursor = [], None
            while True:
                page = client.rpc('thread/loaded/list', {'cursor':next_cursor} if next_cursor else {})
                loaded.extend({'id':key} for key in page['data'])
                next_cursor = page.get('nextCursor')
                if not next_cursor: break
            thread = terminal_thread(terminal, loaded)
            if not thread: raise ValueError('The conversation is still opening. Try the model picker again shortly.')
            models = client.rpc('model/list', {'limit':100, 'includeHidden':False})['data']
            if op == 'models': return {'models':models}
            selected = next((m for m in models if m['model']==p.get('model')), None)
            if not selected: raise ValueError('Choose a model offered by Codex.')
            effort = p.get('effort') or selected['defaultReasoningEffort']
            if effort not in [e['reasoningEffort'] for e in selected['supportedReasoningEfforts']]:
                raise ValueError('Choose a supported reasoning level.')
            client.rpc('thread/settings/update', {'threadId':thread, 'model':selected['model'], 'effort':effort})
            return {'ok':True, 'model':selected['model'], 'effort':effort}
        finally:
            client.process.terminate()
    if op == 'conversation':
        if p.get('threadId'):
            thread = p['threadId']
        else:
            terminal = sidebar.hc('get', p['paneId'], '--json')
            if not terminal.get('labels', {}).get('medo.ovis.project'): return None
            thread = terminal_thread(terminal, sidebar.read_rows())
        if not thread: return None
        return history(thread, p)
    raise ValueError('Unknown sidebar operation.')


if __name__ == '__main__':
    try:
        print(json.dumps({'result':handle(json.loads(sys.stdin.read(1024*1024)))}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error':str(error)}, ensure_ascii=False))
        sys.exit(1)
