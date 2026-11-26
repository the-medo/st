"""Small read adapters to the installed local monitor's business APIs."""
import json
import os
import urllib.request
from mcp import tool

TOOLS = [
    tool('system_status','Read current Steam Machine CPU, memory, swap and collector freshness.',[]),
    tool('database_status','List configured database connections, ownership, reachability and freshness. Does not run SQL.',[]),
    tool('air_quality','Read recent household air sensor measurements and their timestamps.',[]),
]
PATHS={'system_status':'/api/snapshot','database_status':'/api/dbs','air_quality':'/api/air-quality?hours=1&bucket=300'}


def invoke(name, args):
    if args: raise ValueError('This read tool takes no arguments')
    port=int(os.getenv('STAPP_MONITOR_PORT','8790'))
    if not 1024<=port<=65535:raise ValueError('Invalid monitor port')
    # Fixed loopback endpoint and fixed paths; model input cannot choose a host/URL.
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f'http://127.0.0.1:{port}'+PATHS[name],timeout=10) as response:
        raw=response.read(4_000_001)
    if len(raw)>4_000_000:raise ValueError('Monitor response is too large')
    result=json.loads(raw)
    if name=='system_status':
        result={k:result[k] for k in ('system','stale','sampled_at','updated_at','timestamp','error') if k in result}
    return result
