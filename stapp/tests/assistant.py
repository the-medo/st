"""Classifier failures, context isolation, and durable speech/cancellation semantics."""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'runtime'))
from routing import Router,build_context
from agent import output
import integration
from transport import rpc

CATALOG=json.loads((Path(__file__).resolve().parents[1]/'assistant/routing/catalog.json').read_text())
class FakeResponse(io.BytesIO):
    def __enter__(self):return self
    def __exit__(self,*args):self.close()
class Provider:
    def __init__(self,choice='planner',error=None,delay=0):self.choice=choice;self.error=error;self.delay=delay;self.calls=[]
    def open(self,request,timeout):
        self.calls.append(request);time.sleep(self.delay)
        if self.error:raise self.error
        criteria=json.loads(request.data)['questions']['route']['criteria']
        answer={'choice':self.choice,'probabilities':{k:1.0 if k==self.choice else 0.0 for k in criteria}}
        return FakeResponse(json.dumps({'success':True,'result':{'answers':{'route':answer}}}).encode())
class Routing(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        (self.root/'token').write_text('synthetic-token')
        self.config=self.root/'config.json';self.config.write_text(json.dumps({'account_id':'a'*32,'api_token_file':'token'}))
        self.job={'text':'Create a task','id':'synthetic','device':'room','project':'assistant','cwd':str(self.root)}
    def router(self,provider,deadline=.1):
        router=Router(self.config,provider,deadline);self.addCleanup(router.pool.shutdown);return router
    def test_only_transcript_and_criteria_leave_machine(self):
        provider=Provider();r=self.router(provider).decide(self.job,CATALOG)
        self.assertEqual(r['effective_route'],'planner')
        data=json.loads(provider.calls[0].data)
        self.assertEqual(data['state'],self.job['text']);self.assertEqual(set(data),{'model','state','questions'})
        self.assertNotIn('manuals',str(data));self.assertNotIn('synthetic-token',str(r))
    def test_followup_and_oversized_request_bypass_network(self):
        p=Provider();r=self.router(p)
        self.assertEqual(r.decide(dict(self.job,thread='existing'),CATALOG)['reason'],'continuation')
        self.assertEqual(r.decide(dict(self.job,text='č'*20000),CATALOG)['reason'],'input_budget')
        self.assertFalse(p.calls)
    def test_bad_key_stops_retries_until_replaced(self):
        p=Provider(error=urllib.error.HTTPError('https://example.invalid',403,'Forbidden',{},None));r=self.router(p)
        self.assertEqual(r.decide(self.job,CATALOG)['reason'],'authentication')
        r.decide(self.job,CATALOG);self.assertEqual(len(p.calls),1)
        (self.root/'token').write_text('replacement');p.error=None
        self.assertEqual(r.decide(self.job,CATALOG)['effective_route'],'planner');self.assertEqual(len(p.calls),2)
    def test_rate_limit_backoff(self):
        p=Provider(error=urllib.error.HTTPError('https://example.invalid',429,'Rate limited',{'Retry-After':'60'},None));r=self.router(p)
        self.assertEqual(r.decide(self.job,CATALOG)['reason'],'rate_limit')
        self.assertEqual(r.decide(self.job,CATALOG)['reason'],'backoff');self.assertEqual(len(p.calls),1)
    def test_deadline_does_not_spawn_unbounded_background_calls(self):
        p=Provider(delay=.15);r=self.router(p,deadline=.02);start=time.monotonic()
        self.assertEqual(r.decide(self.job,CATALOG)['reason'],'timeout');self.assertLess(time.monotonic()-start,.1)
        for _ in range(5):r.decide(self.job,CATALOG)
        self.assertEqual(len(p.calls),1)
    def test_unknown_choice_cannot_become_tool_or_path(self):
        r=self.router(Provider(choice='../../private'))
        self.assertEqual(r.decide(self.job,CATALOG)['effective_route'],'other')
    def test_context_never_follows_catalog_symlink_outside_manuals(self):
        manuals=self.root/'manuals';manuals.mkdir();secret=self.root/'secret';secret.write_text('DO NOT LOAD')
        (manuals/'escape').symlink_to(secret)
        catalog={'routes':[{'id':'other','description':'Other','status':'fallback','manuals':['escape','../secret'],'tools':[]}]}
        result=build_context(self.job,{'effective_route':'other'},catalog)
        self.assertEqual(result['initial_context'],[]);self.assertEqual(result['transcript'],self.job['text'])
    def test_structured_output_does_not_read_code_or_claim_missing_success(self):
        self.assertEqual(output('broken')['status'],'failed')
        r=output(json.dumps({'display_text':'Full result','speech_text':'``` private logs ```','status':'completed'}))
        self.assertNotIn('private',r['speech_text']);self.assertEqual(r['display_text'],'Full result')

class Events(integration.Daemon):
    def test_new_migration_preserves_cli_notes_and_deduplicates_ack(self):
        self.ask('room','Synthetic question');job=rpc({'op':'claim_job'},'owner')
        for _ in range(2):self.event(job,'acknowledged','I will check.')
        rpc({'op':'worker_event','id':job['id'],'claim':job['claim'],'kind':'completed','text':'Complete display','payload':{'speech_text':'Short speech'}},'owner')
        events=rpc({'op':'inbox','after':0},'room')
        self.assertEqual(sum(e['kind']=='acknowledged' for e in events),1)
        self.assertEqual(events[-1]['payload']['speech_text'],'Short speech')
        self.assertEqual(rpc({'op':'inbox','after':0},'pc'),[])
        self.stop();self.start()
        self.assertEqual(rpc({'op':'inbox','after':events[-2]['seq']},'room')[-1]['text'],'Complete display')
    def test_cancel_invalidates_claim_and_is_device_scoped(self):
        self.ask('room','Synthetic cancellable');job=rpc({'op':'claim_job'},'owner')
        with self.assertRaises(ValueError):rpc({'op':'cancel','id':job['id']},'pc')
        rpc({'op':'cancel','id':job['id']},'room')
        with self.assertRaises(ValueError):self.event(job,'completed','Wrong completion')
        self.assertEqual(rpc({'op':'status','id':job['id']},'room')['status'],'cancelled')

    def test_bare_spoken_answer_retries_are_durable_and_device_scoped(self):
        import uuid
        self.ask('room','Ask for a choice');job=rpc({'op':'claim_job'},'owner')
        self.event(job,'question','Which color?')
        req={'op':'ask','id':str(uuid.uuid4()),'text':'blue','voice':True}
        first=rpc(req,'room');again=rpc(req,'room')
        self.assertEqual(first,again);self.assertEqual(first['id'],job['id'])
        self.assertEqual(self.event(job,'poll'),'blue')
        with self.assertRaises(ValueError):rpc(req,'pc')

    def test_dynamic_tools_bind_to_job_and_release_thread(self):
        from agent import execute,OUTPUT_SCHEMA
        import sqlite3
        case=self
        class Fake:
            def __init__(self):self.next_id=0;self.messages=[];self.requests=[]
            def project(self,cwd,heartbeat):return 'project'
            def request(self,method,params,heartbeat=None):
                self.requests.append((method,params))
                return {'thread':{'id':'native-thread'}}
            def send(self,msg):
                self.messages.append(msg)
                if msg.get('method')=='turn/start':
                    case.assertEqual(msg['params']['model'],'gpt-6-luna')
                    case.assertEqual(msg['params']['effort'],'low')
                    case.assertEqual(msg['params']['input'][0]['text'],'Save my synthetic note')
                    case.assertEqual(msg['params']['outputSchema'],OUTPUT_SCHEMA)
            def receive(self,timeout):return events.pop(0)
            def close(self):pass
        fake=Fake()
        events=[{'method':'item/tool/call','id':99,'params':{'threadId':'native-thread','tool':'save_record','arguments':{'kind':'note','title':'Contract test','body':'Isolated'},'callId':'call-1'}},
            {'method':'item/completed','params':{'threadId':'native-thread','item':{'type':'agentMessage','text':json.dumps({'display_text':'Saved','speech_text':'Saved','status':'completed'})}}},
            {'method':'turn/completed','params':{'threadId':'native-thread','turn':{'status':'completed'}}}]
        self.ask('room','Save my synthetic note');job=rpc({'op':'claim_job'},'owner')
        Path(job['cwd']).mkdir(parents=True,exist_ok=True)
        def emit(kind,text='',payload=None):
            return rpc({'op':'worker_event','id':job['id'],'claim':job['claim'],'kind':kind,'text':text,'payload':payload},'owner')
        with patch('agent.connection',return_value=fake):
            result=execute(job,{'effective_route':'notes'},CATALOG,emit)
        with sqlite3.connect(self.data/'stapp.sqlite') as db:
            self.assertEqual(db.execute('SELECT title,body FROM records').fetchall(),[('Contract test','Isolated')])
        self.assertEqual(result['confirmed_tools'][0]['call_id'],'call-1')
        self.assertEqual(fake.requests[-1],('thread/unsubscribe',{'threadId':'native-thread'}))
        self.assertTrue(next(x for x in fake.messages if x.get('id')==99)['result']['success'])

if __name__=='__main__':unittest.main()
