"""No real terminals, Codex RPCs or user files are touched by these tests."""
import importlib.util
import unittest
from unittest.mock import patch
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

if __name__=='__main__':unittest.main()
