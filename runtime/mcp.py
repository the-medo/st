"""Local stdio MCP adapter. Tool mutations are bound to one active Codex request."""

import hashlib
import json
import os
import sys
import uuid
from transport import rpc


def property_(kind, **extra):
    return {"type": kind, **extra}


S = {"type": "string"}
I = {"type": "integer"}


def tool(tool_name, description, required, **props):
    return {
        "name": tool_name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "required": required,
            "properties": props,
            "additionalProperties": False,
        },
    }


TOOLS = [
    tool(
        "ask_user",
        "Ask the originating device a clarification and wait for its answer.",
        ["question"],
        question=S,
    ),
    tool("list_records", "Read tasks, notes and calendar events.", []),
    tool(
        "save_record",
        "Create or update a task, note or calendar event. Include local date/time and IANA zone for events.",
        ["kind", "title"],
        kind=property_("string", enum=["task", "event", "note"]),
        title=S,
        id=I,
        starts=S,
        zone=S,
        done=property_("boolean"),
    ),
    tool(
        "save_view",
        "Save a named layout. Dashboard widgets may be calendar, tasks, notes or clock. Photo/app views require an installed asset ID.",
        ["name", "spec"],
        name=S,
        spec={"type": "object"},
    ),
    tool(
        "show_view",
        "Show an existing view on the living-room panel only when the user requests display there.",
        ["name"],
        name=S,
    ),
    tool(
        "publish_app",
        "Install a self-contained HTML faceplate app. Use inline CSS and JavaScript; external resources are blocked.",
        ["name", "html"],
        name=S,
        html=S,
    ),
    tool("list_projects", "List registered projects and execution hosts.", []),
    tool(
        "start_project_task",
        "Start a new conversation in a registered project. Optionally create a new project before starting.",
        ["project", "text"],
        project=S,
        text=S,
        create=property_("boolean"),
    ),
]


def dispatch(method, params, call_id):
    if method == "initialize":
        return {
            "protocolVersion": params.get("protocolVersion", "2024-11-05"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "stapp", "version": "0.1.0"},
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method != "tools/call":
        raise KeyError(method)
    name = params["name"]
    args = params.get("arguments", {})
    if name not in {t["name"] for t in TOOLS}:
        raise ValueError("Unknown tool")
    operation = hashlib.sha256(
        json.dumps([name, args], sort_keys=True).encode()
    ).hexdigest()
    if name == "ask_user":
        request_id = "question-" + str(uuid.uuid4())
        question = {
            "message": args["question"],
            "requestedSchema": {
                "type": "object",
                "properties": {"answer": {"type": "string"}},
                "required": ["answer"],
            },
        }
        print(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "elicitation/create",
                    "params": question,
                }
            ),
            flush=True,
        )
        for line in sys.stdin:
            response = json.loads(line)
            if response.get("id") == request_id:
                if response.get("result", {}).get("action") != "accept":
                    raise ValueError("Question closed")
                res = response["result"]["content"]["answer"]
                break
        else:
            raise ValueError("Assistant disconnected")
    elif name == "list_projects":
        res = rpc({"op": "projects"})
    else:
        res = rpc(
            {
                "op": "tools",
                "name": name,
                "args": args,
                "job": os.environ["STAPP_JOB"],
                "claim": os.environ["STAPP_CLAIM"],
                "key": operation,
            }
        )
    return {"content": [{"type": "text", "text": json.dumps(res, ensure_ascii=False)}]}


for line in sys.stdin:
    msg = {}
    try:
        msg = json.loads(line)
        if "id" not in msg:
            continue
        result = dispatch(msg["method"], msg.get("params", {}), msg["id"])
        reply = {"result": result}
    except Exception as exc:
        reply = (
            {
                "result": {
                    "isError": True,
                    "content": [{"type": "text", "text": str(exc)}],
                }
            }
            if msg.get("method") == "tools/call"
            else {"error": {"code": -32601, "message": str(exc)}}
        )
    print(json.dumps(dict(reply, jsonrpc="2.0", id=msg.get("id"))), flush=True)
