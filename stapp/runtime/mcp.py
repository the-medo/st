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
RID = {"anyOf": [I, S]}
NULLABLE_S = {"type": ["string", "null"]}
RECURRENCE = {
    "type": ["object", "null"],
    "properties": {
        "frequency": {"type": "string", "enum": ["daily", "weekly", "monthly", "yearly"]},
        "interval": {"type": "integer", "minimum": 1, "maximum": 100},
        "mode": {"type": "string", "enum": ["due", "completion"]},
        "weekdays": {"type": "array", "items": {"type": "string", "enum": ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]}},
        "count": {"type": "integer", "minimum": 1},
        "until": S,
    },
    "required": ["frequency"],
    "additionalProperties": False,
}


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
    tool("photos_status", "Check the private Immich photo backend and get its browser URL.", []),
    tool("photos_albums", "List albums accessible to the configured S.T. Immich account.", []),
    tool("photos_recent", "List recent timeline photos from the configured S.T. account, with links.", [], limit=I, page=I),
    tool("photos_search", "Search Immich by filename, or image content when semantic=true. Only the configured account's accessible library is searched.", ["query"], query=S, semantic=property_("boolean"), limit=I, page=I),
    tool("photos_show", "Show a chosen Immich photo preview on the shared living-room faceplate, only when the user explicitly requests it. The preview remains cached in S.T.", ["id"], id=S),
    tool(
        "ask_user",
        "Ask the originating device a clarification and wait for its answer.",
        ["question"],
        question=S,
    ),
    tool("list_records", "Read tasks, notes and calendar events.", []),
    tool(
        "save_record",
        "Create or update a task, note or calendar event. For existing planner records send their current version. Use complete_task to advance recurrence. Notes stay local; tasks/events use the configured planner. Events require starts and zone; ends is exclusive for all-day events.",
        ["kind", "title"],
        kind=property_("string", enum=["task", "event", "note"]),
        title=S,
        body=S,
        id=RID,
        version=RID,
        starts=S,
        ends=NULLABLE_S,
        zone=S,
        due=NULLABLE_S,
        project_id=NULLABLE_S,
        parent_id=NULLABLE_S,
        priority={"type": "integer", "minimum": 0, "maximum": 9, "description": "1 is highest, 0 is unset"},
        labels={"type": "array", "items": S},
        recurrence=RECURRENCE,
        done=property_("boolean"),
    ),
    tool("get_record", "Read a planner record and its current version before editing.", ["id"], id=S),
    tool("list_task_projects", "List personal task projects; these are separate from coding workspaces.", []),
    tool("save_task_project", "Create or edit a personal task project. Existing projects require their current version. Color is #RRGGBB. visible_on_screen controls its tasks on all faceplates; hidden tasks remain available to the assistant.", ["title"], title=S, body=S, id=S, version=S,
         color={"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"}, visible_on_screen=property_("boolean")),
    tool("complete_task", "Complete one occurrence. The backend records history and advances a recurring task. Send the current version; do not repeat with a new version unless the next occurrence was also completed.", ["id", "version"], id=S, version=S),
    tool("delete_record", "Delete a planner task, event or empty task project. Requires its current version.", ["id", "version"], id=S, version=S),
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


def main():
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


if __name__ == "__main__":
    main()
