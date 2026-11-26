import json
import base64
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from integrations.ovis.bridge import server, organization


class SidebarTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in ('ROOT', 'CODEX_HOME'):
            patched = patch.object(server, name, self.root)
            patched.start()
            self.addCleanup(patched.stop)
        self.cfg = {'coreId':'test', 'workspaceRoot':'/home/example/dev', 'projects':[
            {'id':'root','name':'Root','path':'/home/example/dev'},
            {'id':'a','name':'App','path':'/home/example/dev/app','origins':['github.com/me/app']},
        ], 'threadProjects':{}}
        self.row = {'id':'c','name':'Renamed chat','title':'Original long prompt','cwd':str(self.root),
                    'rollout_path':str(self.root/'missing.jsonl'),'updated_at':10,'archived':0,
                    'source':'vscode','history_mode':'paginated'}

    def test_project_prefix_and_removed_worktree(self):
        row = dict(self.row,cwd='/home/example/dev/app/work')
        self.assertEqual(server.project_for(row,self.cfg),'a')
        self.assertEqual(server.project_for(dict(row,cwd='/home/example/dev/application'),self.cfg),'root')
        row.update(cwd='/missing/worktree/app',git_origin_url='git@github.com:me/app.git')
        self.assertEqual(server.project_for(row,self.cfg),'a')
        self.cfg['threadProjects']['c']='root'
        self.assertEqual(server.project_for(row,self.cfg),'root')

    def test_catalog_uses_shared_project_order_and_appends_new_projects(self):
        organization.move_project(self.root, ['root','a'], dict(projectId='a', relativeTo='root', direction='up'))
        self.assertEqual([p['id'] for p in server.catalog(self.cfg, [])['projects']], ['a','root'])
        self.cfg['projects'].append({'id':'new', 'name':'New', 'path':'/fixture/new'})
        self.assertEqual([p['id'] for p in server.catalog(self.cfg, [])['projects']], ['a','root','new'])

    def test_paginated_history_does_not_need_jsonl(self):
        (self.root/'thread_history_1.sqlite').touch()
        with patch.object(server,'CODEX_HOME',self.root):
            item=server.display(self.row,self.cfg)
        self.assertIsNone(item['unavailable'])
        self.assertEqual(item['title'],'Renamed chat')

    def test_done_survives_reload_folder_edits_and_project_reassignment(self):
        rows = [dict(self.row, cwd='/home/example/dev/app')]
        self.assertFalse(server.catalog(self.cfg, rows)['chats'][0]['done'])
        def update(**change):
            return organization.update(self.root, ['root', 'a'], {'c': 'a'}, change)
        update(operation='set-done', projectId='a', threadId='c', done=True)
        update(operation='set-done', projectId='a', threadId='c', done=True)
        folder = update(operation='create', projectId='a', name='Completed')['folder']['id']
        update(operation='move', projectId='a', threadId='c', folderId=folder)
        item = server.catalog(self.cfg, rows)['chats'][0]
        self.assertTrue(item['done'])
        self.assertFalse(item['archived'])
        self.assertEqual(item['folder'], folder)
        update(operation='delete', projectId='a', folderId=folder)
        self.cfg['threadProjects']['c'] = 'root'
        item = server.catalog(self.cfg, rows)['chats'][0]
        self.assertTrue(item['done'])
        self.assertEqual(item['project'], 'root')
        organization.update(self.root, ['root', 'a'], {'c': 'root'},
                            dict(operation='set-done', projectId='root', threadId='c', done=False))
        self.assertFalse(server.catalog(self.cfg, rows)['chats'][0]['done'])

    def test_done_rejects_unknown_conversations_wrong_projects_and_non_booleans(self):
        organization.update(self.root, ['root', 'a'], {'c': 'a'},
                            dict(operation='set-done', projectId='a', threadId='c', done=True))
        before = (self.root / 'organization.json').read_bytes()
        for changes in ({'threadId': 'missing'}, {'projectId': 'root'}, {'done': 'false'}, {'done': 1}, {'done': None}):
            with self.assertRaises(ValueError):
                organization.update(self.root, ['root', 'a'], {'c': 'a'},
                                    dict(operation='set-done', projectId='a', threadId='c', done=True) | changes)
            self.assertEqual((self.root / 'organization.json').read_bytes(), before)

    def test_missing_checkout_remains_visible(self):
        (self.root/'thread_history_1.sqlite').touch()
        with patch.object(server,'CODEX_HOME',self.root):
            data=server.catalog(self.cfg,[dict(self.row,cwd='/missing/checkout',archived=1)])
        self.assertEqual(len(data['chats']),1)
        self.assertTrue(data['chats'][0]['archived'])
        self.assertIn('checkout',data['chats'][0]['unavailable'])
        self.assertEqual(data['projects'][-1]['id'],'other')

    def test_helpers_are_not_user_chats(self):
        self.assertTrue(server.human(self.row))
        self.assertFalse(server.human(dict(self.row,source='exec')))
        self.assertFalse(server.human(dict(self.row,source='{"subagent":{}}')))
        self.assertFalse(server.human(dict(self.row,agent_path='/root/helper')))

    def test_catalog_omits_only_verified_empty_placeholders(self):
        db = self.root / 'thread_history_1.sqlite'
        with closing(sqlite3.connect(db)) as conn:
            for table in ('thread_turns', 'thread_items', 'thread_realtime_items'):
                conn.execute(f'CREATE TABLE {table} (thread_id TEXT PRIMARY KEY)')
            conn.execute("INSERT INTO thread_turns VALUES ('turn-only')")
            conn.execute("INSERT INTO thread_items VALUES ('item-only')")
            conn.execute("INSERT INTO thread_realtime_items VALUES ('realtime-only')")
            conn.commit()
        before = db.read_bytes()
        empty = dict(self.row, id='empty', title='', first_user_message='')
        rows = [self.row, empty, dict(empty, id='turn-only'), dict(empty, id='item-only'),
                dict(empty, id='realtime-only'), dict(empty, id='prompt', first_user_message='hello'),
                dict(empty, id='legacy', history_mode='jsonl')]
        data = server.catalog(self.cfg, rows)
        self.assertEqual([r['id'] for r in data['chats']], ['c', 'turn-only', 'item-only', 'realtime-only', 'prompt', 'legacy'])
        self.assertEqual(db.read_bytes(), before)

    def test_catalog_keeps_uncertain_history_and_does_not_create_a_store(self):
        empty = dict(self.row, title='', first_user_message='')
        self.assertEqual(len(server.catalog(self.cfg, [empty])['chats']), 1)
        self.assertFalse((self.root / 'thread_history_1.sqlite').exists())

    def test_read_only_index_does_not_create_missing_database(self):
        db=self.root/'missing.sqlite'
        with self.assertRaises(sqlite3.OperationalError): server.read_rows(db)
        self.assertFalse(db.exists())

    def test_read_only_index_filters_without_mutating(self):
        db=self.root/'history.sqlite'
        with closing(sqlite3.connect(db)) as con:
            con.execute('create table threads (id text, source text, updated_at integer)')
            con.executemany('insert into threads values (?,?,?)',[('a','vscode',1),('b','exec',2)])
            con.commit()
        before=db.read_bytes()
        self.assertEqual([r['id'] for r in server.read_rows(db)],['a'])
        self.assertEqual(db.read_bytes(),before)

    def test_reopening_reuses_live_terminal(self):
        thread='11111111-2222-3333-4444-555555555555'
        name='cx-'+thread.replace('-','')[:28]
        item=dict(project='a',cwd=str(self.root),title='Chat')
        with patch.object(server,'config',return_value=self.cfg), \
             patch.object(server,'checked_thread',return_value=({},item)), \
             patch.object(server.Path,'home',return_value=self.root), \
             patch.object(server,'hc',return_value={'terminals':[{'name':name,'state':'live','address':'t9'}]}) as hc:
            result=server.launch(thread_id=thread)
        self.assertTrue(result['reused'])
        self.assertEqual(result['address'],'t9')
        hc.assert_called_once_with('ls','--json')

    def test_styles_persist_and_keep_other_projects(self):
        with patch.object(server,'ROOT',self.root),patch.object(server,'config',return_value=self.cfg):
            server.save_style('a',{'iconText':'AB','titleColor':'#123456','sectionColor':'','borderColor':'#438a75'})
            server.save_style('root',{'iconText':'R','titleColor':'#abcdef'})
            data=server.catalog(self.cfg,[])
            self.assertEqual(data['projects'][1]['appearance']['titleColor'],'#123456')
            self.assertEqual(data['projects'][1]['appearance']['borderColor'],'#438a75')
            self.assertEqual(data['projects'][0]['appearance']['iconText'],'R')
            with self.assertRaises(ValueError): server.save_style('a',{'titleColor':'red;anything'})
            with self.assertRaises(ValueError): server.save_style('a',{'borderColor':'red;anything'})
            server.save_style('a',{'borderColor':''})
            self.assertEqual(server.catalog(self.cfg,[])['projects'][1]['appearance']['borderColor'],'')
            with self.assertRaises(ValueError): server.save_style('unknown',{})
            with self.assertRaises(ValueError): server.save_style('a',{'image':'../../secret'})

    def test_image_roundtrip_and_limits(self):
        png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGNoWvUfK2IYWhIAF7KKwVUMsAoAAAAASUVORK5CYII=')
        with patch.object(server,'ROOT',self.root):
            saved=server.put_icon(base64.b64encode(png).decode())
            self.assertEqual(base64.b64decode(server.get_icon(saved['image'])['base64']),png)
            with self.assertRaises(ValueError): server.get_icon('../../secret')
            with self.assertRaises(ValueError): server.put_icon(base64.b64encode(b'<svg></svg>').decode())
            with self.assertRaises(ValueError): server.put_icon('A'*710001)


if __name__=='__main__': unittest.main()
