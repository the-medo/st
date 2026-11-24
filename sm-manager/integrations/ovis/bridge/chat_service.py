#!/usr/bin/env python3
"""Private, persistent Codex app-server client for Herdr's graphical chat pane.

Transport to desktops remains Herdr's authenticated machine connection. This
service listens only on an owner-only Unix socket; no HTTP port is opened.
"""
import copy
import base64
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import socket
import socketserver
import subprocess
import sys
import threading
import time
import uuid
from urllib.parse import unquote, urlsplit

from . import server
from . import attachments
from .daemon_transport import DaemonConnection

SOCKET = Path(os.environ.get('ST_OVIS_CHAT_SOCKET', str(Path(os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')) / 'herdr-codex-chat.sock')))
MAX_REQUEST = 1024 * 1024


class RpcError(RuntimeError):
    pass


def request(payload):
    encoded = json.dumps(payload).encode() + b'\n'
    if len(encoded) > MAX_REQUEST:
        raise ValueError('The message is too large.')
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(75)
            connection.connect(str(SOCKET))
            connection.sendall(encoded)
            with connection.makefile('rb') as stream:
                raw = stream.readline(8 * 1024 * 1024)
            result = json.loads(raw)
    except (FileNotFoundError, ConnectionRefusedError):
        raise RuntimeError('The chat service is not running on the Steam Machine.') from None
    if 'error' in result:
        raise RuntimeError(result['error'])
    return result['result']


def short(value, maximum=12000):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)
    return text if len(text) <= maximum else text[:maximum] + '\n… output shortened in this view'


def normalize_item(item):
    kind = item.get('type', '')
    result = {'id': item.get('id', ''), 'kind': kind, 'status': item.get('status')}
    if kind == 'userMessage':
        content = item.get('content', [])
        text = '\n'.join(part.get('text', f"[{part.get('type', 'attachment')}]") for part in content if part.get('type')!='localImage')
        attached = [{'name':Path(part['path']).name,'path':part['path']} for part in content if part.get('type')=='localImage' and part.get('path')]
        # The desktop serializes attachment metadata ahead of the actual prompt.
        # Present its files as clickable chips instead of a large transport preamble.
        marker = '## My request:'
        if text.lstrip().startswith('# Files mentioned by the user:') and marker in text:
            preamble, text = text.split(marker, 1)
            attached.extend({'name': name.strip(), 'path': path.strip()} for name, path in
                           re.findall(r'^## (.+?): (/[^\n]+)$', preamble, re.MULTILINE))
            text = re.sub(r'(?:\s*\[image\])+\s*$', '', text).strip()
        marker='Attached files (available on this machine):\n'
        if marker in text:
            prompt,manifest=text.rsplit(marker,1)
            listed=re.findall(r'^- \[(.*?)\]\(<([^>]+)>\)$',manifest.strip(),re.MULTILINE)
            if listed and all(path.startswith(str(attachments.ROOT)+'/') for _,path in listed):
                attached.extend({'name':name,'path':path} for name,path in listed);text=prompt.strip()
        result.update(role='user', text=short(text, 100000), attachments=list({f['path']:f for f in attached}.values()))
    elif kind in ('agentMessage', 'plan'):
        result.update(role='assistant', text=short(item.get('text', ''), 100000), phase=item.get('phase'))
    elif kind == 'reasoning':
        result.update(role='activity', title='Thinking', text=short('\n'.join(item.get('summary') or []), 12000))
    else:
        titles = {'commandExecution': 'Command', 'fileChange': 'File changes', 'mcpToolCall': 'Tool',
                  'dynamicToolCall': 'Tool', 'webSearch': 'Web search', 'collabAgentToolCall': 'Agent activity',
                  'subAgentActivity': 'Agent activity', 'functionCallOutput': 'Tool output'}
        title = titles.get(kind, kind or 'Activity')
        if kind == 'commandExecution':
            text = str(item.get('command', '')) + '\n\n' + str(item.get('aggregatedOutput') or '')
        elif kind == 'fileChange':
            text = '\n\n'.join(str(c.get('path', '')) + '\n' + str(c.get('diff', '')) for c in item.get('changes', []))
        elif kind in ('mcpToolCall', 'dynamicToolCall'):
            title = item.get('tool') or title
            text = short({'arguments': item.get('arguments'), 'result': item.get('result', item.get('contentItems')), 'error': item.get('error')})
        elif kind == 'webSearch':
            text = item.get('query') or short(item.get('action', {}))
        else:
            text = short({k: v for k, v in item.items() if k not in ('id', 'type')})
        result.update(role='activity', title=title, text=short(text))
    return result


def normalize_turn(turn):
    items = turn.get('items', [])
    # Keep messages; bound historical tool payloads independently from Codex's
    # complete persisted history. They are never injected back into the model.
    selected = [i for i in items[:-150] if i.get('type') in ('userMessage', 'agentMessage')] + items[-150:] if len(items) > 150 else items
    return {'id': turn['id'], 'status': turn.get('status'), 'error': turn.get('error'),
            'startedAt': turn.get('startedAt'), 'completedAt': turn.get('completedAt'), 'durationMs': turn.get('durationMs'),
            'items': [normalize_item(i) for i in selected], 'omittedActivity': max(0, len(items) - len(selected))}


def preview_path(target, cwd):
    parsed = urlsplit(target)
    if parsed.scheme not in ('', 'file', 'sandbox') or parsed.netloc not in ('', 'localhost'):
        raise ValueError('This is not a file on the Steam Machine.')
    raw = unquote(parsed.path)
    line = None
    match = re.search(r':(\d+)(?::\d+)?$', raw)
    if match and not Path(raw).is_file():
        line, raw = int(match[1]), raw[:match.start()]
    if re.fullmatch(r'L\d+(?:C\d+)?', parsed.fragment):
        line = int(re.match(r'L(\d+)', parsed.fragment)[1])
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = Path(cwd) / path
    path = path.resolve(strict=True)
    if not path.is_file():
        raise ValueError('Choose a file rather than a directory.')
    return path, line


def preview_file(target, cwd):
    """Read a clicked server file for an in-app preview; never launch its contents."""
    path, line = preview_path(target, cwd)
    size = path.stat().st_size
    if size > 5 * 1024 * 1024:
        raise ValueError('This file is larger than the 5 MiB preview limit. Copy it from the Steam Machine to open it locally.')
    data = path.read_bytes()
    result = {'name': path.name, 'path': str(path), 'size': size, 'line': line}
    extension = None
    if data.startswith(b'\x89PNG\r\n\x1a\n'): extension = 'png'
    elif data.startswith(b'\xff\xd8\xff'): extension = 'jpg'
    elif data.startswith(b'RIFF') and data[8:12] == b'WEBP': extension = 'webp'
    elif data.startswith((b'GIF87a', b'GIF89a')): extension = 'gif'
    if extension:
        result.update(kind='image', cacheName=hashlib.sha256(data).hexdigest()+'.'+extension,
                      base64=base64.b64encode(data).decode())
    else:
        try:
            if b'\x00' in data: raise UnicodeError()
            text = data.decode('utf-8-sig')
        except UnicodeError:
            raise ValueError('This file type cannot be previewed yet. Copy it from the Steam Machine to open it locally.') from None
        lines = text.splitlines()
        start = max(0, (line or 1) - 16)
        excerpt = '\n'.join(f'{i+1:>4}  {text}' for i, text in enumerate(lines[start:start+500], start)) if line else text
        result.update(kind='text', text=short(excerpt, 200000), shortened=len(excerpt)>200000 or bool(line and len(lines)>500))
    return result


class Bridge:
    def __init__(self, process=None):
        self.process = process or DaemonConnection()
        self.shared_daemon = isinstance(self.process, DaemonConnection)
        self.lock = threading.RLock()
        self.write_lock = threading.Lock()
        self.pending = {}
        self.next_id = 0
        self.live = {}
        self.approvals = {}
        self.loaded = set()
        self.settings = {}
        self.thread_locks = {}
        self.receipts = {}
        self.revisions = {}
        self.generation = uuid.uuid4().hex[:12]
        self.failure = None
        self.model_cache = {}
        threading.Thread(target=self._read, daemon=True).start()
        self.rpc('initialize', {'clientInfo': {'name': 'herdr_codex_chat', 'title': 'Herdr chat', 'version': '0.2.0'},
                               'capabilities': {'experimentalApi': True}})
        self._write({'method': 'initialized', 'params': {}})

    def _write(self, value):
        with self.write_lock:
            self.process.stdin.write(json.dumps(value, ensure_ascii=False) + '\n')
            self.process.stdin.flush()

    def rpc(self, method, params):
        with self.lock:
            if self.failure:
                raise RuntimeError(self.failure)
            self.next_id += 1
            number = self.next_id
            reply = queue.Queue()
            self.pending[number] = reply
        try:
            self._write({'id': number, 'method': method, 'params': params})
            result = reply.get(timeout=60)
            if 'error' in result:
                raise RpcError(result['error'].get('message', 'Codex request failed.'))
            return result['result']
        except queue.Empty:
            raise RuntimeError('Codex did not reply in time. Refresh before retrying a send.') from None
        finally:
            with self.lock:
                self.pending.pop(number, None)

    def _read(self):
        try:
            for line in self.process.stdout:
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                with self.lock:
                    if 'method' not in message and message.get('id') in self.pending:
                        self.pending[message['id']].put(message)
                    else:
                        self.event(message)
        except (EOFError, OSError):
            pass
        finally:
            with self.lock:
                self.failure = 'The Codex connection ended. Reload the chat after the server reconnects.'
                for pending in self.pending.values():
                    pending.put({'error': {'message': self.failure}})

    def event(self, message):
        method, params = message.get('method', ''), message.get('params') or {}
        thread_id = params.get('threadId')
        if thread_id:
            self.revisions[thread_id] = self.revisions.get(thread_id, 0) + 1
        if 'id' in message and method:
            if not thread_id:
                self._write({'id': message['id'], 'error': {'code': -32601, 'message': 'This client cannot handle that request.'}})
                return
            key = json.dumps(message['id'])
            self.approvals[key] = {'id': key, 'wireId': message['id'], 'method': method, 'threadId': thread_id, 'params': params}
            return
        if method == 'serverRequest/resolved':
            self.approvals.pop(json.dumps(params.get('requestId')), None)
            return
        if not thread_id:
            return
        if method == 'turn/started':
            turn = params['turn']
            self.live[thread_id] = {'id': turn['id'], 'status': 'inProgress', 'items': {i['id']: i for i in turn.get('items', [])}, 'error': None,
                                    'startedAt': turn.get('startedAt') or int(time.time()), 'durationMs': None}
        elif method in ('item/started', 'item/completed'):
            item = params.get('item', {})
            turn = self.live.setdefault(thread_id, {'id': params.get('turnId'), 'status': 'inProgress', 'items': {}, 'error': None})
            if item.get('id'):
                turn['items'][item['id']] = item
        elif method in ('item/agentMessage/delta', 'item/plan/delta', 'item/commandExecution/outputDelta'):
            turn = self.live.get(thread_id)
            if turn:
                item = turn['items'].setdefault(params['itemId'], {'id': params['itemId'], 'type': 'commandExecution' if 'commandExecution' in method else 'agentMessage'})
                field = 'aggregatedOutput' if 'commandExecution' in method else 'text'
                item[field] = (item.get(field) or '') + params.get('delta', '')
        elif method == 'turn/completed':
            incoming = params['turn']
            turn = self.live.setdefault(thread_id, {'id': incoming['id'], 'items': {}})
            turn.update(status=incoming.get('status', 'completed'), error=incoming.get('error'))
            turn['completedAt'] = incoming.get('completedAt') or int(time.time())
            turn['durationMs'] = incoming.get('durationMs')
            if turn['durationMs'] is None and turn.get('startedAt'):
                turn['durationMs'] = max(0, (turn['completedAt']-turn['startedAt'])*1000)
            for item in incoming.get('items', []):
                turn['items'][item['id']] = item
            for key in [key for key, value in self.approvals.items() if value['threadId'] == thread_id]:
                del self.approvals[key]

    def metadata(self, thread_id):
        uuid.UUID(thread_id)
        rows = [r for r in server.read_rows() if r['id'] == thread_id]
        if not rows:
            raise ValueError('Conversation not found.')
        return rows[0], server.display(rows[0], server.config())

    def read(self, thread_id, cursor=None, version=None):
        row, display = self.metadata(thread_id)
        thread = self.rpc('thread/read', {'threadId': thread_id})['thread']
        if getattr(self, 'shared_daemon', False) and thread_id not in self.loaded and thread.get('status', {}).get('type') in ('active','idle'):
            resumed = self.rpc('thread/resume', {'threadId': thread_id, 'excludeTurns': True})
            self.loaded.add(thread_id)
            self.settings[thread_id] = {k: resumed.get(k) for k in ('model','reasoningEffort','approvalPolicy','sandbox')}
        with self.lock:
            current_version = f"{self.generation}:{row.get('updated_at_ms', row.get('updated_at'))}:{self.revisions.get(thread_id, 0)}:{display['unavailable']}:{row.get('archived')}:{thread.get('status',{}).get('type')}"
        if not cursor and current_version == version:
            return {'unchanged': True, 'version': current_version}
        params = {'threadId': thread_id, 'limit': 3, 'itemsView': 'full', 'sortDirection': 'desc'}
        if cursor:
            params['cursor'] = cursor
        page = self.rpc('thread/turns/list', params)
        turns = list(reversed(page['data']))
        with self.lock:
            live = copy.deepcopy(self.live.get(thread_id))
            requests = [copy.deepcopy({k: v for k, v in r.items() if k != 'wireId'}) for r in self.approvals.values() if r['threadId'] == thread_id]
            settings = self.settings.get(thread_id, {})
        for pending in requests:
            item = (live or {}).get('items', {}).get(pending['params'].get('itemId'))
            if item:
                pending['details'] = normalize_item(item).get('text', '')
        if live and not cursor:
            live['items'] = list(live['items'].values())
            existing = next((i for i, t in enumerate(turns) if t['id'] == live['id']), None)
            if existing is None:
                turns.append(live)
            else:
                # Initial turn notifications need not repeat persisted items.
                persisted = {i['id']: i for i in turns[existing]['items']}
                persisted.update({i['id']: i for i in live['items']})
                live['items'] = list(persisted.values())
                turns[existing] = live
        active = bool(live and live['status'] == 'inProgress')
        active = active or thread.get('status', {}).get('type') == 'active'
        return {'version': current_version, 'activity': self.activity(), 'thread': {**display, 'model': settings.get('model') or thread.get('model') or row.get('model'),
                          'effort': settings.get('reasoningEffort') or thread.get('reasoningEffort') or row.get('reasoning_effort')},
                'turns': [normalize_turn(t) for t in turns], 'nextCursor': page.get('nextCursor'),
                'active': active, 'turnId': live['id'] if live and active else next((t['id'] for t in turns if t.get('status')=='inProgress'), None), 'requests': requests,
                'canSend': not display['unavailable'] and not row.get('archived'),
                'readOnlyReason': display['unavailable'] or ('Unarchive this chat in Codex before continuing.' if row.get('archived') else None)}

    def send(self, payload):
        thread_id = payload['threadId']
        text = payload.get('text', '').strip()
        files = attachments.selected(thread_id, payload.get('attachments', []))
        nonce = payload.get('nonce')
        if (not text and not files) or len(text) > 100000 or not isinstance(nonce, str) or len(nonce) > 100:
            raise ValueError('Enter a message of up to 100,000 characters.')
        with self.lock:
            thread_lock = self.thread_locks.setdefault(thread_id, threading.Lock())
        with thread_lock:
            key = (thread_id, nonce)
            if key in self.receipts:
                return self.receipts[key]
            row, display = self.metadata(thread_id)
            if display['unavailable'] or row.get('archived'):
                raise ValueError(display['unavailable'] or 'Unarchive this chat in Codex before continuing.')
            with self.lock:
                if self.live.get(thread_id, {}).get('status') == 'inProgress':
                    raise ValueError('This chat is already working. Stop it before sending another message.')
            if thread_id not in self.loaded:
                try:
                    resumed = self.rpc('thread/resume', {'threadId': thread_id, 'excludeTurns': True})
                except RpcError as error:
                    if 'active writer' in str(error):
                        raise ValueError('This chat is owned by another standalone Codex process. Close that chat there before continuing here.') from None
                    raise
                self.loaded.add(thread_id)
                self.settings[thread_id] = {k: resumed.get(k) for k in ('model', 'reasoningEffort', 'approvalPolicy', 'sandbox')}
            if getattr(self, 'shared_daemon', False):
                status = self.rpc('thread/read', {'threadId': thread_id})['thread'].get('status', {})
                if status.get('type') == 'active':
                    raise ValueError('This conversation is still working. Wait for the reply to finish before sending another message.')
            user_input = []
            if files:
                names = '\n'.join(f"- [{f['name']}](<{f['path']}>)" for f in files)
                text = (text+'\n\nAttached files (available on this machine):\n'+names).strip()
            if text:user_input.append({'type':'text','text':text})
            user_input.extend({'type':'localImage','path':f['path']} for f in files if f['kind']=='image')
            # Persist an uncertain receipt before the wire write. A timed-out
            # client must not cause the same message to be submitted twice.
            self.receipts[key] = {'accepted': False, 'uncertain': True}
            try:
                result = self.rpc('turn/start', {'threadId': thread_id, 'input': user_input,
                                                'clientUserMessageId': nonce})
            except RpcError:
                self.receipts.pop(key, None)
                raise
            result = {'accepted': True, 'turnId': result['turn']['id']}
            self.receipts[key] = result
            return result

    def models(self, thread_id):
        row, _ = self.metadata(thread_id)
        provider = row.get('model_provider')
        cached = self.model_cache.get(provider)
        if cached and time.monotonic()-cached[0] < 60:
            return cached[1]
        models, cursor = [], None
        while True:
            params = {'limit': 100, 'includeHidden': False}
            if provider: params['modelProvider'] = provider
            if cursor: params['cursor'] = cursor
            page = self.rpc('model/list', params)
            models.extend(page['data'])
            cursor = page.get('nextCursor')
            if not cursor: break
        self.model_cache[provider] = (time.monotonic(), models)
        return models

    def change_settings(self, payload):
        thread_id = payload['threadId']
        row, display = self.metadata(thread_id)
        if display['unavailable'] or row.get('archived'):
            raise ValueError(display['unavailable'] or 'Unarchive this chat before changing its settings.')
        model = next((m for m in self.models(thread_id) if m['model'] == payload.get('model')), None)
        if not model:
            raise ValueError('Choose a model offered by Codex for this provider.')
        effort = payload.get('effort') or model['defaultReasoningEffort']
        if effort not in [e['reasoningEffort'] for e in model['supportedReasoningEfforts']]:
            raise ValueError('That reasoning level is not supported by the selected model.')
        with self.lock:
            thread_lock = self.thread_locks.setdefault(thread_id, threading.Lock())
        with thread_lock:
            if thread_id not in self.loaded:
                resumed = self.rpc('thread/resume', {'threadId': thread_id, 'excludeTurns': True})
                self.loaded.add(thread_id)
                self.settings[thread_id] = {k: resumed.get(k) for k in ('model', 'reasoningEffort', 'approvalPolicy', 'sandbox')}
            self.rpc('thread/settings/update', {'threadId': thread_id, 'model': model['model'], 'effort': effort})
            with self.lock:
                self.settings.setdefault(thread_id, {}).update(model=model['model'], reasoningEffort=effort)
                self.revisions[thread_id] = self.revisions.get(thread_id, 0)+1
        return {'ok': True, 'model': model['model'], 'effort': effort}

    def answer(self, payload):
        with self.lock:
            entry = self.approvals.get(payload.get('requestId'))
            if not entry or entry['threadId'] != payload.get('threadId'):
                raise ValueError('This request has already been answered or is no longer pending.')
            entry = copy.deepcopy(entry)
        method, params = entry['method'], entry['params']
        action = payload.get('action')
        if method in ('item/commandExecution/requestApproval', 'item/fileChange/requestApproval'):
            if action not in ('accept', 'decline', 'cancel'):
                raise ValueError('Choose Allow once, Decline or Stop.')
            available = params.get('availableDecisions')
            if available is not None and action not in available:
                raise ValueError('That decision is not offered for this request.')
            result = {'decision': action}
        elif method == 'item/permissions/requestApproval':
            if action not in ('accept', 'decline'):
                raise ValueError('Invalid permission decision.')
            result = {'permissions': params['permissions'] if action == 'accept' else {}, 'scope': 'turn'}
        elif method in ('item/tool/requestUserInput', 'tool/requestUserInput'):
            answers = payload.get('answers') or {}
            expected = {q['id'] for q in params.get('questions', [])}
            if set(answers) != expected or any(not isinstance(v, str) or not v.strip() for v in answers.values()):
                raise ValueError('Answer every question before submitting.')
            result = {'answers': {key: {'answers': [value]} for key, value in answers.items()}}
        elif method == 'mcpServer/elicitation/request' and action in ('decline', 'cancel'):
            result = {'action': action, 'content': None}
        else:
            raise ValueError('This request is not supported by this chat view. Stop the turn and use Codex for it.')
        with self.lock:
            if entry['id'] not in self.approvals:
                raise ValueError('This request is no longer pending.')
            self._write({'id': entry['wireId'], 'result': result})
            self.approvals.pop(entry['id'], None)
            self.revisions[entry['threadId']] = self.revisions.get(entry['threadId'], 0) + 1
        return {'ok': True}

    def activity(self):
        with self.lock:
            waiting = {r['threadId'] for r in self.approvals.values()}
            return {key: 'blocked' if key in waiting else 'working' if turn['status'] == 'inProgress' else 'idle'
                    for key, turn in self.live.items()}

    def handle(self, payload):
        operation = payload.get('operation')
        if operation == 'health':
            return {'ok': not self.failure, 'error': self.failure}
        if operation == 'read':
            return self.read(payload['threadId'], payload.get('cursor'), payload.get('version'))
        if operation == 'activity':
            return self.activity()
        if operation == 'models':
            return {'models': self.models(payload['threadId'])}
        if operation == 'settings':
            return self.change_settings(payload)
        if operation == 'file':
            row, _ = self.metadata(payload['threadId'])
            result = preview_file(payload['path'], row.get('cwd') or str(Path.home()))
            if payload.get('metadataOnly'):result.pop('base64', None)
            return result
        if operation == 'file_chunk':
            row, _ = self.metadata(payload['threadId'])
            path, _ = preview_path(payload['path'], row.get('cwd') or str(Path.home()))
            if path.stat().st_size>5*1024*1024:raise ValueError('This file exceeds the preview limit.')
            offset = payload.get('offset',0)
            if not isinstance(offset,int) or offset<0:raise ValueError('Invalid file offset.')
            with path.open('rb') as file:
                file.seek(offset);data=file.read(32768)
            return {'base64':base64.b64encode(data).decode(),'offset':offset+len(data)}
        if operation.startswith('upload_'):
            self.metadata(payload['threadId'])
            return attachments.upload(payload)
        if operation == 'send':
            return self.send(payload)
        if operation == 'answer':
            return self.answer(payload)
        if operation == 'stop':
            with self.lock:
                live = self.live.get(payload['threadId'])
                turn_id = live['id'] if live and live['status']=='inProgress' else None
            if not turn_id and getattr(self,'shared_daemon',False):
                page=self.rpc('thread/turns/list',{'threadId':payload['threadId'],'limit':1,'itemsView':'notLoaded','sortDirection':'desc'})
                turn_id=next((t['id'] for t in page['data'] if t['status']=='inProgress'),None)
            if not turn_id:raise ValueError('This chat has no active turn.')
            return self.rpc('turn/interrupt', {'threadId': payload['threadId'], 'turnId': turn_id})
        raise ValueError('Unknown chat action.')


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(80)
        try:
            line = self.rfile.readline(MAX_REQUEST + 1)
            if len(line) > MAX_REQUEST:
                raise ValueError('Request is too large.')
            result = {'result': self.server.bridge.handle(json.loads(line))}
        except Exception as error:
            result = {'error': str(error)}
        try:
            self.wfile.write(json.dumps(result, ensure_ascii=False).encode() + b'\n')
        except (BrokenPipeError, ConnectionResetError):
            pass


class Service(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


def main():
    os.umask(0o077)
    SOCKET.unlink(missing_ok=True)
    with Service(str(SOCKET), Handler) as service:
        SOCKET.chmod(0o600)
        service.bridge = Bridge()
        def watch_child():
            service.bridge.process.wait()
            service.shutdown()
        threading.Thread(target=watch_child, daemon=True).start()
        service.serve_forever(poll_interval=0.5)
    sys.exit(1)  # systemd reconnects after an unexpected app-server exit.


if __name__ == '__main__':
    main()
