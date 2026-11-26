import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from integrations.ovis.bridge.questions import unanswered


class QuestionHistoryTests(unittest.TestCase):
    def test_indexed_questions_survive_large_output_and_resolve_by_call_and_index(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            with sqlite3.connect(home / 'thread_history_1.sqlite') as db:
                db.execute('CREATE TABLE thread_items (thread_id, item_type, rollout_ordinal, item_json)')
                def add(thread, item):
                    db.execute('INSERT INTO thread_items VALUES (?, ?, ?, ?)',
                               (thread, item['type'], db.total_changes, json.dumps(item)))
                add('other', {'type': 'agentMessage', 'id': 'foreign', 'delivery': 'async', 'questions': [{'title': 'Foreign question'}]})
                add('chat', {'type': 'agentMessage', 'id': 'first', 'delivery': 'async', 'questions': [
                    {'title': 'Which default?', 'options': ['Active', 'All']}, {'title': 'Any notes?'}]})
                add('chat', {'type': 'commandExecution', 'aggregatedOutput': 'x' * 5_000_000})
                add('chat', {'type': 'agentMessage', 'id': 'second', 'delivery': 'async', 'questions': [{'title': 'Which default?', 'options': ['Active', 'All']}]})
                reply = [{'answer': 'Active', 'questionItemId': json.dumps(['request_user_input_async', 'first', 0])}]
                add('chat', {'type': 'userMessage', 'content': [{'type': 'text', 'text': '<send_user_message_question_reply>' + json.dumps(reply) + '</send_user_message_question_reply>'}]})
                add('chat', {'type': 'userMessage', 'content': [{'type': 'text', 'text': '<send_user_message_question_reply>bad JSON</send_user_message_question_reply>'}]})
            self.assertEqual(unanswered(home, 'chat'), [
                {'key': 'first:1', 'title': 'Any notes?', 'options': []},
                {'key': 'second:0', 'title': 'Which default?', 'options': ['Active', 'All']}])
            self.assertEqual(unanswered(home, 'unknown'), [])

    def test_read_only_connection_never_creates_a_missing_history(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            with self.assertRaises(sqlite3.OperationalError):
                unanswered(home, 'chat')
            self.assertEqual(list(home.iterdir()), [])
