import json
import base64
import hashlib
import uuid
from pathlib import Path
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, patch

from integrations.ovis.bridge import chat_service
from integrations.ovis.bridge import attachments
from integrations.ovis.bridge import organization


class FolderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.projects = {'a', 'b'}
        self.chats = {'chat-a': 'a', 'chat-b': 'b'}

    def change(self, project, operation, **values):
        return organization.update(self.root, self.projects, self.chats,
                                   dict(projectId=project, operation=operation, **values))

    def test_folders_are_project_scoped(self):
        a = self.change('a', 'create', name='Ideas')['folder']['id']
        b = self.change('b', 'create', name='Ideas')['folder']['id']
        self.assertNotEqual(a, b)
        self.change('a', 'move', threadId='chat-a', folderId=a)
        with self.assertRaises(ValueError): self.change('a', 'move', threadId='chat-a', folderId=b)
        with self.assertRaises(ValueError): self.change('a', 'move', threadId='chat-b', folderId=a)
        self.change('a', 'rename', folderId=a, name='Backlog')
        state = organization.load(self.root)
        self.assertEqual(state['projects']['a']['folders'][0]['name'], 'Backlog')
        self.assertEqual(state['projects']['b']['folders'][0]['name'], 'Ideas')

    def test_removal_keeps_chats_unfiled(self):
        folder = self.change('a', 'create', name='Ideas')['folder']['id']
        self.change('a', 'move', threadId='chat-a', folderId=folder)
        self.change('a', 'delete', folderId=folder)
        state = organization.load(self.root)['projects']['a']
        self.assertEqual(state, {'folders': [], 'chats': {}})
        self.assertEqual(self.chats, {'chat-a': 'a', 'chat-b': 'b'})

    def test_duplicate_and_stale_names(self):
        self.change('a', 'create', name='Ideas')
        with self.assertRaises(ValueError): self.change('a', 'create', name=' ideas ')
        with self.assertRaises(ValueError): self.change('a', 'rename', folderId='deleted', name='New')


class ProjectOrderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.projects = ['a', 'b', 'c', 'd']

    def move(self, project, relative, direction):
        return organization.update(self.root, self.projects, {}, dict(operation='move-project', projectId=project, relativeTo=relative, direction=direction))

    def test_moves_persist_and_leave_folders_and_chat_membership_intact(self):
        folder = organization.update(self.root, self.projects, {}, dict(operation='create', projectId='a', name='Ideas'))['folder']['id']
        organization.update(self.root, self.projects, {'chat':'a'}, dict(operation='move', projectId='a', threadId='chat', folderId=folder))
        before = organization.load(self.root)['projects']
        self.assertEqual(self.move('c', 'b', 'up')['projectOrder'], ['a', 'c', 'b', 'd'])
        self.assertEqual(self.move('a', 'c', 'down')['projectOrder'], ['c', 'a', 'b', 'd'])
        saved = organization.load(self.root)
        self.assertEqual(organization.project_order(saved, self.projects), ['c', 'a', 'b', 'd'])
        self.assertEqual(saved['projects'], before)
        self.assertEqual((self.root/'organization.json').stat().st_mode & 0o777, 0o600)

    def test_repeated_moves_are_idempotent_and_stale_ids_cannot_overwrite_order(self):
        result = self.move('b', 'a', 'up')
        self.assertEqual(self.move('b', 'a', 'up'), result)
        for project, relative, direction in [('gone','a','up'), ('a','gone','down'), ('a','a','up'), ('a','b','sideways')]:
            with self.subTest(project=project, relative=relative, direction=direction), self.assertRaises(ValueError):
                self.move(project, relative, direction)
        self.assertEqual(organization.load(self.root)['projectOrder'], result['projectOrder'])

    def test_new_projects_append_and_removed_projects_are_ignored(self):
        saved = {'projectOrder':['b', 'gone', 'b', 'a']}
        self.assertEqual(organization.project_order(saved, ['a','b','new','other']), ['b','a','new','other'])
        self.assertEqual(organization.project_order({}, ['b','a']), ['b','a'])

    def test_simultaneous_moves_preserve_both_changes(self):
        barrier = threading.Barrier(2)
        def move(pair):
            barrier.wait(timeout=2)
            return self.move(*pair, 'up')
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(move, [('b','a'), ('d','c')]))
        self.assertEqual(organization.load(self.root)['projectOrder'], ['b','a','d','c'])


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.bridge = object.__new__(chat_service.Bridge)
        self.bridge.lock = threading.RLock()
        self.bridge.live = {}
        self.bridge.approvals = {}
        self.bridge.loaded = set()
        self.bridge.settings = {}
        self.bridge.thread_locks = {}
        self.bridge.receipts = {}
        self.bridge.revisions = {}
        self.bridge.model_cache = {}
        self.bridge._write = Mock()
        self.bridge.rpc = Mock(return_value={'turn': {'id': 'turn-1'}})
        self.bridge.metadata = Mock(return_value=({'archived': 0}, {'unavailable': None}))

    def test_streamed_text_and_completion(self):
        b = self.bridge
        b.event({'method': 'turn/started', 'params': {'threadId': 't', 'turn': {'id': 'turn-1', 'items': []}}})
        b.event({'method': 'item/started', 'params': {'threadId': 't', 'turnId': 'turn-1', 'item': {'id': 'm', 'type': 'agentMessage', 'text': ''}}})
        for delta in ['Hello', ' world']:
            b.event({'method': 'item/agentMessage/delta', 'params': {'threadId': 't', 'itemId': 'm', 'delta': delta}})
        self.assertEqual(b.live['t']['items']['m']['text'], 'Hello world')
        b.event({'method': 'turn/completed', 'params': {'threadId': 't', 'turn': {'id': 'turn-1', 'status': 'completed'}}})
        self.assertEqual(b.activity()['t'], 'idle')

    def test_approval_is_explicit_and_answered_once(self):
        b = self.bridge
        b.event({'id': 7, 'method': 'item/commandExecution/requestApproval', 'params': {'threadId': 't', 'availableDecisions': ['accept', 'decline']}})
        b._write.assert_not_called()
        with self.assertRaises(ValueError): b.answer({'threadId': 'other', 'requestId': '7', 'action': 'accept'})
        b.answer({'threadId': 't', 'requestId': '7', 'action': 'accept'})
        b._write.assert_called_once_with({'id': 7, 'result': {'decision': 'accept'}})
        with self.assertRaises(ValueError): b.answer({'threadId': 't', 'requestId': '7', 'action': 'accept'})

    def test_unoffered_approval_is_rejected(self):
        b = self.bridge
        b.event({'id': 'request', 'method': 'item/commandExecution/requestApproval', 'params': {'threadId': 't', 'availableDecisions': ['decline']}})
        with self.assertRaises(ValueError): b.answer({'threadId': 't', 'requestId': '"request"', 'action': 'accept'})
        b._write.assert_not_called()

    def test_questions_require_all_answers(self):
        b = self.bridge
        b.event({'id': 9, 'method': 'item/tool/requestUserInput', 'params': {'threadId': 't', 'questions': [{'id': 'choice'}]}})
        with self.assertRaises(ValueError): b.answer({'threadId': 't', 'requestId': '9', 'answers': {}})
        b.answer({'threadId': 't', 'requestId': '9', 'answers': {'choice': 'First'}})
        b._write.assert_called_once_with({'id': 9, 'result': {'answers': {'choice': {'answers': ['First']}}}})

    def test_duplicate_send_is_not_repeated(self):
        b = self.bridge
        b.loaded.add('t')
        payload = {'threadId': 't', 'text': 'hello', 'nonce': 'unique'}
        self.assertEqual(b.send(payload), b.send(payload))
        b.rpc.assert_called_once()
        self.assertNotIn('approvalPolicy', b.rpc.call_args.args[1])

    def test_existing_daemon_thread_resumes_without_a_second_writer(self):
        b = self.bridge
        b.shared_daemon = True
        b.rpc.side_effect = [
            {'model': 'existing-model'},
            {'thread': {'status': {'type': 'idle'}}},
            {'turn': {'id': 'continued-turn'}}]
        result = b.send({'threadId': 't', 'text': 'Continue', 'nonce': 'resume'})
        self.assertEqual(result['turnId'], 'continued-turn')
        self.assertEqual([c.args[0] for c in b.rpc.call_args_list], ['thread/resume', 'thread/read', 'turn/start'])
        self.assertNotIn('model', b.rpc.call_args.args[1])

    def test_shared_thread_already_working_rejects_send(self):
        b = self.bridge
        b.shared_daemon = True
        b.loaded.add('t')
        b.rpc.return_value = {'thread': {'status': {'type': 'active'}}}
        with self.assertRaisesRegex(ValueError, 'still working'):
            b.send({'threadId': 't', 'text': 'Continue', 'nonce': 'busy'})
        b.rpc.assert_called_once_with('thread/read', {'threadId': 't'})
        self.assertEqual(b.receipts, {})

    def test_uploaded_image_history_has_chips_without_transport_text(self):
        path = str(attachments.ROOT/'thread'/'image.png')
        item = chat_service.normalize_item({'id':'u','type':'userMessage','content':[
            {'type':'text','text':f'Compare this.\n\nAttached files (available on this machine):\n- [image.png](<{path}>)'},
            {'type':'localImage','path':path}]})
        self.assertEqual(item['text'], 'Compare this.')
        self.assertEqual(item['attachments'], [{'name':'image.png','path':path}])

    def test_failed_rpc_can_retry_but_timeout_cannot_duplicate(self):
        b = self.bridge
        b.loaded.add('t')
        payload = {'threadId': 't', 'text': 'hello', 'nonce': 'unique'}
        b.rpc.side_effect = chat_service.RpcError('Invalid request')
        with self.assertRaises(chat_service.RpcError): b.send(payload)
        self.assertNotIn(('t', 'unique'), b.receipts)
        b.rpc.side_effect = RuntimeError('Timed out')
        with self.assertRaises(RuntimeError): b.send(payload)
        self.assertTrue(b.send(payload)['uncertain'])
        self.assertEqual(b.rpc.call_count, 2)

    def test_stop_targets_the_active_turn(self):
        b = self.bridge
        b.live['t'] = {'id': 'turn-1', 'status': 'inProgress'}
        b.handle({'operation': 'stop', 'threadId': 't'})
        b.rpc.assert_called_once_with('turn/interrupt', {'threadId': 't', 'turnId': 'turn-1'})

    def test_only_reasoning_summary_is_displayed(self):
        item = chat_service.normalize_item({'id': 'r', 'type': 'reasoning', 'summary': ['Public summary'], 'content': ['Private reasoning']})
        self.assertEqual(item['text'], 'Public summary')
        self.assertNotIn('Private', json.dumps(item))

    def test_settings_change_is_scoped_and_does_not_start_a_turn(self):
        b = self.bridge
        b.loaded.add('t')
        b.settings['t'] = {'approvalPolicy': 'on-request', 'sandbox': {'type': 'readOnly'}}
        b.models = Mock(return_value=[{'model': 'available', 'defaultReasoningEffort': 'low',
                                      'supportedReasoningEfforts': [{'reasoningEffort': 'low'}, {'reasoningEffort': 'high'}]}])
        result = b.change_settings({'threadId': 't', 'model': 'available', 'effort': 'high'})
        b.rpc.assert_called_once_with('thread/settings/update', {'threadId': 't', 'model': 'available', 'effort': 'high'})
        self.assertEqual(result['effort'], 'high')
        self.assertEqual(b.settings['t']['approvalPolicy'], 'on-request')
        self.assertEqual(b.settings['t']['sandbox'], {'type': 'readOnly'})
        with self.assertRaises(ValueError): b.change_settings({'threadId': 't', 'model': 'invented'})
        with self.assertRaises(ValueError): b.change_settings({'threadId': 't', 'model': 'available', 'effort': 'impossible'})
        self.assertEqual(b.rpc.call_count, 1)

    def test_model_catalog_pages_and_keeps_provider(self):
        b = self.bridge
        b.metadata.return_value = ({'model_provider': 'custom'}, {})
        b.rpc.side_effect = [{'data': [{'model': 'a'}], 'nextCursor': 'next'}, {'data': [{'model': 'b'}]}]
        self.assertEqual(b.models('t'), [{'model': 'a'}, {'model': 'b'}])
        self.assertEqual(b.rpc.call_args_list[1].args[1]['cursor'], 'next')
        self.assertEqual(b.rpc.call_args_list[1].args[1]['modelProvider'], 'custom')
        b.models('t')
        self.assertEqual(b.rpc.call_count, 2)

    def test_turn_timing_and_message_phases_survive_normalization(self):
        turn = chat_service.normalize_turn({'id': 't', 'status': 'completed', 'startedAt': 100, 'completedAt': 162, 'durationMs': 62000,
            'items': [{'id': 'p', 'type': 'agentMessage', 'phase': 'commentary', 'text': 'Working'},
                      {'id': 'f', 'type': 'agentMessage', 'phase': 'final_answer', 'text': 'Done'}]})
        self.assertEqual(turn['durationMs'], 62000)
        self.assertEqual([i['phase'] for i in turn['items']], ['commentary', 'final_answer'])

    def test_desktop_attachment_wrapper_becomes_file_chips(self):
        text = '# Files mentioned by the user:\n\n## screenshot.png: /home/example/screenshot.png\nImage attachment: true\n\n## My request:\nPlease compare these.\n[image]'
        item = chat_service.normalize_item({'id':'u','type':'userMessage','content':[{'type':'text','text':text}]})
        self.assertEqual(item['text'], 'Please compare these.')
        self.assertEqual(item['attachments'], [{'name':'screenshot.png','path':'/home/example/screenshot.png'}])


class FilePreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_remote_image_and_text_line_links(self):
        image = self.root/'preview image.png'
        image.write_bytes(b'\x89PNG\r\n\x1a\n'+b'image payload')
        result = chat_service.preview_file(image.as_uri(), str(self.root))
        self.assertEqual(result['kind'], 'image')
        self.assertRegex(result['cacheName'], r'^[a-f0-9]{64}\.png$')
        text = self.root/'example.txt'; text.write_text('first\nsecond\nthird')
        result = chat_service.preview_file(str(text)+':2', str(self.root))
        self.assertEqual(result['line'], 2)
        self.assertIn('   2  second', result['text'])
        self.assertEqual(chat_service.preview_file('example.txt#L3', str(self.root))['line'], 3)

    def test_missing_and_unsupported_files_fail_clearly(self):
        with self.assertRaises(FileNotFoundError): chat_service.preview_file('missing.png', str(self.root))
        with self.assertRaises(ValueError): chat_service.preview_file('https://example.org/file', str(self.root))
        with self.assertRaises(ValueError): chat_service.preview_file(str(self.root), str(self.root))
        p = self.root/'binary.bin'; p.write_bytes(b'\x00\xff')
        with self.assertRaisesRegex(ValueError, 'file type'): chat_service.preview_file(str(p), str(self.root))


class AttachmentTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        root_patch = patch.object(attachments, 'ROOT', self.root)
        root_patch.start()
        self.addCleanup(root_patch.stop)
        self.thread = str(uuid.uuid4())

    def start(self, data, name='example.txt'):
        return attachments.upload({'operation':'upload_start','threadId':self.thread,'name':name,
                                   'size':len(data),'sha256':hashlib.sha256(data).hexdigest()})['id']

    def chunk(self, id, data, offset=0):
        return attachments.upload({'operation':'upload_chunk','threadId':self.thread,'attachmentId':id,
                                   'offset':offset,'base64':base64.b64encode(data).decode()})

    def finish(self, id):
        return attachments.upload({'operation':'upload_finish','threadId':self.thread,'attachmentId':id})

    def test_files_preserve_bytes_and_cannot_overwrite_upload_metadata(self):
        for name in ('metadata.json','lock','upload.part','photo.png'):
            with self.subTest(name=name):
                data = b'\x89PNG\r\n\x1a\nexact bytes'
                id = self.start(data, name)
                self.chunk(id, data[:8])
                self.chunk(id, data[8:], 8)
                result = self.finish(id)
                self.assertEqual(Path(result['path']).read_bytes(), data)
                self.assertEqual(result['kind'], 'image')
                self.assertEqual(self.finish(id), result)
                self.assertEqual(attachments.selected(self.thread, [id]), [result])
                self.assertEqual(Path(result['path']).stat().st_mode & 0o777, 0o600)

    def test_offset_integrity_and_incomplete_uploads_are_rejected(self):
        id = self.start(b'abc')
        with self.assertRaisesRegex(ValueError, 'not ready'):
            attachments.selected(self.thread, [id])
        with self.assertRaisesRegex(ValueError, 'position mismatch'):
            self.chunk(id, b'a', 1)
        with self.assertRaisesRegex(ValueError, 'exceeds'):
            self.chunk(id, b'abcd')
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            self.finish(id)
        self.chunk(id, b'xyz')
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            self.finish(id)

    def test_attachments_are_scoped_to_the_selected_thread(self):
        id = self.start(b'')
        self.finish(id)
        with self.assertRaises(FileNotFoundError):
            attachments.selected(str(uuid.uuid4()), [id])
        with self.assertRaises(ValueError):
            attachments.selected(self.thread, ['../../metadata.json'])
        with self.assertRaisesRegex(ValueError, 'eight'):
            attachments.selected(self.thread, [id]*9)


if __name__ == '__main__': unittest.main()
