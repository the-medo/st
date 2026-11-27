"""Private adapter: the existing sidebar store and explicitly owned Ovis terminals."""
import base64
from contextlib import nullcontext
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))
from integrations.ovis.bridge import server as sidebar, organization, resources, questions, claude_sessions
from integrations.ovis.bridge.chat_service import request, Bridge
from integrations.ovis.bridge import assistant, activity
root = sidebar.ROOT


def claude_binary():
    return os.environ.get('ST_OVIS_CLAUDE_BIN') or shutil.which('claude') or str(Path.home()/'.local/bin/claude')


def model_catalog():
    client = Bridge()
    try:
        return client.rpc('model/list', {'limit': 100, 'includeHidden': False})['data']
    finally:
        client.process.terminate()


def claude_configuration(cwd=None, model='', with_settings=False):
    """Ask the native CLI for metadata only, with the launch directory's settings."""
    cache = Path(os.environ.get('TMPDIR') or Path.home()/'.cache/st-claude-models')
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    requests = [{'type': 'control_request', 'request_id': 'model-options', 'request': {'subtype': 'initialize'}}]
    if with_settings:
        requests.append({'type': 'control_request', 'request_id': 'defaults', 'request': {'subtype': 'get_settings'}})
    with (nullcontext(cwd) if cwd else tempfile.TemporaryDirectory(prefix='st-claude-models-', dir=cache)) as directory:
        reply = subprocess.run([claude_binary(), '--safe-mode', '--print',
            '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
            '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
            '--tools', '', *(['--model', model] if model else [])], cwd=directory,
            input=''.join(json.dumps(request)+'\n' for request in requests),
            text=True, capture_output=True, timeout=15, check=True)
    responses = {}
    for line in reply.stdout.splitlines():
        if not line.strip(): continue
        value = json.loads(line)
        if value.get('type') != 'control_response': continue
        response = value.get('response', {})
        if response.get('subtype') == 'success':
            responses[response.get('request_id')] = response['response']
    return responses


def claude_model_catalog():
    return claude_configuration()['model-options']['models']


def provider_defaults(provider, cwd, model=''):
    if provider not in ('codex', 'claude') or not isinstance(model, str) or len(model) > 120:
        raise ValueError('Choose a provider and model.')
    if provider == 'claude':
        launch_choices(provider, model, '')
        try:
            reply = claude_configuration(cwd, model, with_settings=True)
            applied = reply['defaults']['applied']
            resolved = applied['model']
            row = next((row for row in reply['model-options']['models']
                        if row['value'] != 'default' and (row.get('resolvedModel') == resolved or row['value'] == resolved)), None)
            # Only these fields leave the process; settings can contain credentials.
            return {'model': resolved, 'effort': applied['effort'],
                    'efforts': row.get('supportedEffortLevels', []) if row else None}
        except Exception:
            raise ValueError('Could not read Claude defaults for this folder.') from None
    client = Bridge()
    try:
        config = client.rpc('config/read', {'cwd': cwd, 'includeLayers': False})['config']
        profile = config.get('profiles', {}).get(config.get('profile'), {})
        config = {**config, **profile}
        models = client.rpc('model/list', {'limit': 100, 'includeHidden': False})['data']
        resolved = model or config.get('model') or next((row['model'] for row in models if row.get('isDefault')), None)
        row = next((row for row in models if row['model'] == resolved), None)
        return {'model': resolved, 'effort': config.get('model_reasoning_effort') or (row or {}).get('defaultReasoningEffort'),
                'efforts': [e['reasoningEffort'] for e in row['supportedReasoningEfforts']] if row else None}
    except Exception:
        raise ValueError('Could not read Codex defaults for this folder.') from None
    finally:
        client.process.terminate()


def claude_model_options(rows):
    models = {}
    default_label = 'Agent default'
    for row in rows:
        name, resolved = row['value'], row.get('resolvedModel')
        if name == 'default':
            # The launch directory may override the account's default model.
            default_label = 'Agent default (CLI settings)'
            continue
        label = row.get('displayName') or name
        alias = name in ('opus', 'sonnet', 'haiku', 'fable')
        option = {'id': name, 'label': f'Latest {name.title()} · {label}' if alias else label,
                  'efforts': row.get('supportedEffortLevels', []), 'defaultEffort': '',
                  'resolvedModel': resolved, 'alias': alias}
        models[name] = option
        if alias and resolved:
            models.setdefault(resolved, {**option, 'id': resolved, 'label': label, 'alias': False})
    if not models: raise ValueError('Claude returned no model choices.')
    return list(models.values()), default_label


def provider_options():
    codex = {'id': 'codex', 'label': 'Codex', 'installed': os.access(sidebar.CODEX, os.X_OK), 'models': [], 'error': None}
    try:
        codex['models'] = [{'id': m['model'], 'label': m.get('displayName') or m['model'],
                            'efforts': [e['reasoningEffort'] for e in m['supportedReasoningEfforts']],
                            'defaultEffort': m['defaultReasoningEffort'], 'isDefault': m.get('isDefault', False)} for m in model_catalog()]
    except Exception:
        codex['error'] = 'Model choices are unavailable. You can start with the Codex default.'
    claude = {'id': 'claude', 'label': 'Claude', 'installed': os.access(claude_binary(), os.X_OK), 'error': None,
              'models': [{'id': name, 'label': 'Latest '+name.title(), 'efforts': ['low', 'medium', 'high', 'xhigh', 'max'],
                          'defaultEffort': ''} for name in ('opus', 'sonnet', 'haiku')]}
    if claude['installed']:
        try:
            claude['models'], claude['defaultModelLabel'] = claude_model_options(claude_model_catalog())
        except Exception:
            claude['error'] = 'Could not read Claude’s model list. Choose a latest alias or enter a model ID.'
    return {'providers': [codex, claude]}


def launch_choices(provider, model, effort, cwd=None):
    if provider not in ('codex', 'claude'):
        raise ValueError('Choose Codex or Claude.')
    if not isinstance(model, str) or not isinstance(effort, str):
        raise ValueError('Choose a model and reasoning level.')
    if model and not re.fullmatch(r'[A-Za-z0-9][\w.:/-]*(?:\[[A-Za-z0-9]+\])?', model):
        raise ValueError('Choose a valid model.')
    if provider == 'claude':
        if (model and (len(model) > 120 or not re.fullmatch(r'(?:opus|sonnet|haiku|fable|claude-[a-z0-9][a-z0-9-]*)(?:\[1m\])?', model))) or effort not in ('', 'low', 'medium', 'high', 'xhigh', 'max'):
            raise ValueError('Choose a Claude model and reasoning level.')
    elif not model and effort:
        defaults = provider_defaults('codex', cwd)
        if effort not in (defaults['efforts'] or []):
            raise ValueError('Choose a reasoning level offered by the default Codex model.')
    elif model:
        selected = next((m for m in model_catalog() if m['model'] == model), None)
        if not selected or (effort and effort not in [e['reasoningEffort'] for e in selected['supportedReasoningEfforts']]):
            raise ValueError('Choose a model and reasoning level offered by Codex.')
    args = ['--model', model] if model else []
    if effort:
        args += ['--effort', effort] if provider == 'claude' else ['-c', 'model_reasoning_effort='+effort]
    return args


def claude_permission_args(state):
    try:
        preferences = json.loads((state / 'preferences.json').read_text())
    except FileNotFoundError:
        return []
    settings = preferences.get('settings', {}) if isinstance(preferences, dict) else {}
    mode = settings.get('claudeLaunchMode', 'default') if isinstance(settings, dict) else None
    if mode not in ('default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'):
        raise ValueError('Choose a valid Claude permission preset in Settings.')
    return [] if mode == 'default' else ['--permission-mode', mode]


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


def launch(project, thread=None, title="New conversation", folder=None, provider='codex', model='', effort=''):
    if not Path(project['path']).is_dir():
        raise ValueError('This project folder is no longer available.')
    preferences = Path(os.environ.get('OVIS_STATE_DIR', str(Path.home()/'.local/state/medo-ovis')))
    choices = launch_choices(provider, model, effort, project['path']) if thread is None else []
    permissions = (claude_permission_args(preferences) if provider == 'claude' else codex_permission_args(preferences)) if thread is None else []
    # All web instances using this catalog share launch ownership, even when
    # their device preferences and cookies live in separate OVIS_STATE_DIRs.
    state = sidebar.ROOT
    state.mkdir(parents=True, exist_ok=True)
    with (state/'ovis-launch.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if provider == 'claude':
            return launch_claude(project, thread, title, choices, permissions, folder)
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
        else: args += [*permissions, *choices, '--cd', project['path']]
        launch_labels = ['--label', 'medo.ovis.starting=1']
        if folder: launch_labels += ['--label', 'medo.ovis.folder='+folder]
        if thread: launch_labels += ['--label', 'medo.ovis.resume='+thread]
        result = sidebar.hc('run', '--bg', '--keep', '--no-parent', '--json', '--name', 'ovis-'+key,
            '--cwd', project['path'], '--label', 'herdr.space=medo-ovis-'+project['id'],
            '--label', 'herdr.tab=medo-ovis-'+key, '--label', 'ovis.tab='+title,
            '--label', 'ovis.workspace='+project['name'], '--label', 'medo.ovis.project='+project['id'],
            '--label', 'where='+project['name'], *launch_labels, '--', *map(str,args))
        return {'address':result['address'], 'reused':False, 'pid':result.get('pid')}


def launch_claude(project, thread, title, choices, permissions, folder=None):
    # Called under the same launch lock as Codex; only native process identity permits reuse.
    store = claude_sessions.config_dir()
    if not os.access(claude_binary(), os.X_OK):
        raise ValueError('Claude Code is not installed on this server.')
    if thread:
        for terminal in sidebar.hc('ls', '--json')['terminals']:
            if terminal.get('state') != 'live': continue
            detail = sidebar.hc('get', terminal['address'], '--json')
            if claude_sessions.terminal_session(detail, store) == thread:
                return {'address': terminal['address'], 'reused': True}
        # A standalone interactive CLI may also own the session; do not open a second writer.
        for record in (store / 'sessions').glob('*.json'):
            if record.stem.isdigit() and claude_sessions.process_session(int(record.stem), store) == thread:
                raise ValueError('This Claude conversation is open in another terminal. Close it before reopening here.')
    session = thread or str(uuid.uuid4())
    key = uuid.uuid4().hex[:20]
    args = ['/usr/bin/env', 'CLAUDE_CONFIG_DIR='+str(store), claude_binary(), '--resume' if thread else '--session-id', session, *choices, *permissions]
    result = sidebar.hc('run', '--bg', '--keep', '--no-parent', '--json', '--name', 'ovis-'+key,
        '--cwd', project['path'],
        '--label', 'herdr.space=medo-ovis-'+project['id'], '--label', 'herdr.tab=medo-ovis-'+key,
        '--label', 'ovis.tab='+title, '--label', 'ovis.workspace='+project['name'],
        '--label', 'medo.ovis.project='+project['id'], '--label', 'medo.ovis.provider=claude',
        '--label', 'medo.ovis.claude='+session, '--label', 'medo.ovis.starting=1',
        '--label', 'where='+project['name'], '--', *args)
    if not thread:
        claude_sessions.register(sidebar.ROOT, session, project, title)
        if folder:
            organization.place_launched_chat(sidebar.ROOT, project['id'], folder,
                'ovis-'+key, 'claude:'+session, project['id'])
    return {'address':result['address'], 'reused':False, 'pid':result.get('pid')}


def launch_folder(terminal, thread, rows):
    """A folder launch follows its first native thread, never a later /new or /resume."""
    labels = terminal.get('labels', {})
    folder = labels.get('medo.ovis.folder')
    if not folder:
        return None, False
    project = labels['medo.ovis.project']
    data = organization.load(sidebar.ROOT)
    known = {f['id'] for f in data['projects'].get(project, {}).get('folders', [])}
    if folder not in known: folder = None
    prefix = thread_title_prefix(terminal)
    bound = labels.get('medo.ovis.folder-thread')
    if not prefix:
        return (folder if not bound else None), False
    if bound and not (prefix.startswith(bound) or bound.startswith(prefix)):
        return None, False
    if not bound:
        sidebar.hc('label', terminal['address'], 'medo.ovis.folder-thread='+prefix)
    row = next((row for row in rows if row['id'] == thread), None)
    if row:
        folder = organization.place_launched_chat(sidebar.ROOT, project, folder,
            terminal['name'], thread, sidebar.project_for(row, sidebar.config()))
        return folder, True
    if len(prefix) == 36:
        # The owned TUI already reports the exact native ID before its first
        # message is indexed. Persist now so ending the terminal cannot lose it.
        folder = organization.place_launched_chat(sidebar.ROOT, project, folder,
            terminal['name'], prefix, project)
    return folder, False


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
    if op == 'providers':
        return provider_options()
    if op == 'defaults':
        project = next((item for item in sidebar.config()['projects'] if item['id'] == p.get('projectId')), None)
        cwd = project.get('path') if project else p.get('cwd')
        if not isinstance(cwd, str) or not cwd.strip():
            raise ValueError('Choose a folder to see its defaults.')
        cwd = str(Path(cwd).expanduser().resolve())
        if not Path(cwd).is_dir(): raise ValueError('Choose an existing folder to see its defaults.')
        return provider_defaults(p.get('provider'), cwd, p.get('model', ''))
    if op == 'claude-history':
        session = p.get('threadId', '').removeprefix('claude:')
        entry = claude_sessions.load(sidebar.ROOT).get(session)
        if not entry: raise ValueError('Choose a saved Claude conversation.')
        path = claude_sessions.transcript(session, entry)
        if not path: return None
        return {'path': str(path), 'root': str(Path(entry['store']) / 'projects')}
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
        if thread.startswith('claude:'):
            session = thread[7:]
            if session not in claude_sessions.load(sidebar.ROOT): raise ValueError('Choose a saved Claude conversation.')
            claude_sessions.update(sidebar.ROOT, session, {'renamed': name})
            return {'ok': True, 'title': name}
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
    if op == 'read-completion':
        return activity.acknowledge(sidebar.ROOT, sidebar.CODEX_HOME, sidebar.read_rows(),
                                    p.get('threadId'), p.get('completionId'))
    if op == 'index':
        rows = sidebar.read_rows()
        result = sidebar.catalog(rows=rows)
        saved = {chat['id'] for chat in result['chats']}
        by_thread = {}
        folder_updates = {}
        drafts = []
        claude_live = {}
        claude_saved = claude_sessions.load(sidebar.ROOT)
        for terminal in sidebar.hc('ls', '--json')['terminals']:
            if terminal.get('state') != 'live' or not (terminal.get('name') or '').startswith('ovis-'): continue
            detail = sidebar.hc('get', terminal['address'], '--json')
            project = detail.get('labels', {}).get('medo.ovis.project')
            if not project: continue
            labels = detail.get('labels', {})
            if labels.get('medo.ovis.provider') == 'claude':
                session = claude_sessions.terminal_session(detail, claude_sessions.config_dir())
                if session:
                    if labels.get('medo.ovis.starting') == '1':
                        sidebar.hc('label', detail['address'], 'medo.ovis.starting=0')
                    if session not in claude_saved:
                        cwd = (detail.get('foreground') or {}).get('cwd') or detail.get('cwd')
                        if cwd:
                            claude_saved[session] = claude_sessions.register(sidebar.ROOT, session, {'id': project, 'path': cwd})
                    claude_live.setdefault(session, detail)
                elif labels.get('medo.ovis.starting') == '1' and (detail.get('foreground') or {}).get('name') in (None, 'claude'):
                    # Only an unconsumed start hint names a pending CLI, never a later /clear or /resume.
                    claude_live.setdefault(labels.get('medo.ovis.claude'), detail)
                continue
            thread = terminal_thread(detail, rows, starting=True)
            folder, assigned = launch_folder(detail, thread, rows)
            if assigned: folder_updates[thread] = folder
            if thread in saved:
                # Match launch()'s first live terminal, not the last duplicate.
                by_thread.setdefault(thread, detail)
            elif detail.get('foreground', {}).get('name') == 'codex' and (
                not resumed_thread(detail) or
                (thread_title_prefix(detail) and not resumed_thread(detail).startswith(thread_title_prefix(detail)))
            ):
                # A resumed placeholder or a resume still starting is not a
                # draft. An explicit new chat (also /new) remains reachable.
                drafts.append({'address':detail['address'], 'project':project, 'folder':folder, 'title':'New conversation'})
        rows_by_id = {row['id']: row for row in rows}
        managed_threads = assistant.threads()
        for chat in result['chats']:
            if chat['id'] in folder_updates: chat['folder'] = folder_updates[chat['id']]
            chat['assistant'] = assistant.owns(rows_by_id.get(chat['id'], {})) and (managed_threads is None or chat['id'] in managed_threads)
            terminal = by_thread.get(chat['id'])
            if terminal:
                chat['paneId'] = terminal['address']
                chat['status'] = (terminal.get('status') or {}).get('state','idle')
                if terminal.get('labels', {}).get('ovis.tab') != chat['title']:
                    sidebar.hc('label', terminal['address'], 'ovis.tab='+chat['title'])
        activity.observe(sidebar.ROOT, sidebar.CODEX_HOME, rows, result['chats'])
        result['drafts'] = drafts
        folders = organization.load(sidebar.ROOT)
        for session, entry in claude_saved.items():
            chat = claude_sessions.metadata(session, entry)
            chat['done'] = folders.get('done', {}).get(chat['id']) is True
            if not any(project['id'] == chat['project'] for project in result['projects']):
                chat['project'] = 'other'
            group = folders['projects'].get(chat['project'], {})
            folder = group.get('chats', {}).get(chat['id'])
            chat['folder'] = folder if any(f['id'] == folder for f in group.get('folders', [])) else None
            terminal = claude_live.get(session)
            if terminal:
                chat.update(paneId=terminal['address'], status=(terminal.get('status') or {}).get('state', 'idle'))
            result['chats'].append(chat)
        if claude_saved and any(c.get('project') == 'other' for c in result['chats']) and not any(x['id'] == 'other' for x in result['projects']):
            result['projects'].append({'id': 'other', 'name': 'Other conversations', 'path': '', 'folders': []})
        return result
    if op == 'open':
        if str(p.get('threadId', '')).startswith('claude:'):
            session = p['threadId'][7:]
            entry = claude_sessions.load(sidebar.ROOT).get(session)
            if not entry: raise ValueError('Choose a saved Claude conversation.')
            if entry['store'] != str(claude_sessions.config_dir()):
                raise ValueError('This conversation belongs to a different Claude configuration.')
            project = next((x for x in sidebar.config()['projects'] if x['id'] == entry['project']), {'id': entry['project'], 'name': 'Other conversations'})
            return launch({**project, 'path': entry['cwd']}, session, claude_sessions.metadata(session, entry)['title'], provider='claude')
        row, item = sidebar.checked_thread(p['threadId'])
        if assistant.owns(row):
            raise ValueError('Continue this assistant conversation in its saved chat view.')
        if row.get('archived'): raise ValueError('Unarchive this conversation in Codex before continuing.')
        project = next((x for x in sidebar.config()['projects'] if x['id']==item['project']), {'id':'other','name':'Other'})
        return launch({**project, 'path':item['cwd']}, p['threadId'], item['title'])
    if op == 'new':
        cfg = sidebar.config()
        project = next((x for x in cfg['projects'] if x['id']==p.get('projectId')), None)
        if not project and isinstance(p.get('cwd'), str) and p['cwd'].strip():
            cwd = str(Path(p['cwd']).expanduser().resolve())
            owner = sidebar.project_for({'id': '', 'cwd': cwd}, cfg)
            project = {**next((x for x in cfg['projects'] if x['id'] == owner), {'id': 'other', 'name': Path(cwd).name}), 'path': cwd}
        if not project: raise ValueError('Choose a project for this conversation.')
        folder = p.get('folderId')
        if folder is not None and (not isinstance(folder, str) or not any(f['id'] == folder for f in organization.load(sidebar.ROOT)['projects'].get(project['id'], {}).get('folders', []))):
            raise ValueError('That folder no longer exists in this project. Refresh and try again.')
        return launch(project, folder=folder, provider=p.get('provider', 'codex'), model=p.get('model', ''), effort=p.get('effort', ''))
    if op == 'organize':
        cfg = sidebar.config()
        return organization.update(root, [x['id'] for x in cfg['projects']] + ['other'],
            {**{x['id']: sidebar.project_for(x, cfg) for x in sidebar.read_rows()},
             **{'claude:'+key: entry['project'] for key, entry in claude_sessions.load(sidebar.ROOT).items()}}, p['change'])
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
