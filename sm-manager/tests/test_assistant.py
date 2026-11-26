import json
import http.client
from http.server import ThreadingHTTPServer
import tempfile
import threading
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch, Mock
from sm_manager import assistant
from sm_manager.server import handler_for
from integrations.ovis.bridge import assistant as bridge
from integrations.ovis.bridge.chat_service import Bridge


class AssistantTests(TestCase):
    def test_status_does_not_expose_credentials_and_worker_has_freshness(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(assistant,'data_dir',return_value=Path(directory)), patch.object(assistant,'rpc',return_value={'devices':[]}):
            (Path(directory)/'router-health.json').write_text(json.dumps({'status':'authentication','secret':'not-for-web'}))
            (Path(directory)/'worker-health.json').write_text('{"checked_at":1}')
            result=assistant.status()
            self.assertFalse(result['worker_online'])
            self.assertNotIn('secret',json.dumps(result))
            self.assertEqual(result['router']['status'],'authentication')

    def test_owner_web_actions_require_token_and_origin(self):
        collector=Mock()
        config={'allowed_hosts':['127.0.0.1','localhost'],'public_url':'http://localhost','frontend':'react'}
        with patch.object(assistant,'status',return_value={'available':True}), patch.object(assistant,'action',return_value={'ok':True}) as act:
            server=ThreadingHTTPServer(('127.0.0.1',0),handler_for(collector,config,github=Mock()))
            config['port']=server.server_port
            thread=threading.Thread(target=server.serve_forever);thread.start()
            def request(method,headers=None):
                c=http.client.HTTPConnection('127.0.0.1',server.server_port)
                c.request(method,'/api/assistant',body='{"action":"stop"}' if method=='POST' else None,headers=headers or {})
                r=c.getresponse();result=r.status,json.loads(r.read());c.close();return result
            try:
                code,data=request('GET');self.assertEqual(code,200)
                self.assertEqual(request('POST',{'Content-Type':'application/json'})[0],403)
                headers={'Content-Type':'application/json','X-SM-Token':data['token']}
                self.assertEqual(request('POST',{**headers,'Origin':'https://evil.invalid'})[0],403)
                self.assertEqual(request('POST',headers)[0],200);act.assert_called_once()
            finally:
                server.shutdown();server.server_close();thread.join()

    def test_followup_retry_identifier_is_stable_and_never_uses_browser_device(self):
        p={'operation':'send','threadId':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','nonce':'retry','text':'Tomorrow','device':'pc'}
        with patch.object(bridge,'rpc',return_value={'id':'job'}) as call:
            bridge.action(p);first=call.call_args.args[0]
            bridge.action(p);self.assertEqual(call.call_args.args[0],first)
            self.assertNotIn('device',first)

    def test_assistant_read_is_passive_and_unwraps_spoken_result(self):
        b=object.__new__(Bridge);b.lock=threading.RLock();b.live={};b.approvals={};b.settings={};b.loaded=set();b.shared_daemon=True;b.generation='test';b.revisions={}
        b.metadata=Mock(return_value=({'cwd':str(assistant.data_dir()/'assistant')},{'id':'thread','unavailable':None}))
        b.rpc=Mock(side_effect=[{'thread':{'status':{'type':'idle'}}},{'data':[{'id':'turn','items':[{'id':'message','type':'agentMessage','text':json.dumps({'display_text':'Human answer','speech_text':'Short answer'})}]}]}])
        with patch.object(bridge,'state',return_value={'id':'job','status':'completed','events':[]}):
            result=b.read('thread')
        self.assertEqual([c.args[0] for c in b.rpc.call_args_list],['thread/read','thread/turns/list'])
        self.assertEqual(result['turns'][0]['items'][0]['text'],'Human answer')

    def test_assistant_send_never_starts_generic_codex_turn(self):
        b=object.__new__(Bridge);b.lock=threading.RLock();b.thread_locks={};b.receipts={};b.rpc=Mock()
        b.metadata=Mock(return_value=({'cwd':str(assistant.data_dir()/'assistant')},{'unavailable':None}))
        with patch.object(bridge,'action',return_value={'ok':True}) as act:
            b.send({'threadId':'thread','nonce':'retry','text':'Tomorrow'})
            act.assert_called_once();b.rpc.assert_not_called()
