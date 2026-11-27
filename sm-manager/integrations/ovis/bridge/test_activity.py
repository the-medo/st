from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from integrations.ovis.bridge import activity


class ActivityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.root = self.home / 'sidebar'
        self.rows = [{'id': 'chat', 'history_mode': 'paginated'}]
        self.history = self.home / 'thread_history_1.sqlite'
        with closing(sqlite3.connect(self.history)) as db, db:
            db.execute('''CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER,
                status TEXT, completed_at INTEGER, PRIMARY KEY (thread_id, turn_id))''')
        now = patch.object(activity.time, 'time', return_value=1000)
        now.start()
        self.addCleanup(now.stop)

    def turn(self, id, ordinal, status='completed', ended=1100, thread='chat'):
        with closing(sqlite3.connect(self.history)) as db, db:
            db.execute('INSERT OR REPLACE INTO thread_turns VALUES (?, ?, ?, ?, ?)', (thread, id, ordinal, status, ended))

    def snapshot(self, **chat):
        chats = [dict(id='chat', status='idle', **chat)]
        activity.observe(self.root, self.home, self.rows, chats)
        return chats[0]['activity']

    def read(self, turn):
        return activity.acknowledge(self.root, self.home, self.rows, 'chat', turn)['activity']

    def test_old_history_metadata_and_terminal_flaps_do_not_create_unreads(self):
        self.turn('old', 10, ended=100)
        initial = self.snapshot()
        self.assertFalse(initial['unread'])
        self.assertEqual(self.snapshot(updated=900000, title='Renamed'), initial)
        for status in ['working', 'idle', 'done', 'unknown', 'idle']:
            chats = [{'id': 'chat', 'status': status}]
            activity.observe(self.root, self.home, self.rows, chats)
            self.assertFalse(chats[0]['activity']['unread'])

    def test_new_turns_seen_or_missed_while_browser_closed_survive_restart(self):
        self.turn('old', 10, ended=100)
        self.snapshot()
        self.turn('new', 20)
        before = self.history.read_bytes()
        first_device = self.snapshot()
        self.assertTrue(first_device['unread'])
        second_device = self.snapshot()
        self.assertEqual(second_device, first_device)
        receipt = self.read('new')
        self.assertFalse(receipt['unread'])
        self.assertGreater(receipt['revision'], first_device['revision'])
        self.assertEqual(self.snapshot(), receipt)
        self.assertEqual(self.read('new'), receipt)
        self.assertEqual(self.history.read_bytes(), before)
        self.assertEqual((self.root/'conversation-activity.sqlite3').stat().st_mode & 0o777, 0o600)

    def test_late_read_never_acknowledges_a_newer_completion(self):
        self.turn('a', 10)
        self.snapshot()
        self.turn('b', 20)
        late = self.read('a')
        self.assertTrue(late['unread'])
        self.assertEqual(late['completionId'], 'b')
        self.read('b')
        self.assertFalse(self.read('a')['unread'])

    def test_simultaneous_devices_and_catalogues_keep_the_receipt(self):
        self.turn('a', 10)
        self.snapshot()
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda index: self.read('a') if index % 2 else self.snapshot(), range(16)))
        self.assertFalse(self.snapshot()['unread'])

    def test_native_working_state_is_shared_and_not_a_false_completion(self):
        self.turn('a', 10, status='inProgress', ended=None)
        self.assertEqual(self.snapshot()['status'], 'working')
        self.assertFalse(self.snapshot()['unread'])
        chats = [{'id': 'chat', 'status': 'blocked'}]
        activity.observe(self.root, self.home, self.rows, chats)
        self.assertEqual(chats[0]['activity']['status'], 'blocked')
        self.turn('a', 10)
        self.assertTrue(self.snapshot()['unread'])
        self.assertEqual(self.read('a')['status'], 'idle')

    def test_no_timestamp_and_missing_history_are_not_guessed_as_new(self):
        self.turn('old', 10, ended=None)
        self.assertFalse(self.snapshot()['unread'])
        self.turn('new', 20, ended=None)
        self.assertTrue(self.snapshot()['unread'])
        self.read('new')
        self.history.unlink()
        with self.assertRaises(sqlite3.Error):
            self.snapshot()
        self.assertFalse(self.history.exists())
        with closing(sqlite3.connect(self.root/'conversation-activity.sqlite3')) as db:
            self.assertEqual(db.execute('SELECT read_ordinal FROM conversation_activity').fetchone()[0], 20)

    def test_an_ended_terminal_does_not_leave_the_conversation_working(self):
        self.turn('a', 10, status='inProgress', ended=None)
        self.assertEqual(self.snapshot()['status'], 'working')
        self.turn('a', 10)
        chats = [{'id': 'chat'}]  # no live terminal in the next catalogue
        activity.observe(self.root, self.home, self.rows, chats)
        self.assertEqual(chats[0]['activity']['status'], 'done')
        self.assertEqual(self.read('a')['status'], 'idle')
        self.turn('b', 20, status='inProgress', ended=None)
        blocked = [{'id': 'chat', 'status': 'blocked'}]
        activity.observe(self.root, self.home, self.rows, blocked)
        self.assertEqual(self.read('a')['status'], 'blocked')

    def test_damaged_and_future_state_are_not_overwritten(self):
        self.snapshot()
        path = self.root/'conversation-activity.sqlite3'
        with closing(sqlite3.connect(path)) as db, db:
            db.execute('PRAGMA user_version=99')
        before = path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'newer'):
            self.snapshot()
        self.assertEqual(path.read_bytes(), before)
        path.write_bytes(b'not a database')
        with self.assertRaises(sqlite3.Error):
            self.snapshot()
        self.assertEqual(path.read_bytes(), b'not a database')

    def test_failed_turns_and_separate_threads(self):
        self.turn('failed', 10, status='failed')
        self.assertTrue(self.snapshot()['unread'])
        self.read('failed')
        self.turn('other', 20, thread='other')
        rows = self.rows + [{'id': 'other', 'history_mode': 'paginated'}]
        chats = [{'id': 'chat'}, {'id': 'other', 'archived': True}]
        activity.observe(self.root, self.home, rows, chats)
        self.assertFalse(chats[0]['activity']['unread'])
        self.assertTrue(chats[1]['activity']['unread'])
        with self.assertRaises(ValueError):
            activity.acknowledge(self.root, self.home, rows, 'missing', 'other')


if __name__ == '__main__':
    unittest.main()
