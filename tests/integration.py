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
