"""Owner CLI for the existing monitor and Agents gateway; no direct state access."""
import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


def positive(value):
    number = int(value)
    if not 1 <= number <= 10000:
        raise argparse.ArgumentTypeError("choose an integer from 1 to 10000")
    return number


def nonnegative(value):
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError("choose a nonnegative integer")
    return number


def conversation_thread(value):
    """Extract a stable thread reference; links are never fetched as arbitrary URLs."""
    link = value.startswith(("https://", "http://"))
    explicit = value.startswith("medo:")
    candidate = value
    if link:
        url = urllib.parse.urlsplit(value)
        ids = urllib.parse.parse_qs(url.query).get("saved", [])
        candidate = ids[0] if url.path.rstrip("/") == "/agents" and len(ids) == 1 else ""
    elif explicit:
        candidate = value[5:]
    if re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", candidate):
        return candidate.lower()
    if link or explicit:
        raise ValueError("Choose a copied Agents conversation link or conversation ID")
    return None


def add_commands(sub):
    agents = sub.add_parser("agents", help="Browse and control Agents through the local ST gateway")
    agents.add_argument("--machine", default="local", help="Machine ID from agents machines (default: local)")
    agents.add_argument("--json", action="store_true", help="Print the complete JSON result")
    commands = agents.add_subparsers(dest="action")

    def command(name, help, pane=False):
        parser = commands.add_parser(name, help=help, description=help)
        # Allow connection/output flags on either side of the subcommand.
        parser.add_argument("--machine", default=argparse.SUPPRESS)
        parser.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        if pane:
            parser.add_argument("pane", help="Exact pane ID from agents list")
        return parser

    listing = command("list", "List active agent panes; use --all to include shells")
    listing.add_argument("--all", action="store_true")
    listing.add_argument("--status", help="Filter agent status (working, blocked, idle, done, unknown)")
    listing.add_argument("--workspace", help="Filter by exact workspace ID")
    listing.add_argument("--search", help="Search labels, agent kinds and working directories")
    command("machines", "List connected machines and availability")
    command("kinds", "List agent kinds the selected machine can start")
    command("workspaces", "List agent workspaces on the selected machine")
    command("show", "Inspect one agent pane", pane=True)
    output = command("read", "Read terminal output without attaching or resizing", pane=True)
    output.add_argument("--lines", type=positive, default=80)
    output.add_argument("--source", choices=["visible", "recent", "recent_unwrapped"], default="recent")
    conversation = command("conversation", "Read structured conversation history")
    conversation.add_argument("pane", help="Pane ID, conversation ID, or copied conversation link")
    conversation.add_argument("--before", help="Opaque paging cursor returned by the server")
    command("plan", "Read the agent's current plan", pane=True)
    command("tasks", "Read the agent's background tasks", pane=True)
    command("prompt", "Read the current interactive question and its prompt ID", pane=True)
    answer = command("answer", "Answer a specific prompt ID returned by agents prompt", pane=True)
    answer.add_argument("prompt_id")
    choices = answer.add_mutually_exclusive_group(required=True)
    choices.add_argument("--option", type=nonnegative, help="Zero-based option index")
    choices.add_argument("--text", help="Custom answer text")
    rename = command("rename", "Rename the live agent in a pane", pane=True)
    rename.add_argument("name")
    start = command("start", "Create a workspace and start an agent; returns its pane ID")
    start.add_argument("--cwd", required=True, help="Absolute directory on the selected machine")
    start.add_argument("--agent", default="codex")
    start.add_argument("--name")
    start.add_argument("--label")
    start.add_argument("--arg", action="append", default=[], help="Agent argument; use --arg=--flag")
    inp = command("input", "Type literal text in a pane; does not press Enter", pane=True)
    inp.add_argument("text", help="Single-line text, or - to read stdin")
    keys = command("keys", "Send explicit terminal keys, e.g. Enter or ctrl+c", pane=True)
    keys.add_argument("keys", nargs="+")
    for name, help in [("worktrees", "List monitored Git worktrees and resources"),
                       ("containers", "List monitored containers and their owners")]:
        parser = sub.add_parser(name, help=help)
        parser.add_argument("--json", action="store_true")
        parser.add_argument("--project", help="Filter by project name or ID")
        parser.add_argument("--search", help="Match name, branch, ID or path")
        if name == "worktrees":
            parser.add_argument("--running", action="store_true", help="Only worktrees using resources")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Console:
    def __init__(self, config):
        self.origin = f"http://127.0.0.1:{int(config['port'])}"
        # Private owner calls stay on loopback even with HTTP_PROXY set.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, path, params=None, body=None):
        url = self.origin + path
        if params:
            url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
            headers={"Accept": "application/json", "Content-Type": "application/json", "Origin": self.origin})
        try:
            with self.opener.open(request, timeout=80 if path.endswith("/workspace/create") else 35) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            try:
                detail = json.load(error).get("error", {})
                if isinstance(detail, dict):
                    detail = detail.get("message") or detail.get("code")
            except (ValueError, AttributeError):
                detail = None
            raise RuntimeError(f"ST request failed (HTTP {error.code}): {detail or 'endpoint unavailable'}") from None
        except (OSError, ValueError) as error:
            suffix = " The write may have reached the server; inspect its state before sending it again." if body is not None else ""
            raise RuntimeError(f"ST console unavailable: {error}.{suffix}") from None
        if isinstance(result, dict) and (result.get("error") or result.get("agent_started") is False):
            # Workspace creation can partially succeed; retain its IDs in the error.
            raise RuntimeError("ST operation was not completed: " + json.dumps(result, ensure_ascii=False))
        return result

    def agents(self, args):
        action = args.action or "list"
        if action == "machines":
            return self.request("/agents/api/machines")["machines"]
        machine = args.machine
        if not machine or machine in {".", ".."} or any(c in machine for c in "/\\"):
            raise ValueError("Invalid machine ID")
        prefix = "/agents/api/" if machine == "local" else "/agents/api/machines/" + urllib.parse.quote(machine, safe="") + "/"

        def request(path, params=None, body=None):
            return self.request(prefix + path, params, body)

        if action == "kinds":
            return request("agents")["agents"]
        if action in {"list", "workspaces", "show"}:
            snapshot = request("session")["snapshot"]
            if action == "workspaces":
                return snapshot["workspaces"]
            panes = snapshot["panes"]
            if action == "show":
                found = next((pane for pane in panes if pane["pane_id"] == args.pane), None)
                if found is None:
                    raise ValueError("Unknown pane on this machine; use st agents list --all")
                return found
            return [p for p in panes if (getattr(args, "all", False) or p.get("agent"))
                    and (not getattr(args, "status", None) or p.get("agent_status") == args.status)
                    and (not getattr(args, "workspace", None) or p.get("workspace_id") == args.workspace)
                    and matches(p, getattr(args, "search", None))]
        if action == "start":
            if not (args.cwd.startswith("/") or re.match(r"^[A-Za-z]:[/\\]", args.cwd) or args.cwd.startswith("\\\\")):
                raise ValueError("--cwd must be an absolute path on the selected machine")
            body = {"cwd": args.cwd, "agent": {"kind": args.agent}}
            if args.name:
                body["agent"]["name"] = args.name
            if args.arg:
                body["agent"]["args"] = args.arg
            if args.label:
                body["label"] = args.label
            return request("workspace/create", body=body)
        params = {"pane_id": args.pane}
        if action == "read":
            return request("pane/read", {**params, "lines": args.lines, "source": args.source, "format": "text"})
        if action in {"conversation", "plan", "tasks", "prompt"}:
            endpoint = "omo-tasks" if action == "tasks" else action
            if action == "conversation":
                params["before"] = args.before
                thread = conversation_thread(args.pane)
                if thread:
                    if machine != "local":
                        raise ValueError("Saved conversation IDs and links belong to the local ST gateway")
                    return request("medo/conversation", {**params, "pane_id": "medo:" + thread})
            return request("pane/" + endpoint, params)
        if action == "answer":
            body = {**params, "prompt_id": args.prompt_id}
            body["option_index" if args.option is not None else "custom_text"] = args.option if args.option is not None else args.text
            return request("pane/prompt/answer", body=body)
        if action == "rename":
            return request("agent/rename", body={**params, "name": args.name})
        if action == "input":
            text = sys.stdin.read() if args.text == "-" else args.text
            # Raw newlines/escape codes can submit or control the terminal unexpectedly.
            if any(ord(c) < 32 for c in text) or "\x7f" in text:
                raise ValueError("Input must be a single line without terminal controls; use agents keys for keys")
            return request("pane/input", body={**params, "text": text})
        if action == "keys":
            return request("pane/keys", body={**params, "keys": args.keys})
        raise ValueError("Unknown agent command")

    def resources(self, args):
        snapshot = self.request("/api/snapshot")
        if snapshot.get("stale"):
            print("Warning: the monitor sample is stale.", file=sys.stderr)
        items = []
        for project in snapshot["projects"]:
            if args.project and args.project not in (project["id"], project["name"]):
                continue
            for worktree in project["worktrees"]:
                if args.command == "worktrees":
                    if args.running and not worktree["running"]:
                        continue
                    items.append({**worktree, "project": project["name"]})
                else:
                    items.extend({**c, "project": project["name"], "worktree_id": worktree["id"]} for c in worktree["containers"])
        if args.command == "containers" and not args.project:
            items.extend({**c, "project": None, "worktree_id": None} for c in snapshot["unassigned_containers"])
        return [item for item in items if matches(item, args.search)]


def matches(item, search):
    return not search or any(search.casefold() in str(item.get(key) or "").casefold() for key in
        ("id", "pane_id", "name", "label", "title", "agent", "cwd", "foreground_cwd", "branch", "path", "project"))


def clean(value):
    # Terminal output is untrusted; never let an agent's output execute OSC/CSI.
    value = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", str(value))
    value = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)
    return "".join(c for c in value if c in "\n\t" or (c.isprintable() and c != "\x1b"))


def display(data, args):
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    elif args.command == "agents" and args.action == "read":
        print(clean(data["read"]["text"]))
    elif isinstance(data, list):
        if not data:
            print("No matches.")
            return
        if args.command == "worktrees":
            fields = ("id", "project", "branch", "path", "memory_bytes", "cpu_percent")
        elif args.command == "containers":
            fields = ("id", "name", "project", "worktree_id", "memory_bytes", "cpu_percent")
        elif args.action == "machines":
            fields = ("id", "name", "kind", "state", "error")
        elif args.action == "kinds":
            fields = ("kind", "label", "installed")
        elif args.action == "workspaces":
            fields = ("workspace_id", "label", "agent_status", "pane_count")
        else:
            fields = ("pane_id", "agent", "agent_status", "workspace_id", "label", "cwd")
        rows = [[clean(item.get(f) if item.get(f) is not None else "-").replace("\n", " ").replace("\t", " ") for f in fields] for item in data]
        widths = [max(len(f), *(len(row[i]) for row in rows)) for i, f in enumerate(fields)]
        for row in [list(fields), *rows]:
            print("  ".join(v.ljust(w) for v, w in zip(row, widths)).rstrip())
    else:
        print(json.dumps(data, ensure_ascii=False, indent=2))


def run(args, config, parser):
    try:
        console = Console(config)
        data = console.agents(args) if args.command == "agents" else console.resources(args)
        display(data, args)
    except (OSError, ValueError, RuntimeError, KeyError, TypeError) as error:
        parser.exit(1, clean(str(error)) + "\n")
