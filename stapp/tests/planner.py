"""Exercise the actual CalDAV server, recurrence, recovery and ST HTTP/MCP bridge."""

import concurrent.futures
import importlib.util
import json
import os
import runpy
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid
from unittest import mock
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("st_planner", ROOT / "runtime/planner.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
Planner, PlannerError = module.Planner, module.PlannerError


def port():
    with socket.socket() as check:
        check.bind(("127.0.0.1", 0))
        return check.getsockname()[1]


class Backend(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import bcrypt
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        cls.port = port()
        users = cls.root / "users"
        users.write_text("stapp:" + bcrypt.hashpw(b"test", bcrypt.gensalt(rounds=4)).decode())
        config = cls.root / "config"
        config.write_text(f"""[server]
hosts = 127.0.0.1:{cls.port}
[auth]
type = htpasswd
htpasswd_filename = {users}
htpasswd_encryption = bcrypt
[rights]
type = owner_only
[storage]
filesystem_folder = {cls.root}/collections
[logging]
level = error
""")
        cls.log = (cls.root / "radicale.log").open("w+")
        cls.server = subprocess.Popen([sys.executable, "-m", "radicale", "--config", str(config)], stdout=cls.log, stderr=cls.log)
        for _ in range(150):
            if cls.server.poll() is not None:
                cls.log.seek(0)
                raise RuntimeError(cls.log.read())
            try:
                with socket.create_connection(("127.0.0.1", cls.port), timeout=.1):
                    return
            except OSError:
                time.sleep(.03)
        raise RuntimeError("Radicale did not start")

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=5)
        cls.log.close()
        cls.tmp.cleanup()

    def setUp(self):
        self.data = self.root / str(uuid.uuid4())
        self.config = {"url": f"http://127.0.0.1:{self.port}/stapp/{self.data.name}/", "username": "stapp", "password": "test"}
        self.planner = Planner(self.config, self.data)
        self.addCleanup(self.planner.db.close)
        self.planner.dav.ensure_collection()

    def call(self, action, args=None, key=None):
        return self.planner.call({"action": action, "args": args or {}, "key": key or str(uuid.uuid4())})

    def save(self, **args):
        return self.call("save", args)

    def complete(self, record, key=None):
        return self.call("complete", {"id": record["id"], "version": record["version"]}, key)

    def test_projects_subtasks_and_conflicts(self):
        project = self.save(kind="project", title="House")
        task = self.save(kind="task", title="Filter", project_id=project["id"], labels=["printer"], priority=1, body="Check both sides")
        child = self.save(kind="task", title="Remove cover", project_id=project["id"], parent_id=task["id"])
        self.assertEqual(self.call("get", {"id": task["id"]})["labels"], ["printer"])
        with self.assertRaises(PlannerError):
            self.save(id=task["id"], version=task["version"], parent_id=child["id"])
        with self.assertRaises(PlannerError):
            self.call("delete", {"id": project["id"], "version": project["version"]})
        renamed = self.save(id=task["id"], version=task["version"], title="Printer filter")
        with self.assertRaises(PlannerError) as error:
            self.save(id=task["id"], version=task["version"], title="Stale title")
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(renamed["body"], "Check both sides")

    def test_weekly_completion_retry_and_end_count(self):
        task = self.save(kind="task", title="Bins", due="2026-11-23", recurrence={"frequency": "weekly", "count": 2})
        first = self.complete(task, "once")
        self.assertEqual((first["due"], first["done"], first["completion_count"]), ("2026-11-30", False, 1))
        self.assertEqual(first, self.complete(task, "once"))
        with self.assertRaises(PlannerError):
            self.complete(task, "different")
        last = self.complete(first)
        self.assertTrue(last["done"])
        self.assertEqual(len(last["history"]), 2)
        renamed = self.save(id=last["id"], version=last["version"], title="Finished bins")
        self.assertTrue(renamed["done"])
        reopened = self.save(id=renamed["id"], version=renamed["version"], done=False)
        self.assertFalse(reopened["done"])
        self.assertEqual(len(self.call("list")["records"]), 1)

    def test_project_color_and_visibility_persist_and_validate(self):
        project = self.save(kind="project", title="House")
        self.assertEqual((project["color"], project["visible_on_screen"]), ("#8aa7ff", True))
        changed = self.save(id=project["id"], version=project["version"], color="#AABBCC", visible_on_screen=False)
        renamed = self.save(id=changed["id"], version=changed["version"], title="Home")
        restarted = Planner(self.config, self.data)
        self.addCleanup(restarted.db.close)
        saved = restarted.dav.get(project["id"])
        self.assertEqual((saved["title"], saved["color"], saved["visible_on_screen"]), ("Home", "#aabbcc", False))
        for patch in ({"color":"red"}, {"color":"#fff"}, {"color":None}, {"visible_on_screen":"false"}, {"visible_on_screen":0}):
            with self.assertRaises(PlannerError) as error:
                self.save(id=renamed["id"], version=renamed["version"], **patch)
            self.assertEqual(error.exception.status, 400)
        with self.assertRaises(PlannerError):
            self.save(kind="task", title="Invalid", color="#aabbcc")
        # Existing Radicale project resources need no destructive rewrite.
        legacy = {k:v for k,v in saved.items() if k not in ("color", "visible_on_screen")}
        read = module.decode(module.encode(legacy), saved["version"])
        self.assertEqual((read["color"], read["visible_on_screen"]), ("#8aa7ff", True))

    def test_completion_relative_and_monthly_rules(self):
        task = self.save(kind="task", title="Filter", due="2020-01-01", recurrence={"frequency": "weekly", "mode": "completion"})
        result = self.complete(task)
        now = datetime.fromisoformat(result["last_completed_at"]).astimezone(module.ZoneInfo("Europe/Prague"))
        self.assertEqual(result["due"], (now.date() + timedelta(days=7)).isoformat())
        task = self.save(kind="task", title="Month end", due="2027-01-31", recurrence={"frequency": "monthly"})
        self.assertEqual(self.complete(task)["due"], "2027-03-31")
        sample = dict(task, recurrence={"frequency": "monthly", "interval": 1, "mode": "completion"})
        self.assertEqual(module.next_due(sample, datetime(2027, 1, 31, 10, tzinfo=timezone.utc)), "2027-02-28")

    def test_dst_and_invalid_rules(self):
        task = self.save(kind="task", title="Weekly", due="2027-03-21T09:00", zone="Europe/Prague", recurrence={"frequency": "weekly"})
        self.assertEqual(self.complete(task)["due"], "2027-03-28T09:00:00+02:00")
        gap = self.save(kind="task", title="Gap", due="2027-03-21T02:30", recurrence={"frequency": "weekly", "count": 2})
        after_gap = self.complete(gap)
        self.assertEqual(after_gap["due"], "2027-04-04T02:30:00+02:00")
        self.assertFalse(after_gap["done"])
        self.assertTrue(self.complete(after_gap)["done"])
        for due in ("2027-03-28T02:30", "2027-10-31T02:30", "bogus"):
            with self.assertRaises(PlannerError):
                self.save(kind="task", title="Bad", due=due)
        for recurrence in ({"frequency": "hourly"}, {"frequency": "daily", "interval": 0}, {"frequency": "weekly", "weekdays": ["XX"]}):
            with self.assertRaises(PlannerError):
                self.save(kind="task", title="Bad rule", due="2027-01-01", recurrence=recurrence)

    def test_interrupted_write_reconciles_after_restart(self):
        original = self.planner.dav.request
        def interrupted(method, *args, **kwargs):
            response = original(method, *args, **kwargs)
            if method == "PUT":
                raise PlannerError("simulated lost response", 503)
            return response
        self.planner.dav.request = interrupted
        with self.assertRaises(PlannerError):
            self.call("save", {"kind": "task", "title": "Only once"}, "retry")
        restarted = Planner(self.config, self.data)
        self.addCleanup(restarted.db.close)
        result = restarted.call({"action": "save", "args": {"kind": "task", "title": "Only once"}, "key": "retry"})
        self.assertEqual(result["title"], "Only once")
        self.assertEqual(len(restarted.listing()["records"]), 1)
        with self.assertRaises(PlannerError):
            restarted.call({"action": "save", "args": {"kind": "task", "title": "Other"}, "key": "retry"})

    def test_concurrent_completion_advances_once(self):
        task = self.save(kind="task", title="Daily", due="2026-11-19", recurrence={"frequency": "daily"})
        with concurrent.futures.ThreadPoolExecutor() as pool:
            results = list(pool.map(lambda _: self.complete(task, "same-completion"), range(4)))
        self.assertTrue(all(r == results[0] for r in results))
        self.assertEqual(results[0]["completion_count"], 1)

    def test_events_delete_and_authentication(self):
        event = self.save(kind="event", title="Holiday", starts="2026-12-24", ends="2026-12-27")
        self.assertEqual(self.call("get", {"id": event["id"]})["starts"], "2026-12-24")
        deleted = self.call("delete", {"id": event["id"], "version": event["version"]}, "delete")
        self.assertTrue(deleted["deleted"])
        self.assertEqual(self.call("list")["records"], [])
        with self.assertRaises(PlannerError):
            self.call("get", {"id": event["id"]})
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(self.config["url"])
        self.assertEqual(error.exception.code, 401)
        error.exception.close()

    def test_stapp_http_and_mcp_bridge(self):
        settings = self.data / "settings.json"
        settings.write_text(json.dumps(self.config))
        planner_socket = self.data / "planner.sock"
        log = (self.data / "processes.log").open("w+")
        self.addCleanup(log.close)
        service = subprocess.Popen([sys.executable, str(ROOT / "runtime/planner.py"), "--config", str(settings), "--data", str(self.data), "--socket", str(planner_socket)], stdout=log, stderr=log)
        def stop(process):
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
        self.addCleanup(stop, service)
        for _ in range(100):
            if planner_socket.exists():
                break
            time.sleep(.03)
        host_port = port()
        env = dict(os.environ, STAPP_DATA=str(self.data), STAPP_WEB=str(ROOT / "apps/kiosk/dist"), STAPP_PORT=str(host_port), STAPP_PANEL_KEY="test-panel", STAPP_PLANNER_SOCKET=str(planner_socket))
        daemon = subprocess.Popen([str(ROOT / "target/release/stappd")], env=env, stdout=log, stderr=log)
        self.addCleanup(stop, daemon)
        url = f"http://127.0.0.1:{host_port}"
        for _ in range(100):
            try:
                with urllib.request.urlopen(url + "/api/health"):
                    break
            except OSError:
                time.sleep(.03)
        def http(path, value=None, token="test-panel"):
            request = urllib.request.Request(url + path, data=json.dumps(value).encode() if value is not None else None,
                headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.load(response)
        def rpc(message):
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(15)
                client.connect(str(self.data / "control.sock"))
                client.sendall(json.dumps(message).encode() + b"\n")
                return json.loads(client.makefile("rb").readline())
        task = http("/api/planner", {"action": "save", "idempotency_key": "create", "args": {"kind": "task", "title": "Daily", "due": "2026-11-19", "recurrence": {"frequency": "daily"}}})
        state = http("/api/records/" + task["id"], {"version": task["version"], "done": True})
        self.assertEqual(state["records"][0]["due"], "2026-11-20")
        replay = http("/api/records/" + task["id"], {"version": task["version"], "done": True})
        self.assertEqual(replay["records"][0]["completion_count"], 1)
        with self.assertRaises(urllib.error.HTTPError) as error:
            http("/api/planner", token="wrong")
        self.assertEqual(error.exception.code, 401)
        error.exception.close()
        denied = rpc({"device": "room", "op": "tools", "name": "complete_task", "args": {"id": task["id"], "version": task["version"]}})
        self.assertIn("error", denied)
        job_id = str(uuid.uuid4())
        rpc({"device": "pc", "op": "ask", "id": job_id, "text": "List tasks"})
        job = rpc({"device": "owner", "op": "claim_job"})["result"]
        result = rpc({"device": "pc", "op": "tools", "name": "list_records", "job": job_id, "claim": job["claim"], "key": "read", "args": {}})
        self.assertEqual(result["result"][0]["id"], task["id"])
        current = result["result"][0]
        messages = [{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "complete_task", "arguments": {"id": current["id"], "version": current["version"]}}}]
        mcp_env = dict(env, STAPP_JOB=job_id, STAPP_CLAIM=job["claim"], STAPP_DEVICE="pc", STAPP_SOCKET=str(self.data / "control.sock"))
        output = subprocess.check_output([sys.executable, str(ROOT / "runtime/mcp.py")], env=mcp_env,
            input="".join(json.dumps(m) + "\n" for m in messages), text=True)
        reply = json.loads(output)["result"]
        self.assertNotIn("isError", reply)
        self.assertEqual(json.loads(reply["content"][0]["text"])["completion_count"], 2)
        project = rpc({"device":"owner", "op":"tools", "name":"save_task_project", "args":{
            "title":"Work", "color":"#f18bb6", "visible_on_screen":False}})["result"]
        hidden = http("/api/planner", {"action":"save", "idempotency_key":"hidden-task", "args":{
            "kind":"task", "title":"Work item", "project_id":project["id"]}})
        event = http("/api/planner", {"action":"save", "idempotency_key":"event", "args":{
            "kind":"event", "title":"Appointment", "starts":"2026-11-23"}})
        display = http("/api/display")
        self.assertEqual({r["id"] for r in display["records"]}, {task["id"],event["id"]})
        self.assertEqual(display["task_projects"][0]["color"], "#f18bb6")
        self.assertIn(hidden["id"], {r["id"] for r in http("/api/planner")["records"]})
        all_tasks = rpc({"device":"owner", "op":"tools", "name":"list_records", "args":{}})["result"]
        self.assertIn(hidden["id"], {r["id"] for r in all_tasks})

        # Exercise the installed panel relay's allowlist and bearer forwarding.
        cfg = self.data / ".config/stapp"
        cfg.mkdir(parents=True)
        (cfg / "key").write_text("test-panel")
        (cfg / "panel.json").write_text(json.dumps({"server":"https://fixture.invalid", "key_file":str(cfg / "key")}))
        with mock.patch.object(Path, "home", return_value=self.data):
            proxy = runpy.run_path(str(ROOT / "deploy/panel/proxy.py"))
        proxy_port = port()
        proxy["Panel"].log_message = lambda *args: None
        namespace = proxy["Panel"].proxy.__globals__
        namespace["config"]["server"] = url
        namespace["local"] = f"127.0.0.1:{proxy_port}"
        server = proxy["ThreadingHTTPServer"](("127.0.0.1", proxy_port), proxy["Panel"])
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        proxy_url = f"http://127.0.0.1:{proxy_port}"
        def panel(path, value=None, origin=None):
            request = urllib.request.Request(proxy_url + path, data=json.dumps(value).encode() if value is not None else None,
                headers={"Content-Type":"application/json", **({"Origin":origin} if origin else {})})
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.load(response)
        shown = panel("/api/planner", {"action":"save", "idempotency_key":"show-work", "args":{
            "id":project["id"], "version":project["version"], "visible_on_screen":True}})
        self.assertIn(hidden["id"], {r["id"] for r in panel("/api/display")["records"]})
        moved = panel("/api/records/" + hidden["id"], {"version":hidden["version"], "project_id":None, "title":"Personal item"})
        self.assertIsNone(next(r for r in moved["records"] if r["id"]==hidden["id"])["project_id"])
        panel("/api/planner", {"action":"save", "idempotency_key":"hide-work", "args":{
            "id":shown["id"], "version":shown["version"], "visible_on_screen":False}})
        self.assertEqual(len(panel("/api/display")["records"]), 3)
        for path,value,origin in [("/api/planner",{},"https://untrusted.invalid"), ("/api/records/not-a-uuid",{},None)]:
            with self.assertRaises(urllib.error.HTTPError) as denied:
                panel(path,value,origin)
            self.assertEqual(denied.exception.code,403)
            denied.exception.close()
        http("/api/display")
        # A failed planner keeps cached records visible and blocks writes.
        stop(service)
        stale = http("/api/display")
        self.assertEqual(stale["planner_status"], "unavailable")
        self.assertIn(task["id"], {r["id"] for r in stale["records"]})

    def test_migration_is_repeatable_and_keeps_source(self):
        settings = self.data / "settings.json"
        settings.write_text(json.dumps(self.config))
        service = subprocess.Popen([sys.executable, str(ROOT / "runtime/planner.py"), "--config", str(settings), "--data", str(self.data), "--socket", str(self.data / "planner.sock")], stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: (service.terminate(), service.wait(timeout=5)))
        for _ in range(100):
            if (self.data / "planner.sock").exists():
                break
            time.sleep(.03)
        with sqlite3.connect(self.data / "stapp.sqlite") as db:
            db.executescript((ROOT / "apps/stappd/migrations/001.sql").read_text())
            db.execute("INSERT INTO records(kind,title,done) VALUES('task','Finished',1)")
            db.execute("INSERT INTO records(kind,title,starts,zone) VALUES('event','Meeting','2026-11-19T12:00','Europe/Prague')")
        command = [sys.executable, str(ROOT / "scripts/migrate-planner"), "--data", str(self.data)]
        subprocess.check_output(command)
        subprocess.check_output(command)
        records = self.planner.listing(True)["records"]
        self.assertEqual(len(records), 2)
        self.assertTrue(next(r for r in records if r["kind"] == "task")["done"])
        with sqlite3.connect(self.data / "stapp.sqlite") as db:
            self.assertEqual(db.execute("SELECT count(*) FROM records").fetchone()[0], 2)
        self.assertTrue((self.data / "pre-planner.sqlite").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
