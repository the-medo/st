"""No real terminals, Codex RPCs or user files are touched by these tests."""
import importlib.util
import json
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch, Mock
from pathlib import Path

spec=importlib.util.spec_from_file_location('medo_bridge',Path(__file__).with_name('medo-bridge.py'))
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)

class LaunchPermissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'ovis'
        self.state.mkdir()
        self.project = {'id': 'fixture', 'name': 'Fixture', 'path': str(self.root)}
        self.environment = patch.dict(os.environ, {'OVIS_STATE_DIR': str(self.state)})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        catalog_root = patch.object(bridge.sidebar, 'ROOT', self.root)
        catalog_root.start()
        self.addCleanup(catalog_root.stop)

    def save_mode(self, mode):
        (self.state / 'preferences.json').write_text(json.dumps({'settings': {'codexLaunchMode': mode}}))

    def launched_args(self, thread=None):
        with patch.object(bridge, 'Bridge', return_value=Mock()), patch.object(bridge.sidebar, 'read_rows', return_value=[]), patch.object(bridge.sidebar, 'hc', side_effect=lambda *args:
            {'address': 'fixture-pane'} if args[0] == 'run' else {'terminals': []}) as hc:
            bridge.launch(self.project, thread)
        command = hc.call_args.args
        return command[command.index('--') + 1:]

    def test_new_conversations_honor_the_saved_permission_preset(self):
        for mode, sandbox, approvals in [('fullAccess', 'danger-full-access', 'never'),
                                         ('readOnly', 'read-only', 'on-request'),
                                         ('auto', 'workspace-write', 'on-request')]:
            with self.subTest(mode=mode):
                self.save_mode(mode)
                args = self.launched_args()
                self.assertEqual(args[args.index('--sandbox') + 1], sandbox)
                self.assertEqual(args[args.index('--ask-for-approval') + 1], approvals)

    def test_agent_default_and_missing_preferences_leave_codex_in_control(self):
        for mode in [None, 'default']:
            with self.subTest(mode=mode):
                if mode is not None: self.save_mode(mode)
                args = self.launched_args()
                self.assertNotIn('--sandbox', args)
                self.assertNotIn('--ask-for-approval', args)

    def test_resuming_keeps_the_conversations_existing_permissions(self):
        self.save_mode('fullAccess')
        args = self.launched_args('saved-thread')
        self.assertIn('resume', args)
        self.assertNotIn('--sandbox', args)
        self.assertNotIn('--ask-for-approval', args)

    def test_invalid_preferences_do_not_launch_with_unintended_permissions(self):
        for mode in ['unknown', ['fullAccess']]:
            with self.subTest(mode=mode):
                self.save_mode(mode)
                with patch.object(bridge.sidebar, 'hc') as hc, self.assertRaises(ValueError):
                    bridge.launch(self.project)
                hc.assert_not_called()

class RenameTests(unittest.TestCase):
    thread = '01234567-1234-1234-1234-123456789abc'

    def test_rename_updates_the_native_name_without_starting_a_turn_or_terminal(self):
        client = Mock()
        # A missing checkout does not stop a saved conversation from being renamed.
        with patch.object(bridge.sidebar, 'read_rows', return_value=[{'id':self.thread, 'cwd':'/missing-checkout'}]), \
             patch.object(bridge, 'Bridge', return_value=client), patch.object(bridge.sidebar, 'hc') as hc:
            result = bridge.handle({'operation':'rename', 'threadId':self.thread, 'name':'  New\n conversation 🛠  '})
        self.assertEqual(result, {'ok':True, 'title':'New conversation 🛠'})
        client.rpc.assert_called_once_with('thread/name/set', {'threadId':self.thread, 'name':'New conversation 🛠'})
        client.process.terminate.assert_called_once_with()
        hc.assert_not_called()

    def test_bad_names_and_unknown_or_archived_threads_do_not_reach_codex(self):
        with patch.object(bridge, 'Bridge') as connect, patch.object(bridge.sidebar, 'read_rows', return_value=[{'id':self.thread}]) as rows:
            for name in [None, 42, '', ' \n ', 'x'*141, 'bad\x00name']:
                with self.subTest(name=name), self.assertRaises(ValueError):
                    bridge.handle({'operation':'rename', 'threadId':self.thread, 'name':name})
            for thread in [None, 'not-a-thread', '00000000-0000-4000-8000-000000000000']:
                with self.subTest(thread=thread), self.assertRaises(ValueError):
                    bridge.handle({'operation':'rename', 'threadId':thread, 'name':'New name'})
            rows.return_value = [{'id':self.thread, 'archived':True}]
            with self.assertRaisesRegex(ValueError, 'Unarchive'):
                bridge.handle({'operation':'rename', 'threadId':self.thread, 'name':'New name'})
            connect.assert_not_called()

    def test_codex_error_is_reported_and_its_client_connection_is_closed(self):
        client = Mock()
        client.rpc.side_effect = RuntimeError('Name could not be saved')
        with patch.object(bridge.sidebar, 'read_rows', return_value=[{'id':self.thread}]), \
             patch.object(bridge, 'Bridge', return_value=client), self.assertRaisesRegex(RuntimeError, 'Name could not be saved'):
            bridge.handle({'operation':'rename', 'threadId':self.thread, 'name':'New name'})
        client.process.terminate.assert_called_once_with()


class QuestionIdentityTests(unittest.TestCase):
    def test_uses_only_the_live_owned_threads_indexed_history(self):
        first = '01234567-1234-1234-1234-123456789abc'
        second = 'fedcba98-1234-1234-1234-123456789abc'
        terminal = {'foreground': {'name': 'codex'}, 'title': first,
                    'labels': {'medo.ovis.project': 'fixture', 'medo.ovis.resume': second}}
        rows = [{'id': first, 'history_mode': 'paginated'}, {'id': second, 'history_mode': 'paginated'}]
        with patch.object(bridge.sidebar, 'hc', return_value=terminal), patch.object(bridge.sidebar, 'read_rows', return_value=rows), \
                patch.object(bridge.questions, 'unanswered', return_value=[]) as read:
            self.assertEqual(bridge.handle({'operation': 'questions', 'paneId': 't1'}), {'historyId': 'medo:' + first, 'questions': []})
            read.assert_called_once_with(bridge.sidebar.CODEX_HOME, first)
            read.reset_mock()
            for title, foreground, labels in [('', 'codex', terminal['labels']), (first, 'bash', terminal['labels']), (first, 'codex', {})]:
                terminal.update(title=title, foreground={'name': foreground}, labels=labels)
                self.assertIsNone(bridge.handle({'operation': 'questions', 'paneId': 't1'}))
            read.assert_not_called()


class HistoryTests(unittest.TestCase):
    @patch.object(bridge.sidebar, 'checked_thread', return_value=({'cwd':'/synthetic/project'}, {}))
    def test_paging_keeps_the_read_window_when_new_turns_arrive(self, checked):
        pages={None:{'version':'v','thread':{'id':'chat'},'turns':[{'id':'4'},{'id':'5'},{'id':'6'}],'nextCursor':'old'},
               'old':{'version':'v','thread':{'id':'chat'},'turns':[{'id':'1'},{'id':'2'},{'id':'3'}],'nextCursor':None}}
        with patch.object(bridge,'request',side_effect=lambda p:pages[p.get('cursor')].copy()):
            newest=bridge.history('chat',{})
            older=bridge.history('chat',{'before':newest['ovisCursor']})
            self.assertEqual([t['id'] for t in older['turns']],['1','2','3'])
            self.assertIsNone(older['ovisCursor'])
            pages[None]['turns']=[{'id':'5'},{'id':'6'},{'id':'7'}]
            pages['old']['turns']=[{'id':'2'},{'id':'3'},{'id':'4'}]
            held=bridge.history('chat',{'from':newest['ovisCursor']})
            self.assertEqual([t['id'] for t in held['turns']],['4','5','6','7'])
            self.assertEqual(held['ovisCursor'],newest['ovisCursor'])
            self.assertTrue(bridge.history('different-chat',{'before':newest['ovisCursor']})['historyChanged'])
    def test_title_binding_follows_the_live_thread_and_refuses_ambiguity(self):
        first='01234567-1234-1234-1234-123456789abc';second='01234567-1234-1234-1234-987654321abc'
        terminal={'foreground':{'name':'codex'},'title':first[:29]+'...','labels':{'medo.codex.thread':second}}
        self.assertEqual(bridge.terminal_thread(terminal,[{'id':first},{'id':second}]),first)
        terminal['title']=second[:29]+'...'
        self.assertEqual(bridge.terminal_thread(terminal,[{'id':first},{'id':second}]),second)
        terminal['title']='Project named '+first
        self.assertIsNone(bridge.terminal_thread(terminal,[{'id':first}]))


class SidebarTests(unittest.TestCase):
    first = '01234567-1234-1234-1234-123456789abc'
    second = '01234567-1234-1234-1234-987654321abc'

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.rows = [{'id': self.first}, {'id': self.second}]
        for obj, name, value in ((bridge.sidebar, 'ROOT', self.root),
                                 (bridge.sidebar, 'CODEX_HOME', self.root)):
            patched = patch.object(obj, name, value)
            patched.start(); self.addCleanup(patched.stop)
        self.terminals = []
        self.calls = []
        def hc(*args):
            self.calls.append(args)
            if args[0] == 'ls': return {'terminals': self.terminals}
            if args[0] == 'get': return next(t for t in self.terminals if t['address'] == args[1])
            if args[0] == 'label':
                key, value = args[2].split('=', 1)
                next(t for t in self.terminals if t['address'] == args[1])['labels'][key] = value
                return {}
            if args[0] == 'run':
                terminal = self.terminal('t1', '')
                terminal['labels'].update(dict(args[i+1].split('=', 1) for i, arg in enumerate(args) if arg == '--label'))
                self.terminals.append(terminal)
                return {'address': 't1'}
            self.fail(f'Unexpected hc operation {args[0]}')
        self.client = Mock()
        for obj, name, options in ((bridge.sidebar, 'hc', {'side_effect': hc}),
                                   (bridge.sidebar, 'read_rows', {'return_value': self.rows}),
                                   (bridge, 'Bridge', {'return_value': self.client}),
                                   (bridge.assistant, 'threads', {'return_value': set()})):
            patched = patch.object(obj, name, **options)
            patched.start(); self.addCleanup(patched.stop)

    def terminal(self, address, title, resume=None):
        return {'address': address, 'name': 'ovis-'+address, 'state': 'live', 'title': title,
                'foreground': {'name': 'codex', 'argv': ['codex', 'resume', resume] if resume else ['codex']},
                'labels': {'medo.ovis.project': 'project'}, 'status': {'state': 'idle'}}

    def catalog(self):
        with patch.object(bridge.sidebar, 'catalog', return_value={'chats': [{'id': self.first, 'title': 'Saved conversation'}]}):
            return bridge.handle({'operation': 'index'})

    def folder_setup(self):
        project = {'id': 'project', 'name': 'Project', 'path': str(self.root)}
        (self.root / 'projects.json').write_text(json.dumps({'coreId': 'fixture', 'workspaceRoot': str(self.root), 'projects': [project], 'threadProjects': {}}))
        for row in self.rows: row.update(project_id='project', cwd=str(self.root))
        folder = bridge.organization.update(self.root, ['project'], {}, {'operation': 'create', 'projectId': 'project', 'name': 'Ideas'})['folder']['id']
        return project, folder

    def test_folder_creation_keeps_draft_and_saved_thread_together_without_sending(self):
        project, folder = self.folder_setup()
        with patch.dict(os.environ, {'OVIS_STATE_DIR': str(self.root / 'preferences')}):
            result = bridge.handle({'operation': 'new', 'projectId': project['id'], 'folderId': folder})
        self.assertEqual(result['address'], 't1')
        self.assertEqual(self.terminals[0]['labels']['medo.ovis.folder'], folder)
        self.assertEqual(self.catalog()['drafts'][0]['folder'], folder)
        self.terminals[0]['title'] = self.first
        self.assertEqual(self.catalog()['chats'][0]['folder'], folder)
        saved = bridge.organization.load(self.root)
        self.assertEqual(saved['projects']['project']['chats'][self.first], folder)
        self.assertEqual(self.catalog()['chats'][0]['folder'], folder)
        self.assertEqual(bridge.organization.load(self.root)['revision'], saved['revision'])
        self.client.rpc.assert_not_called()
        self.assertEqual(sum(c[0] == 'run' for c in self.calls), 1)

    def test_folder_launch_does_not_undo_unfiling_or_capture_a_later_new_thread(self):
        project, folder = self.folder_setup()
        terminal = self.terminal('t1', self.first)
        terminal['labels']['medo.ovis.folder'] = folder
        self.terminals = [terminal]
        self.assertEqual(self.catalog()['chats'][0]['folder'], folder)
        bridge.organization.update(self.root, ['project'], {self.first: 'project'},
            {'operation': 'move', 'projectId': 'project', 'threadId': self.first, 'folderId': None})
        self.assertIsNone(self.catalog()['chats'][0]['folder'])
        terminal['title'] = self.second
        self.assertIsNone(self.catalog()['drafts'][0]['folder'])
        self.assertNotIn(self.second, bridge.organization.load(self.root)['projects']['project']['chats'])

    def test_folder_bound_before_history_persists_and_deleted_folder_falls_back_to_unfiled(self):
        project, folder = self.folder_setup()
        terminal = self.terminal('t1', self.second)
        terminal['labels']['medo.ovis.folder'] = folder
        self.terminals = [terminal]
        self.rows.clear()
        self.assertEqual(self.catalog()['drafts'][0]['folder'], folder)
        self.assertEqual(terminal['labels']['medo.ovis.folder-thread'], self.second)
        self.assertEqual(bridge.organization.load(self.root)['projects']['project']['chats'][self.second], folder)
        bridge.organization.update(self.root, ['project'], {}, {'operation': 'delete', 'projectId': 'project', 'folderId': folder})
        self.rows.append({'id': self.second, 'project_id': 'project', 'cwd': str(self.root)})
        self.assertIsNone(self.catalog()['drafts'][0]['folder'])
        self.assertEqual(bridge.organization.load(self.root)['projects']['project']['chats'], {})

    def test_invalid_folder_never_launches_a_conversation(self):
        project, folder = self.folder_setup()
        for invalid in ('missing', [], ''):
            with self.subTest(folder=invalid), self.assertRaisesRegex(ValueError, 'folder'):
                bridge.handle({'operation': 'new', 'projectId': project['id'], 'folderId': invalid})
        self.assertFalse(self.terminals)
        self.assertFalse(self.calls)

    def test_only_coordinator_threads_get_assistant_composer(self):
        with patch.object(bridge.assistant, 'owns', return_value=True):
            self.assertFalse(self.catalog()['chats'][0]['assistant'])
            with patch.object(bridge.assistant, 'threads', return_value={self.first}):
                self.assertTrue(self.catalog()['chats'][0]['assistant'])

    def test_starting_resume_is_one_saved_row_and_concurrent_reopen_reuses_it(self):
        project = {'path': str(self.root), 'id': 'project', 'name': 'Project'}
        first = bridge.launch(project, self.first)
        self.assertFalse(first['reused'])
        self.assertEqual(bridge.launch(project, self.first), {'address': 't1', 'reused': True})
        self.client.rpc.assert_called_once_with('thread/resume', {'threadId': self.first, 'excludeTurns': True})
        data = self.catalog()
        self.assertEqual(data['drafts'], [])
        self.assertEqual(data['chats'][0]['paneId'], 't1')
        self.assertIsNone(bridge.terminal_thread(self.terminals[0], self.rows))
        self.assertTrue((self.root / 'ovis-launch.lock').exists())
        self.terminals[0]['foreground'] = {}
        self.assertEqual(bridge.launch(project, self.first)['address'], 't1')
        self.assertEqual(self.catalog()['chats'][0]['paneId'], 't1')

    def test_live_title_consumes_hint_and_new_never_rebinds_to_launch_target(self):
        terminal = self.terminal('t1', self.second)
        terminal['labels'].update({'medo.ovis.starting': '1', 'medo.ovis.resume': self.first})
        self.terminals.append(terminal)
        self.assertEqual(bridge.terminal_thread(terminal, self.rows, starting=True), self.second)
        terminal['title'] = ''
        self.assertIsNone(bridge.terminal_thread(terminal, self.rows, starting=True))

    def test_simultaneous_open_requests_launch_only_one_terminal(self):
        ready = Barrier(2)
        def open_chat():
            ready.wait(timeout=2)
            return bridge.launch({'path': str(self.root), 'id': 'project', 'name': 'Project'}, self.first)
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = [task.result(timeout=2) for task in [executor.submit(open_chat), executor.submit(open_chat)]]
        self.assertEqual({r['address'] for r in results}, {'t1'})
        self.assertEqual(sum(not r['reused'] for r in results), 1)
        self.client.rpc.assert_called_once()

    def test_empty_resumed_placeholder_is_hidden_but_explicit_new_drafts_remain(self):
        self.terminals = [self.terminal('t1', self.second, self.second), self.terminal('t2', ''),
                          self.terminal('t3', self.second, self.first)]
        self.assertEqual([d['address'] for d in self.catalog()['drafts']], ['t2', 't3'])

    def test_duplicate_terminals_choose_the_same_pane_as_reopen(self):
        self.terminals = [self.terminal('t1', self.first), self.terminal('t2', self.first)]
        data = self.catalog()
        result = bridge.launch({'path': str(self.root)}, self.first)
        self.assertEqual(data['chats'][0]['paneId'], result['address'])
        self.client.rpc.assert_not_called()

    def test_exited_codex_shell_and_unowned_terminals_are_not_drafts(self):
        shell = self.terminal('t1', '')
        shell['foreground']['name'] = 'bash'
        unowned = self.terminal('t2', '')
        unowned['labels'] = {}
        self.terminals = [shell, unowned]
        self.assertEqual(self.catalog()['drafts'], [])

    def test_old_resumed_terminal_during_startup_is_not_a_draft(self):
        self.terminals = [self.terminal('t1', '', self.first)]
        self.assertEqual(self.catalog()['drafts'], [])

    def test_new_thread_after_resume_stays_reachable_before_it_is_persisted(self):
        self.terminals = [self.terminal('t1', 'aaaaaaaa-bbbb-cccc-dddd-eeeeefffffff', self.first)]
        self.assertEqual([d['address'] for d in self.catalog()['drafts']], ['t1'])

    def test_unknown_or_ambiguous_title_never_reuses_a_launch_hint(self):
        terminal = self.terminal('t1', self.first[:29]+'...')
        terminal['labels'].update({'medo.ovis.starting': '1', 'medo.ovis.resume': self.first})
        self.terminals = [terminal]
        rows = [{'id': self.first}, {'id': self.first[:-1]+'d'}]
        self.assertIsNone(bridge.terminal_thread(terminal, rows, starting=True))
        terminal['title'] = 'Project named '+self.first
        self.assertIsNone(bridge.terminal_thread(terminal, rows, starting=True))



class ResourceIdentityTests(unittest.TestCase):
    def test_saved_inventory_uses_verified_thread_cwd_and_closes_only_its_client(self):
        client = Mock()
        with patch.object(bridge.sidebar, 'checked_thread', return_value=({'cwd': '/verified'}, {})) as checked, patch.object(bridge, 'Bridge', return_value=client), patch.object(bridge.resources, 'inventory', return_value={}) as inventory:
            bridge.handle({'operation': 'resources', 'paneId': 'medo:fixture', 'cwd': '/untrusted'})
            checked.assert_called_once_with('fixture')
            inventory.assert_called_once_with(client, 'fixture', '/verified')
            client.process.terminate.assert_called_once()

    def test_unowned_pane_is_rejected_before_reading_inventory(self):
        with patch.object(bridge.sidebar, 'hc', return_value={'labels': {}}), patch.object(bridge, 'Bridge') as client:
            with self.assertRaises(ValueError): bridge.handle({'operation': 'resources', 'paneId': 't1'})
            client.assert_not_called()

class ClaudeModelTests(unittest.TestCase):
    models = [
        {'value': 'default', 'resolvedModel': 'claude-opus-5-5'},
        {'value': 'opus', 'resolvedModel': 'claude-opus-5-5', 'displayName': 'Opus 5.5', 'supportedEffortLevels': ['low', 'high', 'max']},
        {'value': 'claude-opus-4-6', 'resolvedModel': 'claude-opus-4-6', 'displayName': 'Opus 4.6', 'supportedEffortLevels': ['low', 'high']},
        {'value': 'claude-haiku-4-5-20251001', 'displayName': 'Haiku 4.5'},
    ]

    def test_native_initialization_reads_models_without_a_prompt_or_saved_session(self):
        reply = {'type': 'control_response', 'response': {'subtype': 'success', 'request_id': 'model-options', 'response': {'models': self.models}}}
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'TMPDIR': root}), \
             patch.object(bridge, 'claude_binary', return_value='/fixture/claude'), \
             patch.object(bridge.subprocess, 'run', return_value=Mock(stdout=json.dumps(reply))) as run:
            self.assertEqual(bridge.claude_model_catalog(), self.models)
            args = run.call_args.args[0]
            self.assertEqual(args[0], '/fixture/claude')
            self.assertIn('--safe-mode', args)
            self.assertIn('--no-session-persistence', args)
            self.assertEqual(args[args.index('--tools') + 1], '')
            self.assertEqual(json.loads(run.call_args.kwargs['input']), {'type': 'control_request', 'request_id': 'model-options', 'request': {'subtype': 'initialize'}})
            self.assertFalse(Path(run.call_args.kwargs['cwd']).exists())

    def test_aliases_show_the_resolved_version_and_offer_pinned_and_older_models(self):
        choices, default = bridge.claude_model_options(self.models)
        choices = {item['id']: item for item in choices}
        self.assertEqual(default, 'Agent default (CLI settings)')
        self.assertEqual(choices['opus']['label'], 'Latest Opus · Opus 5.5')
        self.assertTrue(choices['opus']['alias'])
        self.assertFalse(choices['claude-opus-5-5']['alias'])
        self.assertEqual(choices['claude-opus-4-6']['efforts'], ['low', 'high'])
        self.assertEqual(choices['claude-haiku-4-5-20251001']['efforts'], [])

    def test_unavailable_native_inventory_has_an_honest_alias_fallback(self):
        with patch.object(bridge, 'model_catalog', return_value=[]), patch.object(bridge.os, 'access', return_value=True), \
             patch.object(bridge, 'claude_model_catalog', side_effect=RuntimeError('unavailable')):
            claude = bridge.provider_options()['providers'][1]
        self.assertTrue(claude['installed'])
        self.assertIn('Could not read', claude['error'])
        self.assertEqual(claude['models'][0]['label'], 'Latest Opus')

    def test_explicit_ids_reach_native_flags_without_model_alias_substitution(self):
        for model in ['claude-opus-5-5', 'claude-opus-4-6', 'claude-sonnet-4-6[1m]']:
            self.assertEqual(bridge.launch_choices('claude', model, 'high'), ['--model', model, '--effort', 'high'])
        for model in ['__custom__', 'claude-opus;echo', 'claude-opus --help', 'claude-' + 'x'*121]:
            with self.subTest(model=model), self.assertRaises(ValueError):
                bridge.launch_choices('claude', model, '')


class ProviderDefaultTests(unittest.TestCase):
    def test_claude_uses_native_applied_values_and_never_exposes_settings(self):
        reply = {'model-options': {'models': ClaudeModelTests.models}, 'defaults': {
            'effective': {'env': {'ANTHROPIC_API_KEY': 'fixture-secret'}, 'effortLevel': 'low'},
            'applied': {'model': 'claude-opus-5-5', 'effort': 'medium'}}}
        with patch.object(bridge, 'claude_configuration', return_value=reply) as read:
            result = bridge.provider_defaults('claude', '/fixture/project', 'opus')
        read.assert_called_once_with('/fixture/project', 'opus', with_settings=True)
        self.assertEqual(result, {'model': 'claude-opus-5-5', 'effort': 'medium', 'efforts': ['low', 'high', 'max']})
        self.assertNotIn('fixture-secret', json.dumps(result))
        reply['defaults']['applied'] = {'model': 'claude-haiku-4-5-20251001', 'effort': None}
        with patch.object(bridge, 'claude_configuration', return_value=reply):
            self.assertEqual(bridge.provider_defaults('claude', '/fixture/project')['efforts'], [])

    def test_defaults_probe_passes_the_launch_directory_and_model_without_a_prompt(self):
        responses = [
            {'type': 'control_response', 'response': {'request_id': 'model-options', 'subtype': 'success', 'response': {'models': []}}},
            {'type': 'control_response', 'response': {'request_id': 'defaults', 'subtype': 'success', 'response': {'applied': {'model': 'claude-opus-4-6', 'effort': 'high'}}}},
        ]
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'TMPDIR': root}), \
             patch.object(bridge.subprocess, 'run', return_value=Mock(stdout='\n'.join(json.dumps(r) for r in responses))) as run:
            reply = bridge.claude_configuration(root, 'claude-opus-4-6', with_settings=True)
            self.assertEqual(run.call_args.kwargs['cwd'], root)
            self.assertEqual(run.call_args.args[0][-2:], ['--model', 'claude-opus-4-6'])
            requests = [json.loads(line) for line in run.call_args.kwargs['input'].splitlines()]
            self.assertEqual([r['request']['subtype'] for r in requests], ['initialize', 'get_settings'])
            self.assertEqual(reply['defaults']['applied']['effort'], 'high')
            self.assertTrue(Path(root).is_dir())

    def test_codex_project_configuration_and_profile_override_catalogue_defaults(self):
        models = [{'model': 'fixture-base', 'isDefault': True, 'defaultReasoningEffort': 'medium', 'supportedReasoningEfforts': [{'reasoningEffort': 'high'}]},
                  {'model': 'fixture-fast', 'defaultReasoningEffort': 'low', 'supportedReasoningEfforts': [{'reasoningEffort': 'low'}]}]
        config = {'model': 'fixture-base', 'model_reasoning_effort': 'high', 'profiles': {}}
        client = Mock()
        client.rpc.side_effect = lambda method, params: {'config': config} if method == 'config/read' else {'data': models}
        with patch.object(bridge, 'Bridge', return_value=client):
            self.assertEqual(bridge.provider_defaults('codex', '/fixture/project'), {'model': 'fixture-base', 'effort': 'high', 'efforts': ['high']})
            client.rpc.assert_any_call('config/read', {'cwd': '/fixture/project', 'includeLayers': False})
            config.update(profile='quick', profiles={'quick': {'model': 'fixture-fast', 'model_reasoning_effort': 'low'}})
            self.assertEqual(bridge.provider_defaults('codex', '/fixture/project')['model'], 'fixture-fast')
            self.assertEqual(bridge.provider_defaults('codex', '/fixture/project', 'fixture-base')['effort'], 'low')
            config.clear()
            self.assertEqual(bridge.provider_defaults('codex', '/fixture/project', 'fixture-fast')['effort'], 'low')
        self.assertEqual(client.process.terminate.call_count, 4)

    def test_codex_default_model_accepts_a_supported_explicit_effort_without_pinning_the_model(self):
        with patch.object(bridge, 'provider_defaults', return_value={'model': 'fixture', 'effort': 'medium', 'efforts': ['medium', 'high']}) as read:
            self.assertEqual(bridge.launch_choices('codex', '', 'high', '/fixture/project'), ['-c', 'model_reasoning_effort=high'])
            read.assert_called_once_with('codex', '/fixture/project')
            with self.assertRaises(ValueError):
                bridge.launch_choices('codex', '', 'ultra', '/fixture/project')

    def test_unknown_claude_defaults_do_not_fall_back_to_a_guessed_effort(self):
        with patch.object(bridge, 'claude_configuration', return_value={}), self.assertRaisesRegex(ValueError, 'Could not read'):
            bridge.provider_defaults('claude', '/fixture/project')


class ClaudeProviderTests(unittest.TestCase):
    session = '00000000-0000-4000-8000-000000000001'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = self.root / 'claude'
        self.project = {'id': 'fixture', 'name': 'Fixture', 'path': str(self.root / 'project')}
        Path(self.project['path']).mkdir()
        for change in [patch.object(bridge.sidebar, 'ROOT', self.root / 'sidebar'),
                       patch.dict(os.environ, {'OVIS_STATE_DIR': str(self.root / 'state'), 'CLAUDE_CONFIG_DIR': str(self.store)}),
                       patch.object(bridge, 'claude_binary', return_value='/fixture/claude'),
                       patch.object(bridge.os, 'access', return_value=True)]:
            change.start(); self.addCleanup(change.stop)

    def test_launches_claude_with_its_own_flags_and_persists_native_identity(self):
        with patch.object(bridge.sidebar, 'hc', return_value={'address': 't1', 'pid': 123}) as hc, patch.object(bridge, 'Bridge') as codex:
            result = bridge.launch(self.project, provider='claude', model='opus', effort='high')
        args = hc.call_args.args
        launched = args[args.index('--') + 1:]
        self.assertEqual(launched[0], '/usr/bin/env')
        self.assertEqual(launched[2], '/fixture/claude')
        self.assertEqual(launched[3], '--session-id')
        self.assertEqual(launched[5:], ('--model', 'opus', '--effort', 'high'))
        self.assertNotIn('--remote', args)
        self.assertNotIn('--permission-mode', args)
        self.assertIn('CLAUDE_CONFIG_DIR='+str(self.store), args)
        saved = bridge.claude_sessions.load(bridge.sidebar.ROOT)
        self.assertEqual(saved[launched[4]]['project'], 'fixture')
        self.assertEqual(result, {'address': 't1', 'reused': False, 'pid': 123})
        codex.assert_not_called()

    def test_failed_launch_has_no_saved_phantom_and_invalid_choices_do_not_launch(self):
        with patch.object(bridge.sidebar, 'hc', side_effect=RuntimeError('unavailable')), self.assertRaises(RuntimeError):
            bridge.launch(self.project, provider='claude')
        self.assertEqual(bridge.claude_sessions.load(bridge.sidebar.ROOT), {})
        with patch.object(bridge.sidebar, 'hc') as hc:
            for provider, model, effort in [('gemini', '', ''), ('claude', '--help', ''), ('claude', 'opus', 'ultra'), ('claude', 'unknown', '')]:
                with self.subTest(provider=provider, model=model, effort=effort), self.assertRaises(ValueError):
                    bridge.launch(self.project, provider=provider, model=model, effort=effort)
            hc.assert_not_called()

    def test_claude_folder_creation_and_done_state_preserve_later_manual_moves(self):
        root = bridge.sidebar.ROOT
        root.mkdir()
        (root / 'organization.json').write_text(json.dumps({'revision': 0, 'projects': {
            'fixture': {'folders': [{'id': 'ideas', 'name': 'Ideas'}], 'chats': {}}
        }}))
        with patch.object(bridge.sidebar, 'config', return_value={'projects': [self.project]}), \
             patch.object(bridge.sidebar, 'hc', return_value={'address': 't1'}) as hc:
            with self.assertRaises(ValueError):
                bridge.handle({'operation': 'new', 'projectId': 'fixture', 'provider': 'claude', 'folderId': 'deleted'})
            hc.assert_not_called()
            bridge.handle({'operation': 'new', 'projectId': 'fixture', 'provider': 'claude', 'folderId': 'ideas'})
        session = next(iter(bridge.claude_sessions.load(root)))
        thread = 'claude:' + session
        self.assertEqual(bridge.organization.load(root)['projects']['fixture']['chats'][thread], 'ideas')
        bridge.organization.update(root, ['fixture'], {thread: 'fixture'}, {
            'operation': 'move', 'projectId': 'fixture', 'threadId': thread, 'folderId': None})
        bridge.organization.update(root, ['fixture'], {thread: 'fixture'}, {
            'operation': 'set-done', 'projectId': 'fixture', 'threadId': thread, 'done': True})
        with patch.object(bridge.sidebar, 'read_rows', return_value=[]), \
             patch.object(bridge.sidebar, 'catalog', side_effect=lambda **_: {'projects': [{**self.project, 'folders': []}], 'chats': []}), \
             patch.object(bridge.sidebar, 'hc', return_value={'terminals': []}):
            for _ in range(2):
                row = bridge.handle({'operation': 'index'})['chats'][0]
                self.assertEqual(row['id'], thread)
                self.assertTrue(row['done'])
                self.assertIsNone(row['folder'])

    def test_claude_uses_only_its_saved_permission_preset(self):
        state = self.root / 'state'
        state.mkdir()
        (state / 'preferences.json').write_text(json.dumps({'settings': {'claudeLaunchMode': 'plan', 'codexLaunchMode': 'fullAccess'}}))
        with patch.object(bridge.sidebar, 'hc', return_value={'address': 't1'}) as hc:
            bridge.launch(self.project, provider='claude')
        args = hc.call_args.args
        self.assertEqual(args[-2:], ('--permission-mode', 'plan'))
        self.assertNotIn('--sandbox', args)

    def test_claude_resume_uses_native_session_proof_not_old_launch_label(self):
        terminal = {'address': 't1', 'state': 'live', 'labels': {'medo.ovis.claude': 'old'}}
        with patch.object(bridge.sidebar, 'hc', side_effect=lambda *args: {'terminals': [terminal]} if args[0] == 'ls' else terminal) as hc, \
             patch.object(bridge.claude_sessions, 'terminal_session', return_value=self.session):
            result = bridge.launch(self.project, self.session, provider='claude')
        self.assertEqual(result, {'address': 't1', 'reused': True})
        self.assertFalse(any(call.args[0] == 'run' for call in hc.call_args_list))

    def test_reused_pid_and_noninteractive_records_never_claim_a_session(self):
        (self.store / 'sessions').mkdir(parents=True)
        proc = self.root / 'proc'
        (proc / '123').mkdir(parents=True)
        (proc / '123' / 'stat').write_text('123 (claude child) ' + ' '.join(['S'] + ['0']*18 + ['456']))
        record = {'pid': 123, 'kind': 'interactive', 'sessionId': self.session, 'procStart': '456'}
        path = self.store / 'sessions' / '123.json'
        path.write_text(json.dumps(record))
        self.assertEqual(bridge.claude_sessions.process_session(123, self.store, proc), self.session)
        for change in [{'procStart': '457'}, {'kind': 'background'}, {'sessionId': '../../other'}, {'pid': 999}]:
            path.write_text(json.dumps({**record, **change}))
            self.assertIsNone(bridge.claude_sessions.process_session(123, self.store, proc))

    def test_saved_history_retains_provider_identity_after_terminal_exit_and_rename(self):
        entry = bridge.claude_sessions.register(bridge.sidebar.ROOT, self.session, self.project)
        path = self.store / 'projects' / bridge.claude_sessions.project_slug(entry['cwd']) / (self.session+'.jsonl')
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'type': 'user', 'message': {'content': 'Investigate the release'}, 'sessionId': self.session})+'\n')
        with patch.object(bridge.sidebar, 'read_rows', return_value=[]), \
             patch.object(bridge.sidebar, 'catalog', return_value={'projects': [{**self.project, 'folders': []}], 'chats': []}), \
             patch.object(bridge.sidebar, 'hc', return_value={'terminals': []}):
            catalog = bridge.handle({'operation': 'index'})
        self.assertEqual(catalog['chats'][0]['id'], 'claude:'+self.session)
        self.assertEqual(catalog['chats'][0]['provider'], 'claude')
        self.assertEqual(catalog['chats'][0]['title'], 'Investigate the release')
        self.assertNotIn('paneId', catalog['chats'][0])
        with patch.object(bridge, 'Bridge') as codex:
            bridge.handle({'operation': 'rename', 'threadId': 'claude:'+self.session, 'name': 'Release review'})
            codex.assert_not_called()
        self.assertEqual(bridge.claude_sessions.metadata(self.session, bridge.claude_sessions.load(bridge.sidebar.ROOT)[self.session])['title'], 'Release review')
        self.assertEqual(bridge.handle({'operation': 'claude-history', 'threadId': 'claude:'+self.session})['path'], str(path))

    def test_outside_transcript_symlink_is_not_read(self):
        entry = bridge.claude_sessions.register(bridge.sidebar.ROOT, self.session, self.project)
        path = self.store / 'projects' / bridge.claude_sessions.project_slug(entry['cwd']) / (self.session+'.jsonl')
        path.parent.mkdir(parents=True)
        outside = self.root / 'outside.jsonl'
        outside.write_text('private')
        path.symlink_to(outside)
        self.assertIsNone(bridge.claude_sessions.transcript(self.session, entry))


if __name__=='__main__':unittest.main()
