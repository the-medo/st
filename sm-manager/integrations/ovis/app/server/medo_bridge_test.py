"""No real terminals, Codex RPCs or user files are touched by these tests."""
import importlib.util
import unittest
import tempfile
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch, Mock
from pathlib import Path

spec=importlib.util.spec_from_file_location('medo_bridge',Path(__file__).with_name('medo-bridge.py'))
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)

class HistoryTests(unittest.TestCase):
    def test_paging_keeps_the_read_window_when_new_turns_arrive(self):
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
                                   (bridge, 'Bridge', {'return_value': self.client})):
            patched = patch.object(obj, name, **options)
            patched.start(); self.addCleanup(patched.stop)

    def terminal(self, address, title, resume=None):
        return {'address': address, 'name': 'ovis-'+address, 'state': 'live', 'title': title,
                'foreground': {'name': 'codex', 'argv': ['codex', 'resume', resume] if resume else ['codex']},
                'labels': {'medo.ovis.project': 'project'}, 'status': {'state': 'idle'}}

    def catalog(self):
        with patch.object(bridge.sidebar, 'catalog', return_value={'chats': [{'id': self.first, 'title': 'Saved conversation'}]}):
            return bridge.handle({'operation': 'index'})

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

if __name__=='__main__':unittest.main()
