"""One reusable app-server per worker slot; threads and tool claims remain per request."""
import atexit
import hashlib
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import threading
import time
import tomllib
from contextlib import suppress

from mcp import TOOLS, tool, S
import capabilities
from routing import build_context
from transport import rpc

OUTPUT_SCHEMA = {'type':'object','properties':{'display_text':{'type':'string'},'speech_text':{'type':'string'},'status':{'type':'string','enum':['completed','failed']}},'required':['display_text','speech_text','status'],'additionalProperties':False}
DISCOVER = tool('discover_capability','Get trusted manuals, availability and callable tool schemas for another capability.', ['route'], route=S)
INVOKE = tool('call_capability_tool','Call a tool discovered with discover_capability. Same request permissions apply.', ['name','arguments'], name=S, arguments={'type':'object','additionalProperties':True})
SCHEMAS = {t['name']:t for t in TOOLS + capabilities.TOOLS}
CONNECTIONS = []
LOCAL = threading.local()


def selected_tools(decision, catalog):
    route = next((r for r in catalog['routes'] if r['id']==decision['effective_route']), None)
    names = set(route.get('tools',[]) if route else []) | {'ask_user','list_projects'}
    return [{'type':'function',**t} for t in TOOLS + capabilities.TOOLS if t['name'] in names] + [{'type':'function',**DISCOVER},{'type':'function',**INVOKE}]


def output(text):
    try:
        value=json.loads(text)
        if set(value)!=set(OUTPUT_SCHEMA['required']) or value['status'] not in ('completed','failed') or not all(isinstance(value[k],str) and value[k].strip() for k in ('speech_text','display_text')):
            raise ValueError('Invalid structured result')
        if len(value['display_text'])>64000: raise ValueError('Result too long')
        speech=value['speech_text']
        if len(speech.split())>45 or len(speech)>800 or '```' in speech:
            value['speech_text']='The request failed. See the full response.' if value['status']=='failed' else 'The result is ready in your conversation.'
        return value
    except (ValueError,TypeError):
        # Preserve the full response but do not read JSON/code or invent success.
        return {'display_text':text[:64000] or 'The agent returned no result.','speech_text':'Please check the response in your conversation.','status':'failed'}


class Connection:
    def __init__(self):
        cmd=[os.getenv('STAPP_CODEX','codex'),'app-server','--listen','stdio://','-c','web_search="live"']
        path=Path(os.getenv('CODEX_HOME',Path.home()/'.codex'))/'config.toml'
        cfg=tomllib.loads(path.read_text()) if path.exists() else {}
        # The CLI's dotted override parser takes literal key segments, not TOML
        # quoted keys. Quoting these names creates an invalid duplicate transport.
        for section in ('mcp_servers','plugins'):
            for name in cfg.get(section,{}): cmd += ['-c',f'{section}.{name}.enabled=false']
        if os.getenv('STAPP_ROHLIK') == '1':
            cmd += ['-c', 'mcp_servers.rohlik.url="https://mcp.rohlik.cz/mcp"',
                    '-c', 'mcp_servers.rohlik.enabled=true']
        env=os.environ.copy()
        for name in ('STAPP_CF_TOKEN','STAPP_PANEL_KEY','STAPP_CF_ACCOUNT','STAPP_CF_CONFIG'):
            env.pop(name,None)
        self.proc=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=None,text=True,encoding='utf-8',bufsize=1,env=env,start_new_session=os.name=='posix')
        self.queue=queue.Queue();self.next_id=0;self.projects={};self.models=None
        self.busy=True; self.used=time.monotonic(); CONNECTIONS.append(self)
        def read():
            try:
                for line in self.proc.stdout:self.queue.put(json.loads(line))
            finally:self.queue.put(None)
        threading.Thread(target=read,daemon=True).start()
        atexit.register(self.close)
        self.request('initialize',{'clientInfo':{'name':'stapp','title':'S.T.','version':'0.2.0'},'capabilities':{'experimentalApi':True}})
        self.send({'method':'initialized','params':{}})

    def send(self, message):
        self.proc.stdin.write(json.dumps(message,ensure_ascii=False)+'\n');self.proc.stdin.flush()

    def receive(self, timeout=30):
        msg=self.queue.get(timeout=timeout)
        if msg is None:raise RuntimeError('Codex app-server disconnected')
        return msg

    def request(self, method, params, heartbeat=None):
        self.next_id+=1; ident=self.next_id
        self.send({'id':ident,'method':method,'params':params})
        end=time.monotonic()+60
        while time.monotonic()<end:
            try:msg=self.receive(.25)
            except queue.Empty:
                if heartbeat:heartbeat()
                continue
            if msg.get('id')==ident:
                if 'error' in msg:raise RuntimeError(msg['error'].get('message','App-server request failed'))
                return msg['result']
            if 'method' in msg and 'id' in msg:
                self.send({'id':msg['id'],'error':{'code':-32601,'message':'No active request for this tool'}})
        raise TimeoutError('App-server request timed out')

    def project(self,cwd,heartbeat):
        if cwd not in self.projects:
            result=self.request('project/create',{'idempotencyKey':'st-assistant-'+hashlib.sha256(cwd.encode()).hexdigest(),'name':os.getenv('STAPP_AGENT_PROJECT_NAME','S.T. assistant'),'roots':[{'path':cwd}]},heartbeat)
            self.projects[cwd]=result['project']['id']
        return self.projects[cwd]

    def close(self):
        if self.proc.poll() is None:
            if os.name=='posix':os.killpg(self.proc.pid,signal.SIGTERM)
            else:self.proc.terminate()
            try:self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:self.proc.kill();self.proc.wait()
        atexit.unregister(self.close)


def connection():
    if getattr(LOCAL,'connection',None) is None or LOCAL.connection.proc.poll() is not None:
        LOCAL.connection=Connection()
    return LOCAL.connection


def execute(job,decision,catalog,emit):
    conn=connection(); conn.busy=True; thread=job.get('thread'); turn_id=None
    last_poll=0
    successful_tools=[]
    def heartbeat():
        nonlocal last_poll
        if time.monotonic()-last_poll>10:
            emit('poll');last_poll=time.monotonic()
    def wait_answer(question):
        emit('question',question)
        while True:
            value=emit('poll')
            if value is not None:return value
            time.sleep(.5)
    def invoke(name,args,call_id):
        if name=='discover_capability':
            route=next((r for r in catalog['routes'] if r['id']==args.get('route')),None)
            if route is None:raise ValueError('Unknown capability')
            context=build_context(job,dict(decision,effective_route=route['id']),catalog)
            return {'capability':route,'manuals':context['initial_context'],'tools':[SCHEMAS[n] for n in route['tools'] if n in SCHEMAS],'invoke':'call_capability_tool'}
        if name=='call_capability_tool':
            name,args=args['name'],args['arguments']
        if name not in SCHEMAS:raise ValueError('Unavailable tool')
        if name=='ask_user':return wait_answer(args['question'])
        if name in capabilities.PATHS:
            emit('poll') # validate the claim before using an auxiliary adapter
            return capabilities.invoke(name,args)
        if name=='list_projects':return rpc({'op':'projects'},job['device'])
        key=hashlib.sha256(json.dumps([name,args],sort_keys=True).encode()).hexdigest()
        return rpc({'op':'tools','name':name,'args':args,'job':job['id'],'claim':job['claim'],'key':key},job['device'])
    cwd=job['cwd']
    if os.getenv('STAPP_SSH'):
        cwd=json.loads(Path(os.environ['STAPP_PC_PROJECT_MAP']).read_text())[job['project']]
    if not Path(cwd).is_dir():raise ValueError('Registered project folder is unavailable')
    assistant=job['project']=='assistant'
    model=os.getenv('STAPP_AGENT_MODEL','gpt-6-luna')
    try:
        context=build_context(job,decision,catalog)
        context.pop('transcript',None)
        opts={'cwd':cwd,'approvalPolicy':'on-request','sandbox':'workspace-write'}
        if assistant:opts.update(model=model,developerInstructions=(
            'You are S.T., an action assistant. The user message is the complete original transcript. '
            'For a requested action you MUST CALL the corresponding dynamic tool, wait for its result, and only then report success. '
            'Tool definitions are callable functions, not examples to simulate. Never invent tool results or merely say an action is done. '
            'For missing capability context CALL discover_capability and then call_capability_tool. '
            'Use ask_user for necessary clarification. Never mutate household data through shell commands or raw database/files. '
            'Keep speech_text within 45 words, in the user language. Return the required JSON only after completing the work. '
            'Routing selects initial context only; correct it through capability discovery when necessary. '
            'Trusted request context: '+json.dumps(context,ensure_ascii=False)
        ))
        if thread:opts['threadId']=thread
        elif assistant:
            opts.update(dynamicTools=selected_tools(decision,catalog),projectId=conn.project(cwd,heartbeat))
        reply=conn.request('thread/resume' if thread else 'thread/start',opts,heartbeat)
        thread=reply['thread']['id'];emit('thread',thread)
        params={'threadId':thread,'input':[{'type':'text','text':job['text']}], 'effort':os.getenv('STAPP_AGENT_EFFORT','low')}
        if assistant:params.update(model=model,outputSchema=OUTPUT_SCHEMA)
        conn.next_id+=1;start_id=conn.next_id
        conn.send({'id':start_id,'method':'turn/start','params':params})
        final=[];started=time.monotonic()
        while True:
            heartbeat()
            try:msg=conn.receive(.25)
            except queue.Empty:continue
            method=msg.get('method');p=msg.get('params',{});ident=msg.get('id')
            if method is None and 'error' in msg:raise RuntimeError(msg['error'].get('message','Agent failed'))
            if method is None and ident==start_id:
                turn_id=msg['result']['turn']['id'];continue
            if method and p.get('threadId') not in (None,thread):continue
            if method=='item/tool/call' and ident is not None:
                try:
                    result=invoke(p['tool'],p['arguments'],p['callId']);success=True
                    successful_tools.append({'tool':p['tool'],'call_id':p['callId']})
                except Exception as error:result={'error':str(error)[:1000]};success=False
                conn.send({'id':ident,'result':{'success':success,'contentItems':[{'type':'inputText','text':json.dumps(result,ensure_ascii=False)}]}})
            elif method=='item/completed' and p['item'].get('type')=='agentMessage':
                final.append(p['item'].get('text',''))
            elif method=='turn/completed':
                if p['turn']['status']!='completed':raise RuntimeError(str(p['turn'].get('error') or p['turn']['status']))
                value=output(final[-1] if final else '') if assistant else {'display_text':final[-1] if final else 'No response.','speech_text':'The project response is ready.','status':'completed'}
                if assistant and decision['effective_route'] not in ('other','agents') and not successful_tools and value['status']=='completed':
                    value={'display_text': 'The agent did not call a tool, so this request has no verified result. No action was confirmed.',
                           'speech_text':'I could not verify that request. No action was confirmed.', 'status':'failed'}
                value['confirmed_tools']=successful_tools
                value['agent_elapsed_ms']=round((time.monotonic()-started)*1000,2)
                emit(value['status'],value['display_text'],value)
                # Release the thread's writer so Herdr can resume it while the
                # app-server process remains warm for unrelated voice requests.
                try:conn.request('thread/unsubscribe',{'threadId':thread})
                except Exception:conn.close()
                return {'thread':thread,**value}
            elif method and ident is not None:
                if method=='item/tool/requestUserInput':
                    answers={}
                    for question in p['questions']:
                        answers[question['id']]={'answers':[wait_answer(question['question'])]}
                    conn.send({'id':ident,'result':{'answers':answers}})
                elif method=='item/permissions/requestApproval':
                    description=p.get('reason') or 'Allow the requested access for this task?'
                    answer=wait_answer(description+' '+json.dumps(p['permissions'],ensure_ascii=False)+' — reply approve or decline')
                    conn.send({'id':ident,'result':{'permissions':p['permissions'] if answer.strip().lower()=='approve' else {},'scope':'turn'}})
                elif method in ('item/commandExecution/requestApproval','item/fileChange/requestApproval'):
                    answer=wait_answer(str(p.get('command') or p.get('reason') or 'Allow this change?')+' — reply approve or decline')
                    conn.send({'id':ident,'result':{'decision':'accept' if answer.strip().lower()=='approve' else 'decline'}})
                else:conn.send({'id':ident,'error':{'code':-32601,'message':'Unsupported request'}})
    except BaseException:
        if thread and turn_id:
            with suppress(Exception):conn.send({'id':'interrupt','method':'turn/interrupt','params':{'threadId':thread,'turnId':turn_id}})
        conn.close();LOCAL.connection=None
        raise
    finally:
        conn.used=time.monotonic();conn.busy=False


def reap_idle():
    for conn in list(CONNECTIONS):
        if not conn.busy and time.monotonic()-conn.used>300:
            conn.close();CONNECTIONS.remove(conn)
