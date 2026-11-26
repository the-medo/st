"""Private adapter: the existing sidebar store and explicitly owned Ovis terminals."""
import base64
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))
from integrations.ovis.bridge import server as sidebar, organization, resources, questions
from integrations.ovis.bridge.chat_service import request, Bridge
from integrations.ovis.bridge import assistant
root = sidebar.ROOT


def codex_permission_args(state):
    """Use this web instance's saved preset for new conversations only."""
    try:
        preferences = json.loads((state / 'preferences.json').read_text())
    except FileNotFoundError:
        return []
    settings = preferences.get('settings', {}) if isinstance(preferences, dict) else None
    mode = settings.get('codexLaunchMode', 'default') if isinstance(settings, dict) else None
    presets = {
        'default': [],
        'readOnly': ['--sandbox', 'read-only', '--ask-for-approval', 'on-request'],
        'auto': ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'],
        'fullAccess': ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'],
    }
    if not isinstance(mode, str) or mode not in presets:
        raise ValueError('Choose a valid Codex sandbox and approvals preset in Settings.')
    return presets[mode]


def thread_title_prefix(terminal):
    # Our launches opt into thread-id-only titles. The title follows /new and /resume,
    # unlike an argv or label which would keep showing the old conversation.
    title = (terminal.get('title') or '').strip()
    match = re.fullmatch(r'(?:[\u2800-\u28ff]\s+)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{5}(?:[0-9a-f]{7}|\.\.\.))', title)
    return match[1].removesuffix('...') if match else None


def terminal_thread(terminal, rows, *, starting=False):
    foreground = terminal.get('foreground', {}).get('name')
    if foreground != 'codex' and not (starting and foreground is None):
        return None
    title = (terminal.get('title') or '').strip()
    prefix = thread_title_prefix(terminal)
    labels = terminal.get('labels', {})
    if prefix and labels.get('medo.ovis.starting') == '1':
        # Consume the launch hint once the TUI reports any thread. It must never
        # bind a later /new or /resume back to the original conversation.
        sidebar.hc('label', terminal['address'], 'medo.ovis.starting=0')
        labels['medo.ovis.starting'] = '0'
    if not prefix:
        # This hint is only for sidebar identity / launch reuse, never history or
        # model writes. An arbitrary title is not evidence of a starting TUI.
        pending = labels.get('medo.ovis.resume')
        if starting and title in ('', 'codex') and labels.get('medo.ovis.starting') == '1':
            return pending if any(row['id'] == pending for row in rows) else None
        return None
    if foreground != 'codex': return None
    found = [row['id'] for row in rows if row['id'].startswith(prefix)]
    return found[0] if len(found) == 1 else None


def resumed_thread(terminal):
    """The launch target only classifies drafts; it never identifies live history."""
    labels = terminal.get('labels', {})
    if labels.get('medo.ovis.resume'): return labels['medo.ovis.resume']
    # Terminals opened before launch hints were introduced are still around.
    argv = terminal.get('foreground', {}).get('argv', [])
    return argv[-1] if 'resume' in argv and argv else None


def launch(project, thread=None, title="New conversation"):
    if not Path(project['path']).is_dir():
        raise ValueError('This project folder is no longer available.')
    preferences = Path(os.environ.get('OVIS_STATE_DIR', str(Path.home()/'.local/state/medo-ovis')))
    permissions = codex_permission_args(preferences) if thread is None else []
    # All web instances using this catalog share launch ownership, even when
    # their device preferences and cookies live in separate OVIS_STATE_DIRs.
    state = sidebar.ROOT
    state.mkdir(parents=True, exist_ok=True)
    with (state/'ovis-launch.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if thread:
            rows = sidebar.read_rows()
            for terminal in sidebar.hc('ls', '--json')['terminals']:
                if terminal.get('state') != 'live': continue
                detail = sidebar.hc('get', terminal['address'], '--json')
                if detail.get('labels', {}).get('medo.ovis.project') and terminal_thread(detail, rows, starting=True) == thread:
                    return {'address':terminal['address'], 'reused':True}
            client = Bridge()
            try:
                client.rpc('thread/resume', {'threadId':thread, 'excludeTurns':True})
            except Exception as error:
                if 'active writer' in str(error):
                    raise ValueError('This conversation is open in a standalone Codex terminal. Close that terminal first, then reopen the conversation here. Its saved history is kept.') from None
                raise
            finally:
                client.process.terminate()
        key = uuid.uuid4().hex[:20]
        args = [sidebar.CODEX, '--remote', 'unix://' + str(os.environ.get('ST_OVIS_CODEX_SOCKET') or sidebar.CODEX_HOME/'app-server-control/app-server-control.sock'), '-c', 'tui.terminal_title=["thread-id"]']
        if thread: args += ['resume', '--cd', project['path'], thread]
        else: args += [*permissions, '--cd', project['path']]
        launch_labels = ['--label', 'medo.ovis.starting=1']
        if thread: launch_labels += ['--label', 'medo.ovis.resume='+thread]
        result = sidebar.hc('run', '--bg', '--keep', '--no-parent', '--json', '--name', 'ovis-'+key,
            '--cwd', project['path'], '--label', 'herdr.space=medo-ovis-'+project['id'],
            '--label', 'herdr.tab=medo-ovis-'+key, '--label', 'ovis.tab='+title,
            '--label', 'ovis.workspace='+project['name'], '--label', 'medo.ovis.project='+project['id'],
            '--label', 'where='+project['name'], *launch_labels, '--', *map(str,args))
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
    row, _ = sidebar.checked_thread(thread)
    def read_page(next_cursor):
        # The web UI may share an older graphical-chat service. Read managed
        # assistant history passively here; never resume its dynamic tools in a TUI.
        if assistant.owns(row):
            client = Bridge()
            try:
                return client.read(thread, next_cursor)
            finally:
                client.process.terminate()
        return request({'operation':'read', 'threadId':thread, 'cursor':next_cursor})
    data = read_page(native if p.get('before') else None)
    if p.get('from'):
        newest = data
        turns = list(data['turns'])
        for _ in range(200):
            at = next((i for i,t in enumerate(turns) if t['id'] == boundary), None)
            if at is not None:
                data = {**newest, 'turns':turns[at:], 'ovisCursor':held}
                return data
            if not data.get('nextCursor'): return {'historyChanged':True}
            data = read_page(data['nextCursor'])
            turns = data['turns'] + turns
        raise ValueError('This view is too large. Reload the conversation to its newest messages.')
    data['ovisCursor'] = cursor(thread, data)
    return data


def handle(p):
    op = p['operation']
    if op in ('assistant_state', 'assistant_send', 'assistant_answer', 'assistant_stop'):
        row, item = sidebar.checked_thread(p['threadId'])
        if not assistant.owns(row):
            if op == 'assistant_state': return None
            raise ValueError('Choose an S.T. assistant conversation.')
        if op != 'assistant_state' and (row.get('archived') or item.get('unavailable')):
            raise ValueError(item.get('unavailable') or 'Unarchive this conversation before continuing.')
        return assistant.action({**p, 'operation': op if op == 'assistant_state' else op.removeprefix('assistant_')})
    if op == 'questions':
        terminal = sidebar.hc('get', p['paneId'], '--json')
        if not terminal.get('labels', {}).get('medo.ovis.project'):
            return None
        rows = sidebar.read_rows()
        thread = terminal_thread(terminal, rows)
        row = next((row for row in rows if row['id'] == thread), None)
        if not row or row.get('history_mode') != 'paginated':
            return None
        return {'historyId': 'medo:' + thread, 'questions': questions.unanswered(sidebar.CODEX_HOME, thread)}
    if op == 'resources':
        pane = p.get('paneId', '')
        if pane.startswith('medo:'):
            thread = pane[5:]
        else:
            terminal = sidebar.hc('get', pane, '--json')
            if not terminal.get('labels', {}).get('medo.ovis.project'):
                raise ValueError('Open a conversation from the project sidebar first.')
            thread = terminal_thread(terminal, sidebar.read_rows())
        if not thread:
            raise ValueError('The conversation is still opening. Try again shortly.')
        row, _ = sidebar.checked_thread(thread)
        client = Bridge()
        try:
            return resources.inventory(client, thread, row['cwd'])
        finally:
            client.process.terminate()
    if op == 'rename':
        name = p.get('name')
        if not isinstance(name, str): raise ValueError('Enter a conversation name.')
        name = ' '.join(name.split())
        if not name or len(name) > 140 or any(ord(c) < 32 or ord(c) == 127 for c in name):
            raise ValueError('Use a conversation name between 1 and 140 characters.')
        thread = p.get('threadId')
        if not isinstance(thread, str): raise ValueError('Choose a saved conversation.')
        uuid.UUID(thread)
        row = next((row for row in sidebar.read_rows() if row['id'] == thread), None)
        if not row: raise ValueError('Conversation not found in the Steam Machine history.')
        if row.get('archived'): raise ValueError('Unarchive this conversation in Codex before renaming it.')
        client = Bridge()
        try:
            client.rpc('thread/name/set', {'threadId':thread, 'name':name})
        finally:
            client.process.terminate()
        return {'ok':True, 'title':name}
    if op == 'index':
        rows = sidebar.read_rows()
        result = sidebar.catalog(rows=rows)
        saved = {chat['id'] for chat in result['chats']}
        by_thread = {}
        drafts = []
        for terminal in sidebar.hc('ls', '--json')['terminals']:
            if terminal.get('state') != 'live' or not (terminal.get('name') or '').startswith('ovis-'): continue
            detail = sidebar.hc('get', terminal['address'], '--json')
            project = detail.get('labels', {}).get('medo.ovis.project')
            if not project: continue
            thread = terminal_thread(detail, rows, starting=True)
            if thread in saved:
                # Match launch()'s first live terminal, not the last duplicate.
                by_thread.setdefault(thread, detail)
            elif detail.get('foreground', {}).get('name') == 'codex' and (
                not resumed_thread(detail) or
                (thread_title_prefix(detail) and not resumed_thread(detail).startswith(thread_title_prefix(detail)))
            ):
                # A resumed placeholder or a resume still starting is not a
                # draft. An explicit new chat (also /new) remains reachable.
                drafts.append({'address':detail['address'], 'project':project, 'title':'New conversation'})
        rows_by_id = {row['id']: row for row in rows}
        managed_threads = assistant.threads()
        for chat in result['chats']:
            chat['assistant'] = assistant.owns(rows_by_id.get(chat['id'], {})) and (managed_threads is None or chat['id'] in managed_threads)
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
        if assistant.owns(row):
            raise ValueError('Continue this assistant conversation in its saved chat view.')
        if row.get('archived'): raise ValueError('Unarchive this conversation in Codex before continuing.')
        project = next((x for x in sidebar.config()['projects'] if x['id']==item['project']), {'id':'other','name':'Other'})
        return launch({**project, 'path':item['cwd']}, p['threadId'], item['title'])
    if op == 'new':
        project = next((x for x in sidebar.config()['projects'] if x['id']==p['projectId']), None)
        if not project: raise ValueError('Choose a project for this conversation.')
        return launch(project)
    if op == 'organize':
        cfg = sidebar.config()
        return organization.update(root, [x['id'] for x in cfg['projects']] + ['other'],
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
