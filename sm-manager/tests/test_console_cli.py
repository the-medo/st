"""CLI contracts against an isolated HTTP gateway, never the owner's agents."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from sm_manager.console_cli import Console, clean

ROOT = Path(__file__).resolve().parents[1]


class ConsoleCli(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.requests = []
        self.status = 200
        self.response = {"snapshot": {"workspaces": [{"workspace_id":"w1","label":"ST"}], "panes": [
            {"pane_id":"w1:p1","workspace_id":"w1","agent":"codex","agent_status":"working","cwd":"/tmp/st","label":"Build"},
            {"pane_id":"w1:p2","workspace_id":"w1","agent":None,"agent_status":"idle"},
        ]}}
        fixture = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                self.reply()
            def do_POST(self):
                self.reply()
            def reply(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                fixture.requests.append((self.command, self.path, json.loads(body) if body else None, dict(self.headers)))
                self.send_response(fixture.status)
                if fixture.status == 302:
                    self.send_header("Location", "http://127.0.0.1:1/never-follow")
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(fixture.response).encode())
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.config = Path(self.temp.name) / "config.json"
        self.config.write_text(json.dumps({"port":self.server.server_port, "data_dir":self.temp.name, "roots":[]}))
        self.env = dict(os.environ, HTTP_PROXY="http://127.0.0.1:1", HTTPS_PROXY="http://127.0.0.1:1", NO_PROXY="", no_proxy="")

    def cli(self, *args, input=None, ok=True):
        result = subprocess.run([sys.executable,"-m","sm_manager","--config",str(self.config),*args], cwd=ROOT,
                                env=self.env, input=input, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode == 0, ok, result.stderr)
        return result

    def test_default_list_filters_shells_and_can_show_all(self):
        data = json.loads(self.cli("agents","--json").stdout)
        self.assertEqual([p["pane_id"] for p in data], ["w1:p1"])
        self.assertEqual(self.requests[0][1], "/agents/api/session")
        data = json.loads(self.cli("agents","list","--all","--json").stdout)
        self.assertEqual(len(data), 2)
        data = json.loads(self.cli("agents","list","--status","idle","--all","--json").stdout)
        self.assertEqual([p["pane_id"] for p in data], ["w1:p2"])
        self.assertEqual(json.loads(self.cli("agents","list","--search","missing","--json").stdout), [])
        self.assertIn("Unknown pane", self.cli("agents","show","w1:p",ok=False).stderr)

    def test_remote_read_uses_machine_route_and_encoded_query(self):
        self.response = {"read":{"text":"hello\x1b[2J world\nsecond line"}}
        result = self.cli("agents","read","w1:p1 & x","--machine","desk pc","--lines","12")
        self.assertEqual(result.stdout, "hello world\nsecond line\n")
        path = urlsplit(self.requests[0][1])
        self.assertEqual(path.path, "/agents/api/machines/desk%20pc/pane/read")
        self.assertEqual(parse_qs(path.query), {"pane_id":["w1:p1 & x"],"source":["recent"],"format":["text"],"lines":["12"]})
        self.cli("agents","--machine","..","list",ok=False)
        self.assertEqual(len(self.requests), 1)

    def test_read_routes_and_history_cursor(self):
        for action, path in [("conversation","conversation"),("plan","plan"),("tasks","omo-tasks"),("prompt","prompt")]:
            self.response = {"sample":action}
            args = ["agents",action,"p1","--json"]
            if action == "conversation":
                args.extend(["--before","opaque+cursor"])
            result = json.loads(self.cli(*args).stdout)
            self.assertEqual(result, self.response)
            parsed = urlsplit(self.requests[-1][1])
            self.assertEqual(parsed.path, "/agents/api/pane/"+path)
            self.assertEqual(parse_qs(parsed.query)["pane_id"], ["p1"])

    def test_machine_kinds_and_workspace_routes(self):
        for action, path, response in [("machines","machines",{"machines":[]}), ("kinds","agents",{"agents":[]})]:
            self.response = response
            self.assertEqual(json.loads(self.cli("agents",action,"--json").stdout), [])
            self.assertEqual(self.requests[-1][1], "/agents/api/"+path)

    def test_prompt_answer_is_bound_to_prompt_id(self):
        self.response = {"ok":True}
        self.cli("agents","answer","p1","question-1","--option","2")
        method, path, body, headers = self.requests[0]
        self.assertEqual((method,path), ("POST","/agents/api/pane/prompt/answer"))
        self.assertEqual(body, {"pane_id":"p1","prompt_id":"question-1","option_index":2})
        self.assertEqual(headers["Origin"], f"http://127.0.0.1:{self.server.server_port}")
        self.cli("agents","answer","p1","question-1","--option","-1",ok=False)
        self.cli("agents","answer","p1","question-1","--option","1","--text","yes",ok=False)
        self.assertEqual(len(self.requests), 1)

    def test_start_and_input_do_not_submit_an_implicit_message(self):
        self.response = {"workspace_id":"new","pane_id":"new:p1","agent_started":True}
        self.cli("agents","start","--cwd","/tmp/path with spaces","--agent","codex","--arg=--model","--arg=test","--label","Work")
        body = self.requests[0][2]
        self.assertEqual(body, {"cwd":"/tmp/path with spaces","agent":{"kind":"codex","args":["--model","test"]},"label":"Work"})
        self.response = {"ok":True}
        self.cli("agents","input","new:p1","-",input="please inspect")
        self.assertEqual(self.requests[-1][1:3], ("/agents/api/pane/input",{"pane_id":"new:p1","text":"please inspect"}))
        self.assertEqual(len(self.requests), 2)
        self.cli("agents","keys","new:p1","Enter")
        self.assertEqual(self.requests[-1][2]["keys"], ["Enter"])
        for invalid in ("\x1b[2J", "unexpected submit\n", "\t"):
            self.cli("agents","input","new:p1","-",input=invalid,ok=False)
        self.cli("agents","start","--cwd","relative/path",ok=False)
        self.assertEqual(len(self.requests), 3)

    def test_backend_errors_partial_starts_and_redirects_fail_once(self):
        self.status = 409
        self.response = {"error":{"code":"stale_prompt","message":"Question changed"}}
        self.assertIn("Question changed", self.cli("agents","answer","p1","old","--text","yes",ok=False).stderr)
        self.assertEqual(len(self.requests), 1)
        self.status = 200
        self.response = {"workspace_id":"created","pane_id":"created:p1","agent_started":False,"error":{"message":"Launch failed"}}
        self.assertIn("created:p1", self.cli("agents","start","--cwd","/tmp",ok=False).stderr)
        self.status = 302
        self.assertIn("HTTP 302", self.cli("agents","list",ok=False).stderr)
        self.assertEqual(len(self.requests), 3)

    def test_transport_failure_never_retries_a_write(self):
        console = Console({"port":self.server.server_port})
        with patch.object(console.opener,"open",side_effect=TimeoutError("timeout")) as opened:
            with self.assertRaisesRegex(RuntimeError,"may have reached"):
                console.request("/agents/api/pane/input",body={"pane_id":"p","text":"once"})
            opened.assert_called_once()

    def test_resources_preserve_ownership_and_warn_about_staleness(self):
        self.response = {"stale":True,"projects":[{"id":"project-1","name":"st","worktrees":[
            {"id":"w1","branch":"feature/st-cli","path":"/tmp/st","running":True,"containers":[{"id":"c1","name":"app"}]},
            {"id":"w2","branch":"main","running":False,"containers":[]},
        ]}],"unassigned_containers":[{"id":"c2","name":"other"}]}
        result = self.cli("worktrees","--running","--project","st","--search","st-cli","--json")
        self.assertEqual([r["id"] for r in json.loads(result.stdout)], ["w1"])
        self.assertIn("stale", result.stderr)
        data = json.loads(self.cli("containers","--json").stdout)
        self.assertEqual([(r["id"],r["worktree_id"]) for r in data], [("c1","w1"),("c2",None)])
        self.assertEqual(len(json.loads(self.cli("containers","--project","project-1","--json").stdout)), 1)

    def test_terminal_escape_sequences_are_not_emitted(self):
        self.assertEqual(clean("a\x1b]52;c;clipboard\x07b\x1b[31mc\x00"), "abc")


if __name__ == "__main__":
    unittest.main()
