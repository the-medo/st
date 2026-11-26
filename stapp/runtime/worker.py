"""Durable assistant coordinator: Clef Flash context hints, reusable Codex workers."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from agent import execute, reap_idle
from routing import ROUTER, load_catalog
from transport import rpc


def run(job):
    def emit(kind,text='',payload=None):
        return rpc({'op':'worker_event','kind':kind,'text':text,'payload':payload,'id':job['id'],'claim':job['claim']})
    if os.getenv('STAPP_ASSISTANT_PROFILE','clef')=='legacy':
        from worker_legacy import run as legacy
        return legacy(job)
    try:
        catalog=load_catalog()
    except (OSError,ValueError,KeyError):
        # A broken install still provides the original text to a general agent.
        catalog={'catalog_version':'unavailable','instructions':'','routes':[{'id':'other','description':'General assistant','status':'fallback','manuals':[],'tools':[]} ]}
        decision={'effective_route':'other','reason':'catalog_unavailable','role':'advisory'}
    else:decision=ROUTER.decide(job,catalog)
    emit('routing','',decision)
    emit('acknowledged','I’ll take a look.',{'speech_text':'I’ll take a look.'})
    return execute(job,decision,catalog,emit)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-router',action='store_true',help='Classify one synthetic phrase; no agents or jobs')
    args=parser.parse_args()
    if args.check_router:
        result=ROUTER.decide({'project':'assistant','text':'Check the system memory usage.'},load_catalog())
        print(json.dumps(result));return 0 if result['reason']=='classified' else 1
    def work(job):
        try:run(job)
        except Exception as exc:
            with suppress(Exception):rpc({'op':'worker_event','kind':'failed','id':job['id'],'claim':job['claim'],'text':str(exc)[:2000],'payload':{'speech_text':'The request failed. Please check its details.'}})
    with ThreadPoolExecutor(max_workers=2,thread_name_prefix='st-agent') as pool:
        active=set()
        while True:
            active={t for t in active if not t.done()}
            if not active:reap_idle()
            if len(active)>=2:time.sleep(.25);continue
            try:
                job=rpc({'op':'claim_job'})
                if job:active.add(pool.submit(work,job))
                else:time.sleep(3 if os.getenv('STAPP_SSH') else .3)
            except (ValueError,OSError,subprocess.SubprocessError) as exc:
                print('Worker unavailable:',type(exc).__name__,file=sys.stderr,flush=True);time.sleep(3)


if __name__=='__main__':raise SystemExit(main())
