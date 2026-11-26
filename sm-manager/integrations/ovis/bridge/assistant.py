"""Resume assistant conversations through ST's durable job coordinator."""
import json
from pathlib import Path
import uuid
from sm_manager.assistant import data_dir, rpc


def owns(row):
    return Path(row.get('cwd') or '.').resolve() == (data_dir() / 'assistant').resolve()


def state(thread):
    return rpc({'op': 'assistant_thread', 'thread': thread})


def threads():
    try:
        return set(rpc({'op': 'assistant_threads'}))
    except (OSError, ValueError):
        return None


def action(payload):
    operation = payload['operation']
    thread = payload['threadId']
    uuid.UUID(thread)
    if operation == 'assistant_state':
        return state(thread)
    nonce = payload.get('nonce', '')
    if operation in ('send', 'answer'):
        if not isinstance(nonce, str) or not 1 <= len(nonce) <= 100:
            raise ValueError('Supply a retry ID for this message')
        identifier = str(uuid.uuid5(uuid.NAMESPACE_URL, f'st-assistant:{thread}:{operation}:{nonce}'))
    if operation == 'send':
        result = rpc({'op': 'assistant_send', 'thread': thread, 'id': identifier, 'text': payload.get('text')})
        return {'ok': True, 'turnId': result['id'], 'requestId': result['id']}
    if operation == 'answer':
        return rpc({'op': 'assistant_answer', 'thread': thread, 'id': identifier,
                    'job': payload.get('job'), 'question': payload.get('question'), 'text': payload.get('text')})
    if operation == 'stop':
        return rpc({'op': 'assistant_stop', 'thread': thread, 'job': payload.get('job')})
    raise ValueError('Unsupported assistant action')


def decorate(result, current):
    """Present the human answer, and a queued request before Codex persists its turn."""
    for turn in result['turns']:
        for item in turn['items']:
            if item.get('role') == 'assistant':
                try:
                    structured = json.loads(item.get('text', ''))
                    if isinstance(structured.get('display_text'), str) and 'speech_text' in structured:
                        item['text'] = structured['display_text']
                except (ValueError, TypeError, AttributeError):
                    pass
    if not current:
        return result
    active = current['status'] in ('queued', 'running', 'waiting')
    result.update(assistant=current, active=active, turnId=current['id'] if active else None)
    result['version'] += ':' + str(current['events'][-1]['seq'] if current['events'] else 0) + ':' + current['status']
    if current['status'] == 'queued':
        result['turns'].append({'id': 'queued:' + current['id'], 'status': 'inProgress', 'items': [
            {'id': current['id'], 'role': 'user', 'kind': 'userMessage', 'text': current['text']}]})
    if current['status'] == 'waiting':
        question = next((e for e in reversed(current['events']) if e['kind'] == 'question'), None)
        if question:
            result['requests'] = [{'id': f"st:{current['id']}:{question['seq']}", 'threadId': current['thread'],
                'method': 'item/tool/requestUserInput', 'params': {'questions': [
                    {'id': 'answer', 'header': 'Assistant', 'question': question['text'], 'options': []}]}}]
    return result
