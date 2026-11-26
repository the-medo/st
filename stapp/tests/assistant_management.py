"""Real isolated daemon: Herdr continuation, owner access and endpoint management."""
import json
from contextlib import closing
import sqlite3
import sys
import uuid
from pathlib import Path
import unittest
import integration
from transport import rpc


class Management(integration.Daemon):
    def conversation(self, device='room'):
        self.ask(device, 'Synthetic note')
        job = rpc({'op': 'claim_job'}, 'owner')
        thread = str(uuid.uuid4())
        self.event(job, 'thread', thread)
        self.event(job, 'completed', 'Saved')
        return job, thread

    def test_herdr_followup_preserves_origin_and_deduplicates_after_restart(self):
        previous, thread = self.conversation()
        send = {'op': 'assistant_send', 'thread': thread, 'id': str(uuid.uuid4()), 'text': 'Change that note'}
        with self.assertRaises(ValueError): rpc(send, 'pc')
        first = rpc(send, 'owner')
        self.stop(); self.start()
        self.assertEqual(rpc(send, 'owner'), first)
        job = rpc({'op': 'claim_job'}, 'owner')
        self.assertEqual((job['device'], job['thread'], job['text']), ('room', thread, send['text']))
        with self.assertRaises(ValueError): rpc({**send, 'id': str(uuid.uuid4())}, 'owner')
        with self.assertRaises(ValueError): rpc({**send, 'text': 'Different'}, 'owner')
        self.event(job, 'completed', 'Changed')
        self.assertIsNone(rpc({'op': 'claim_job'}, 'owner'))
        self.assertEqual(rpc({'op': 'assistant_thread', 'thread': thread}, 'owner')['status'], 'completed')

    def test_answer_retry_cannot_answer_a_later_question(self):
        _, thread = self.conversation()
        rpc({'op':'assistant_send','thread':thread,'id':str(uuid.uuid4()),'text':'Need clarification'}, 'owner')
        job = rpc({'op': 'claim_job'}, 'owner')
        self.event(job, 'question', 'Which one?')
        state = rpc({'op':'assistant_thread','thread':thread}, 'owner')
        answer = {'op':'assistant_answer','thread':thread,'job':job['id'],'question':state['events'][-1]['seq'],'id':str(uuid.uuid4()),'text':'First'}
        rpc(answer, 'owner')
        self.assertEqual(self.event(job, 'poll'), 'First')
        self.event(job, 'question', 'Are you sure?')
        rpc(answer, 'owner')
        self.assertIsNone(self.event(job, 'poll'))
        with self.assertRaises(ValueError): rpc({**answer,'id':str(uuid.uuid4())}, 'owner')
        self.assertEqual(rpc({'op':'assistant_thread','thread':thread}, 'owner')['status'], 'waiting')

    def test_stop_is_bound_to_current_job_and_cancelled_thread_can_resume(self):
        old, thread = self.conversation()
        new = rpc({'op':'assistant_send','thread':thread,'id':str(uuid.uuid4()),'text':'Continue'}, 'owner')
        with self.assertRaises(ValueError): rpc({'op':'assistant_stop','thread':thread,'job':old['id']}, 'owner')
        stop = {'op':'assistant_stop','thread':thread,'job':new['id']}
        rpc(stop, 'owner');rpc(stop, 'owner')
        rpc({'op':'assistant_send','thread':thread,'id':str(uuid.uuid4()),'text':'Try something else'}, 'owner')
        self.assertEqual(rpc({'op':'claim_job'}, 'owner')['thread'], thread)

    def test_settings_revision_and_device_identity(self):
        with self.assertRaises(ValueError): rpc({'op':'assistant_status'}, 'pc')
        with self.assertRaises(ValueError): rpc({'op':'voice_sync','report':{}}, 'owner')
        rpc({'op':'voice_sync','target':'room','report':{'state':'idle','inputs':['Test mic']}}, 'pc')
        settings = {'op':'assistant_settings','target':'pc','revision':0,'settings':{'microphone':'Test mic','muted':True}}
        with self.assertRaises(ValueError): rpc(settings, 'room')
        rpc(settings, 'owner')
        with self.assertRaises(ValueError): rpc(settings, 'owner')
        with self.assertRaises(ValueError): rpc({**settings,'revision':1,'settings':{'token':'secret'}}, 'owner')
        synced = rpc({'op':'voice_sync','report':{}}, 'pc')
        self.assertEqual(synced['settings'], {'microphone':'Test mic','muted':True})
        self.assertEqual(rpc({'op':'voice_sync','report':{}}, 'room')['settings'], {})
        self.stop();self.start()
        self.assertEqual(rpc({'op':'voice_sync','report':{}}, 'pc')['revision'], 1)

    def test_commands_expire_and_receipts_are_scoped(self):
        command = {'op':'assistant_command','target':'pc','action':'test_recording','id':str(uuid.uuid4())}
        with self.assertRaises(ValueError): rpc(command, 'owner')
        rpc({'op':'voice_sync','report':{}}, 'pc')
        rpc(command, 'owner');rpc(command, 'owner')
        ack = {'id':command['id'],'result':{'status':'accepted'}}
        self.assertEqual(rpc({'op':'voice_sync','report':{},'acks':[ack]}, 'room')['commands'], [])
        self.assertEqual(len(rpc({'op':'voice_sync','report':{}}, 'pc')['commands']), 1)
        self.assertEqual(rpc({'op':'voice_sync','report':{},'acks':[ack]}, 'pc')['commands'], [])
        stale = {**command, 'id':str(uuid.uuid4()), 'action':'record'}
        rpc(stale, 'owner')
        with closing(sqlite3.connect(self.data/'stapp.sqlite')) as db:
            db.execute('UPDATE voice_commands SET created=unixepoch()-31 WHERE id=?', [stale['id']]);db.commit()
        self.assertEqual(rpc({'op':'voice_sync','report':{}}, 'pc')['commands'], [])
        self.assertIsNone(rpc({'op':'claim_job'}, 'owner'))

    def test_device_stop_cancels_server_jobs_before_delivery_without_replaying(self):
        queued = self.ask('room', 'Queued before delivery')
        rpc({'op':'voice_sync','report':{}}, 'room')
        stop = {'op':'assistant_command','target':'room','action':'stop','id':str(uuid.uuid4())}
        rpc(stop, 'owner')
        self.assertEqual(rpc({'op':'status','id':queued['id']}, 'room')['status'], 'cancelled')
        later = self.ask('room', 'A later intentional request')
        rpc(stop, 'owner')
        self.assertEqual(rpc({'op':'status','id':later['id']}, 'room')['status'], 'queued')


if __name__ == '__main__':
    unittest.main()
