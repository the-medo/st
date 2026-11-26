"""Run against a real STapp daemon in a temporary directory."""

import base64
import concurrent.futures
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import uuid
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "runtime"))
from transport import rpc


class Daemon(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self.env = dict(
            os.environ,
            STAPP_DATA=str(self.data),
            STAPP_PORT=str(self.port),
            STAPP_WEB=str(root / "apps/kiosk/dist"),
            STAPP_OWNER="test",
            STAPP_PANEL_KEY="test-panel",
            STAPP_OVERLAP="1",
            STAPP_PROJECTS_ROOT=str(self.data / "projects"),
        )
        os.environ["STAPP_SOCKET"] = str(self.data / "control.sock")
        self.addCleanup(os.environ.pop, "STAPP_SOCKET", None)
        self.start()

    def start(self):
        self.proc = subprocess.Popen([root / "target/release/stappd"], env=self.env)
        self.addCleanup(self.stop)
        for attempt in range(100):
            if self.proc.poll() is not None:
                self.fail("Daemon exited")
            try:
                with urllib.request.urlopen(self.url + "/api/health", timeout=0.1):
                    return
            except OSError:
                time.sleep(0.02)
        self.fail("Daemon failed readiness")

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(timeout=5)

    def ask(self, device, text, **extra):
        msg = {"op": "ask", "id": str(uuid.uuid4()), "text": text, **extra}
        rpc(msg, device)
        return msg

    def event(self, job, kind, text=""):
        return rpc(
            {
                "op": "worker_event",
                "id": job["id"],
                "claim": job["claim"],
                "kind": kind,
                "text": text,
            },
            "owner",
        )

    def tool(self, tool_name, **args):
        return rpc({"op": "tools", "name": tool_name, "args": args}, "owner")

    def http(self, path, token=None, body=None):
        headers = {"Authorization": "Bearer " + token} if token else {}
        request = urllib.request.Request(self.url + path, data=body, headers=headers)
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.read(), response.headers

    def test_shared_theme_survives_restart(self):
        def select(value, token="test-panel"):
            request = urllib.request.Request(
                self.url + "/api/display",
                data=json.dumps(value).encode(),
                headers={
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + token,
                },
            )
            with urllib.request.urlopen(request) as response:
                return json.load(response)

        original = json.loads(self.http("/api/display", "test-panel")[0])
        self.assertEqual(original["theme"], "alpenglow")
        themed = select({"theme": "dune"})
        self.assertEqual(themed["view"], original["view"])
        self.assertEqual(themed["revision"], original["revision"] + 1)
        self.assertEqual(select({"theme": "dune"})["revision"], themed["revision"])
        self.assertEqual(select({"name": "clock"})["theme"], "dune")
        for body, token, expected in [
            ({"theme": "bogus"}, "test-panel", 400),
            ({"theme": "canopy"}, "wrong", 401),
        ]:
            with self.assertRaises(urllib.error.HTTPError) as error:
                select(body, token)
            self.assertEqual(error.exception.code, expected)
            error.exception.close()
        self.stop()
        self.start()
        state = json.loads(self.http("/api/display", "test-panel")[0])
        self.assertEqual((state["theme"], state["view"]), ("dune", "clock"))

    def edit(self, record_id, patch, token="test-panel"):
        req = urllib.request.Request(
            f"{self.url}/api/records/{record_id}",
            data=json.dumps(patch).encode(),
            headers={
                "Authorization": "Bearer " + token,
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req) as response:
            return json.load(response)

    def test_record_edits_are_durable_and_reject_stale_writers(self):
        task = self.tool(
            "save_record",
            kind="task",
            title="Milk",
            starts="2026-11-17T12:00",
            zone="Europe/Budapest",
        )["id"]
        note = self.tool("save_record", kind="note", title="Ideas")["id"]
        event = self.tool(
            "save_record",
            kind="event",
            title="Coffee",
            starts="2026-11-16T10:30",
            zone="Europe/Budapest",
        )["id"]

        def row(state, id):
            return next(r for r in state["records"] if r["id"] == id)

        state = self.edit(task, {"version": 0, "done": True})
        renamed = row(self.edit(task, {"version": 1, "title": "Oat milk"}), task)
        self.assertEqual(
            (renamed["done"], renamed["starts"], renamed["zone"]),
            (True, "2026-11-17T12:00", "Europe/Budapest"),
        )
        self.assertEqual(
            row(self.edit(task, {"version": 2, "done": False}), task)["done"], False
        )
        body = "One idea.\nAnother line. 🌙"
        updated = self.edit(note, {"version": 0, "title": "Moon", "body": body})
        self.assertGreater(updated["revision"], state["revision"])
        self.tool("save_record", kind="note", id=note, title="Moonlight")
        for id, patch, token, status in [
            (note, {"version": 1, "title": "stale", "body": "lost"}, "test-panel", 409),
            (task, {"version": 3, "title": "unauthorized"}, "wrong-token", 401),
            (note, {"version": 2, "title": " ", "body": "invalid"}, "test-panel", 400),
            (event, {"version": 0, "title": "different"}, "test-panel", 400),
            (task, {"version": 3, "title": "task", "body": "no"}, "test-panel", 400),
            (9999, {"version": 0, "done": True}, "test-panel", 404),
        ]:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.edit(id, patch, token)
            self.assertEqual(error.exception.code, status)
            error.exception.close()
        self.stop()
        self.start()
        saved = row(json.loads(self.http("/api/display", "test-panel")[0]), note)
        self.assertEqual(
            (saved["title"], saved["body"], saved["version"]), ("Moonlight", body, 2)
        )

    def test_migrate_title_only_note(self):
        self.stop()
        path = self.data / "stapp.sqlite"
        for suffix in ["", "-wal", "-shm"]:
            Path(str(path) + suffix).unlink(missing_ok=True)
        with sqlite3.connect(path) as db:
            db.executescript((root / "apps/stappd/migrations/001.sql").read_text())
            db.executescript((root / "apps/stappd/migrations/002.sql").read_text())
            id = db.execute(
                "INSERT INTO records(kind,title) VALUES('note','Original')"
            ).lastrowid
        self.start()
        note = json.loads(self.http("/api/display", "test-panel")[0])["records"][0]
        self.assertEqual(
            (note["title"], note["body"], note["version"]), ("Original", "", 0)
        )
        self.assertEqual(
            self.edit(id, {"version": 0, "title": "Original", "body": "New details"})[
                "records"
            ][0]["body"],
            "New details",
        )

    def test_device_delivery_and_resume(self):
        pc = self.ask("pc", "private")
        room = self.ask("room", "living room")
        rpc(pc, "pc")
        first = rpc({"op": "claim_job"}, "owner")
        second = rpc({"op": "claim_job"}, "owner")
        self.assertEqual((first["id"], second["id"]), (pc["id"], room["id"]))
        self.event(second, "completed", "room only")
        self.event(first, "thread", "thread-for-pc")
        self.event(first, "question", "Which list?")
        self.assertEqual(rpc({"op": "pending"}, "pc")[0]["id"], pc["id"])
        self.assertEqual(rpc({"op": "pending"}, "room"), [])
        with self.assertRaises(ValueError):
            rpc({"op": "answer", "id": pc["id"], "text": "other"}, "room")
        self.stop()
        self.start()
        rpc({"op": "answer", "id": pc["id"], "text": "Saturday"}, "pc")
        self.assertEqual(self.event(first, "poll"), "Saturday")
        self.event(first, "completed", "pc only")
        self.assertEqual(
            [e["text"] for e in rpc({"op": "inbox"}, "room")], ["Got it.", "room only"]
        )
        self.assertEqual(
            [e["kind"] for e in rpc({"op": "inbox"}, "pc")],
            ["accepted", "question", "completed"],
        )
        self.assertEqual(
            json.loads(self.http("/api/display", "test-panel")[0])["room_reply"],
            "room only",
        )
        with self.assertRaises(ValueError):
            rpc(pc, "room")
        self.ask("pc", "continue", parent=pc["id"])
        self.assertEqual(rpc({"op": "claim_job"}, "owner")["thread"], "thread-for-pc")


    def test_cli_notes_and_requests_are_versioned_and_scoped(self):
        env = dict(self.env, STAPP_SOCKET=str(self.data / "control.sock"), STAPP_DEVICE="owner")
        env.pop("STAPP_SSH", None)
        def cli(*args, input=None, ok=True):
            result = subprocess.run([root / "target/release/st", *args], env=env, input=input,
                                    capture_output=True, text=True, timeout=5)
            if ok:
                self.assertEqual(result.returncode, 0, result.stderr)
                return json.loads(result.stdout)
            self.assertNotEqual(result.returncode, 0)
            return result.stderr
        note = cli("notes", "add", "Printer", "--body-file", "-", input="Use PETG\nCheck nozzle")
        edited = cli("notes", "edit", str(note["id"]), "--title", "Printer setup")
        self.assertEqual(edited["body"], note["body"])
        self.assertGreater(edited["version"], note["version"])
        self.assertIn("changed", cli("notes", "edit", str(note["id"]), "--version", str(note["version"]), "--body", "stale", ok=False))
        self.assertEqual(cli("notes", "list", "--search", "petg")[0]["title"], "Printer setup")
        revision = json.loads(self.http("/api/display", "test-panel")[0])["revision"]
        self.assertTrue(cli("notes", "delete", str(note["id"]))["deleted"])
        self.assertGreater(json.loads(self.http("/api/display", "test-panel")[0])["revision"], revision)
        self.assertEqual(cli("notes", "list"), [])
        self.assertIn("Planner unavailable", cli("tasks", "add", "Must not fall back to SQLite", ok=False))
        for device in ("pc", "room"):
            self.assertIn("active assistant request", cli("--device", device, "notes", "list", ok=False))
            self.ask(device, device + " only")
        owner = cli("ask", "owner only")
        self.assertEqual([j["id"] for j in cli("requests", "--status", "queued")], [owner["id"]])
        self.assertEqual(cli("pending"), [])
        self.assertEqual(len(cli("--device", "pc", "requests")), 1)
        self.assertNotEqual(cli("--device", "pc", "requests")[0]["id"], owner["id"])

    def test_note_operation_receipts_survive_restart(self):
        create = {"op":"tools", "name":"save_note", "key":"note-create", "args":{"title":"Retry", "body":"Once"}}
        first = rpc(create, "owner")
        self.stop()
        self.start()
        self.assertEqual(rpc(create, "owner"), first)
        self.assertEqual(len(self.tool("list_notes")), 1)
        changed = dict(create, args={"title":"Different"})
        with self.assertRaisesRegex(ValueError, "Operation key already used"):
            rpc(changed, "owner")
        delete = {"op":"tools", "name":"delete_note", "key":"note-delete", "args":{"id":first["id"], "version":first["version"]}}
        self.assertEqual(rpc(delete, "owner"), rpc(delete, "owner"))
        self.assertEqual(self.tool("list_notes"), [])

    def test_arbitration_and_voice_answer(self):
        room, pc = str(uuid.uuid4()), str(uuid.uuid4())
        with concurrent.futures.ThreadPoolExecutor() as pool:
            slow = pool.submit(rpc, {"op": "wake", "id": room}, "room")
            self.assertTrue(rpc({"op": "wake", "id": pc}, "pc")["accepted"])
            self.assertFalse(slow.result()["accepted"])
        command = self.ask("pc", "remember milk", id=pc, wake=pc)
        rpc(command, "pc")
        job = rpc({"op": "claim_job"}, "owner")
        self.event(job, "question", "Which milk?")
        answer = str(uuid.uuid4())
        self.assertTrue(rpc({"op": "wake", "id": answer}, "pc")["accepted"])
        msg = self.ask("pc", "answer oat milk", id=answer, wake=answer)
        rpc(msg, "pc")
        self.assertEqual(self.event(job, "poll"), "oat milk")

    def test_records_views_and_frame(self):
        for kind in ("task", "note", "event"):
            self.tool(
                "save_record",
                kind=kind,
                title=kind,
                starts="2026-11-18T08:00",
                zone="Europe/Prague",
            )
        self.assertEqual(len(self.tool("list_records")), 3)
        self.tool(
            "save_view",
            name="morning",
            spec={"kind": "dashboard", "widgets": ["calendar", "tasks"]},
        )
        self.tool(
            "publish_app", name="custom", html="<script>document.title='ST'</script>"
        )
        self.tool("show_view", name="custom")
        data, headers = self.http("/api/asset/app/custom", "test-panel")
        self.assertIn(b"document.title", data)
        self.assertIn("frame-ancestors 'self'", headers["Content-Security-Policy"])
        rpc(
            {
                "op": "import_photo",
                "name": "picture",
                "data": base64.b64encode(bytes.fromhex("ffd8ffe0")).decode(),
            },
            "pc",
        )
        self.tool("show_view", name="picture")
        self.assertEqual(
            self.http("/api/asset/photo/picture", "test-panel")[0],
            bytes.fromhex("ffd8ffe0"),
        )
        with self.assertRaises(urllib.error.HTTPError) as exc:
            self.http("/api/display")
        self.assertEqual(exc.exception.code, 401)
        exc.exception.close()
        self.assertEqual(self.http("/api/frame", "test-panel")[0], b"null")
        png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1MAAAAASUVORK5CYII="
        )
        self.http("/api/frame", "test-panel", png)
        self.assertEqual(
            json.loads(self.http("/api/frame", "test-panel")[0])["display"], "SCR-SM1"
        )

    def test_worker_loss_and_new_project(self):
        project = rpc({"op": "create_project", "name": "demo"}, "pc")
        self.assertTrue(Path(project["path"]).is_dir())
        with self.assertRaises(ValueError):
            rpc({"op": "create_project", "name": "demo"}, "pc")
        task = self.ask("pc", "do the work", project="demo")
        job = rpc({"op": "claim_job"}, "owner")
        self.assertEqual(job["cwd"], project["path"])
        with sqlite3.connect(self.data / "stapp.sqlite") as db:
            db.execute("UPDATE jobs SET updated=unixepoch()-181")
        self.assertIsNone(rpc({"op": "claim_job"}, "owner"))
        self.assertEqual(
            rpc({"op": "status", "id": task["id"]}, "pc")["status"], "interrupted"
        )
        with self.assertRaises(ValueError):
            self.event(job, "completed", "late")

    def test_project_tool_retry(self):
        parent = self.ask("pc", "create project")
        job = rpc({"op": "claim_job"}, "owner")
        dispatch = {
            "op": "tools",
            "name": "start_project_task",
            "job": parent["id"],
            "claim": job["claim"],
            "key": "once",
            "args": {"project": "demo", "create": True, "text": "work"},
        }
        result = rpc(dispatch, "pc")
        self.assertEqual(result, rpc(dispatch, "pc"))
        self.assertEqual(rpc({"op": "claim_job"}, "owner")["id"], result["id"])
        self.assertIsNone(rpc({"op": "claim_job"}, "owner"))

    def test_mcp_handshake(self):
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        ]
        output = subprocess.check_output(
            [sys.executable, str(root / "runtime/mcp.py")],
            input="".join(json.dumps(m) + "\n" for m in messages),
            text=True,
        )
        replies = [json.loads(line)["result"] for line in output.splitlines()]
        self.assertIn("tools", replies[0]["capabilities"])
        self.assertIn("save_record", [t["name"] for t in replies[1]["tools"]])


if __name__ == "__main__":
    unittest.main(verbosity=2)
