"""Execute queued tasks with the installed Codex app-server; reconnect by stored thread ID."""
import argparse
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import tomllib
import urllib.request
from contextlib import suppress
from pathlib import Path
from transport import rpc

CAPABILITIES={"project":"Work on a registered project","general":"General assistant","display":"Show or compose the faceplate","calendar":"Calendar, notes and tasks","shopping.rohlik":"Find groceries and manage the Rohlík cart"}
def route(job):
    text=job["text"].lower()
    if job["project"]!="assistant":return "project"
    if "rohl" in text:return "shopping.rohlik"
    account=os.getenv("STAPP_CF_ACCOUNT");token=os.getenv("STAPP_CF_TOKEN")
    if not account or not token:return "general"
    body={"messages":[{"role":"system","content":"Select exactly one route ID. Return only that ID. "+json.dumps(CAPABILITIES)},{"role":"user","content":job["text"]}],"max_tokens":16,"temperature":0}
    req=urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/ibm-granite/granite-4.0-h-micro",data=json.dumps(body).encode(),headers={"Authorization":"Bearer "+token,"Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(req,timeout=2) as resp:
            val=json.load(resp)["result"]["response"].strip().strip('"')
            return val if val in CAPABILITIES else "general"
    except Exception:
        return "general"

def run(job):
    def emit(kind, text=""):
        return rpc({"op":"worker_event","kind":kind,"text":text,"id":job["id"],"claim":job["claim"]})
    prompt=job["text"].strip()
    if job["project"]=="assistant" and prompt.lower() in ("show home","show clock","show the clock"):
        view="home" if "home" in prompt.lower() else "clock"
        rpc({"op":"tools","name":"show_view","args":{"name":view},"job":job["id"],"claim":job["claim"],"key":"direct-display"},job["device"])
        emit("completed","Showing "+view+" on the faceplate.");return
    cwd=Path(job["cwd"])
    if os.getenv("STAPP_SSH"):
        # The PC owner registers local checkout paths independently of the remote task.
        paths=json.loads(Path(os.environ["STAPP_PC_PROJECT_MAP"]).read_text())
        cwd=Path(paths[job["project"]])
    if not cwd.is_dir():raise ValueError("Registered project folder is unavailable")
    codex=os.environ.get("STAPP_CODEX","codex")
    cmd=[codex,"app-server","--listen","stdio://"]
    def setting(key,value):cmd.extend(["-c",key+"="+value])
    config=Path(os.environ.get("CODEX_HOME",Path.home()/".codex"))/"config.toml"
    configured=tomllib.loads(config.read_text()) if config.is_file() else {}
    for server in configured.get("mcp_servers",{}):
        setting("mcp_servers."+json.dumps(server)+".enabled","false")
    for plugin in configured.get("plugins",{}):
        setting("plugins."+json.dumps(plugin)+".enabled","false")
    env=os.environ.copy()
    # Do not pass the Cloudflare kernel's API token through to the agent or MCP servers.
    env.pop("STAPP_CF_TOKEN",None);env.pop("STAPP_PANEL_KEY",None)
    skill=route(job)
    if job["project"]=="assistant":
        script=str(Path(__file__).with_name("mcp.py").resolve())
        setting("mcp_servers.stapp.command",json.dumps(sys.executable))
        setting("mcp_servers.stapp.args",json.dumps([script]))
        for key,value in {"STAPP_DEVICE":job["device"],"STAPP_JOB":job["id"],"STAPP_CLAIM":job["claim"],"STAPP_DATA":os.environ["STAPP_DATA"]}.items():
            setting("mcp_servers.stapp.env."+key,json.dumps(value))
        if os.getenv("STAPP_ROHLIK")=="1":
            setting("mcp_servers.rohlik.url",json.dumps("https://mcp.rohlik.cz/mcp"))
            setting("mcp_servers.rohlik.enabled","true")
    proc=subprocess.Popen(cmd,cwd=cwd,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,encoding="utf-8",bufsize=1)
    messages=queue.Queue()
    def read():
        try:
            for line in proc.stdout: messages.put(json.loads(line))
        finally: messages.put(None)
    threading.Thread(target=read,daemon=True).start()
    def send(msg):
        proc.stdin.write(json.dumps(msg)+"\n");proc.stdin.flush()
    def request(i,method,params):send({"id":i,"method":method,"params":params})
    pending=None; last_poll=time.monotonic(); final=[];thread=job["thread"]
    try:
        request(1,"initialize",{"clientInfo":{"name":"stapp","title":"S.T.","version":"0.1.0"}})
        while True:
            if time.monotonic()-last_poll >= (1 if pending else 12):
                answer=emit("poll");last_poll=time.monotonic()
                if pending and answer is not None:
                    msg_id,method,params=pending;pending=None
                    if method=="item/tool/requestUserInput":
                        # One answer string, or a JSON map for multi-question prompts.
                        questions=params["questions"]
                        values=json.loads(answer) if len(questions)>1 else {questions[0]["id"]:answer}
                        result={"answers":{q["id"]:{"answers":[str(values[q["id"]])]} for q in questions}}
                    else: result={"decision":"accept" if answer.strip().lower()=="approve" else "decline"}
                    send({"id":msg_id,"result":result})
            try:msg=messages.get(timeout=.25)
            except queue.Empty:continue
            if msg is None:raise RuntimeError("Codex app-server stopped before completion")
            method=msg.get("method");params=msg.get("params",{});i=msg.get("id")
            if not method and "error" in msg: raise RuntimeError(msg["error"].get("message","Codex error"))
            if not method and i==1:
                send({"method":"initialized","params":{}})
                opts={"cwd":str(cwd),"approvalPolicy":"on-request","sandbox":"workspace-write"}
                if thread:opts["threadId"]=thread
                request(2,"thread/resume" if thread else "thread/start",opts)
            elif not method and i==2:
                thread=msg["result"]["thread"]["id"];emit("thread",thread)
                context=("Use the shopping skill and Rohlík MCP when available. " if skill=="shopping.rohlik" else "")
                if job["project"]=="assistant": context+="Use the stapp tools for confirmed actions. "
                request(3,"turn/start",{"threadId":thread,"input":[{"type":"text","text":context+prompt}]})
            elif method=="item/completed" and params["item"].get("type")=="agentMessage":
                final.append(params["item"].get("text",""))
            elif method=="turn/completed":
                turn=params["turn"]
                if turn["status"]!="completed":raise RuntimeError(str(turn.get("error") or turn["status"]))
                emit("completed",final[-1] if final else "Done.");return
            elif method and i is not None:
                if method in ("item/commandExecution/requestApproval","item/fileChange/requestApproval","item/tool/requestUserInput") and pending is None:
                    pending=(i,method,params)
                    detail=params.get("questions") or params.get("command") or params.get("reason") or method
                    emit("question",json.dumps(detail,ensure_ascii=False)+( "" if method=="item/tool/requestUserInput" else " — reply approve or decline"))
                else:send({"id":i,"error":{"code":-32601,"message":"Unsupported interactive request"}})
    finally:
        proc.stdin.close()
        try:proc.wait(timeout=3)
        except subprocess.TimeoutExpired:proc.kill();proc.wait()

def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    while True:
        try:
            job=rpc({"op":"claim_job"})
            if not job:time.sleep(.3 if not os.environ.get("STAPP_SSH") else 3);continue
            try:run(job)
            except Exception as exc:
                with suppress(Exception):
                    rpc({"op":"worker_event","kind":"failed","id":job["id"],"claim":job["claim"],"text":str(exc)[:2000]})
        except (ValueError,OSError,subprocess.SubprocessError) as exc:
            print("Worker unavailable:",type(exc).__name__,file=sys.stderr,flush=True);time.sleep(3)
if __name__=="__main__":main()
