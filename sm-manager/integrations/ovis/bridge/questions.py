"""Read question metadata from Codex's indexed history, never change its state.

This is candidate text for a *visible* terminal queue. The terminal's count and
the existing answer-time screen checks remain authoritative (skips aren't saved).
"""
from contextlib import closing
import json
import re
import sqlite3


def unanswered(home, thread):
    asked, answered = {}, set()
    database = home / 'thread_history_1.sqlite'
    with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=2)) as conn:
        conn.execute('PRAGMA query_only=ON')
        # Use the thread index; tool output size and rollout rotation cannot hide
        # older questions. Do not load command output or other threads' messages.
        rows = conn.execute('''SELECT item_json FROM thread_items
            WHERE thread_id=? AND item_type IN ('agentMessage', 'userMessage')
            ORDER BY rollout_ordinal''', (thread,))
        for (raw,) in rows:
            item = json.loads(raw)
            if item.get('type') == 'agentMessage' and item.get('delivery') == 'async':
                for index, question in enumerate(item.get('questions') or []):
                    title = question.get('title')
                    options = question.get('options') or []
                    if not isinstance(title, str) or not isinstance(options, list) or not all(isinstance(option, str) for option in options):
                        continue
                    key = (item['id'], index)
                    asked[key] = {'key': f'{key[0]}:{index}', 'title': title, 'options': options}
            elif item.get('type') == 'userMessage':
                text = '\n'.join(part.get('text', '') for part in item.get('content', []) if part.get('type') == 'text')
                match = re.fullmatch(r'\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*</send_user_message_question_reply>\s*', text)
                if not match:
                    continue
                try:
                    replies = json.loads(match[1])
                    if not isinstance(replies, list):
                        continue
                    for reply in replies:
                        identity = json.loads(reply.get('questionItemId', 'null'))
                        if (isinstance(identity, list) and len(identity) == 3
                                and identity[0] == 'request_user_input_async'
                                and isinstance(identity[1], str) and type(identity[2]) is int):
                            answered.add((identity[1], identity[2]))
                except (ValueError, TypeError, AttributeError):
                    continue
    return [question for key, question in asked.items() if key not in answered]
