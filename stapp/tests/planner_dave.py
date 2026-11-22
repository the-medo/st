"""Bidirectional planner checks against real isolated DAVe and Radicale servers."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("legacy_tests", ROOT / "tests/planner.py")
legacy_tests = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy_tests)
spec = importlib.util.spec_from_file_location("dave_adapter", ROOT / "runtime/planner_dave.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
legacy = legacy_tests.module
CHECKOUT = Path(os.environ.get("DAVE_CHECKOUT", ROOT / "apps/dave"))


@unittest.skipUnless(shutil.which("node") and (CHECKOUT / "packages/backend/dist/server.js").is_file(), "Build the pinned DAVe checkout and put Node on PATH")
class SharedPlanner(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        legacy_tests.Backend.setUpClass.__func__(cls)
        cls.dave_port = legacy_tests.port()
        cls.dave_log = (cls.root / "dave.log").open("w+")
        cls.dave = subprocess.Popen([shutil.which("node"), str(CHECKOUT / "packages/backend/dist/server.js")],
            cwd=CHECKOUT, stdout=cls.dave_log, stderr=cls.dave_log,
            env={**os.environ, "NODE_ENV": "production", "BIND_ADDRESS": "127.0.0.1", "PORT": str(cls.dave_port),
                 "DAV_BASE_URL": f"http://127.0.0.1:{cls.port}", "SESSION_SECRET": "temporary-fixture-secret-" * 3,
                 "DATA_DIR": str(cls.root / "dave-data"), "FRONTEND_DIST": str(CHECKOUT / "packages/frontend/dist")})
        for _ in range(100):
            try:
                with legacy_tests.socket.create_connection(("127.0.0.1", cls.dave_port), timeout=.1):
                    return
            except OSError:
                time.sleep(.05)
        raise RuntimeError("Isolated DAVe did not start")

    @classmethod
    def tearDownClass(cls):
        cls.dave.terminate(); cls.dave.wait(timeout=5); cls.dave_log.close()
        legacy_tests.Backend.tearDownClass.__func__(cls)

    def setUp(self):
        self.data = self.root / str(uuid.uuid4())
        self.config = {"url": f"http://127.0.0.1:{self.port}/stapp/{self.data.name}/", "username": "stapp", "password": "test",
                       "backend": "dave", "dave_url": f"http://127.0.0.1:{self.dave_port}", "default_calendar_id": self.data.name}
        self.old = legacy.Planner(self.config, self.data / "legacy")
        self.old.dav.ensure_collection()
        self.shared = adapter.DavePlanner(self.config, self.data / "shared", legacy.Planner, legacy.PlannerError)
        self.shared.ensure_collection()
        self.addCleanup(self.shared.db.close)
        self.addCleanup(self.old.db.close)

    def call(self, action, args=None, key=None):
        return self.shared.call({"action": action, "args": args or {}, "key": key or str(uuid.uuid4())})

    def save(self, **args):
        return self.call("save", args)

    def web_task(self, task_id):
        return self.shared.request("GET", "/api/tasks/" + task_id)

    def test_existing_faceplate_task_and_new_web_task_share_edits_and_conflicts(self):
        old = self.old.call({"action": "save", "args": {"kind": "task", "title": "Existing faceplate task"}, "key": str(uuid.uuid4())})
        self.assertIn(old["id"], [r["id"] for r in self.call("list", {"fresh": True})["records"]])
        web = self.web_task(old["id"])
        web["data"].update(summary="Web edit", categories=["shared"], priority=2,
                           alarms=[{"action": "DISPLAY", "trigger": "-PT15M", "description": "reminder"}])
        self.shared.request("PUT", "/api/tasks/" + old["id"], {"data": web["data"], "etag": web["etag"]})
        current = self.call("get", {"id": old["id"]})
        self.assertEqual(current["title"], "Web edit")
        with self.assertRaises(legacy.PlannerError) as failure:
            self.save(id=old["id"], version=old["version"], title="Stale edit")
        self.assertEqual(failure.exception.status, 409)
        saved = self.save(id=current["id"], version=current["version"], title="Faceplate edit")
        web = self.web_task(saved["id"])
        self.assertEqual(web["data"]["summary"], "Faceplate edit")
        self.assertEqual(web["data"]["categories"], ["shared"])
        self.assertEqual(len(web["data"]["alarms"]), 1)
        web["data"].update(uid=str(uuid.uuid4()), summary="Created in web")
        created = self.shared.request("POST", "/api/tasks", {"data": web["data"]})
        listing = self.call("list", {"fresh": True})
        self.assertIn(created["uid"], [r["id"] for r in listing["records"]])
        self.shared.request("DELETE", "/api/tasks/" + created["uid"] + "?etag=" + adapter.quote(created["etag"]))
        self.assertNotIn(created["uid"], [r["id"] for r in self.call("list", {"fresh": True})["records"]])

    def test_completion_uses_dave_recurrence_and_never_replays_ambiguous_writes(self):
        today = datetime.now(timezone.utc).date().isoformat()
        task = self.save(kind="task", title="Recurring shared task", due=today,
                         recurrence={"frequency": "weekly", "count": 3})
        key = str(uuid.uuid4())
        args = {"id": task["id"], "version": task["version"]}
        completed = self.call("complete", args, key)
        self.assertFalse(completed["done"])
        self.assertGreater(completed["due"], today)
        self.assertEqual(self.call("complete", args, key), completed)
        before = self.shared.request("GET", "/api/tasks")["total"]
        original = self.shared.request
        def lose_response(method, path, data=None, **kwargs):
            result = original(method, path, data, **kwargs)
            if method == "PUT" and path.startswith("/api/tasks/"):
                raise legacy.PlannerError("Lost response", 503)
            return result
        key = str(uuid.uuid4())
        args = {"id": completed["id"], "version": completed["version"]}
        with patch.object(self.shared, "request", side_effect=lose_response):
            with self.assertRaises(legacy.PlannerError):
                self.call("complete", args, key)
        with self.assertRaises(legacy.PlannerError) as failure:
            self.call("complete", args, key)
        self.assertEqual(failure.exception.status, 409)
        self.assertEqual(self.shared.request("GET", "/api/tasks")["total"], before + 1)

    def test_projects_are_dave_collections_and_keep_faceplate_visibility(self):
        project = self.save(kind="project", title="Shared project", color="#12ab34", visible_on_screen=False)
        task = self.save(kind="task", title="Project task", project_id=project["id"])
        web = self.web_task(task["id"])
        self.assertNotEqual(web["collectionId"], self.data.name)
        with self.assertRaises(legacy.PlannerError):
            self.call("delete", {"id": project["id"], "version": project["version"]})
        self.shared.request("PATCH", "/api/calendars/" + web["collectionId"], {"displayName": "Web project rename", "color": "#987654"})
        projects = self.call("list", {"fresh": True})["projects"]
        changed = next(p for p in projects if p["id"] == project["id"])
        self.assertEqual(changed["title"], "Web project rename")
        self.assertFalse(changed["visible_on_screen"])
        self.assertEqual(changed["color"], "#987654")
        self.call("delete", {"id": task["id"], "version": task["version"]})
        self.call("delete", {"id": changed["id"], "version": changed["version"]})

    def test_events_are_shared_and_preserve_alarms(self):
        start = (datetime.now(timezone.utc) + timedelta(days=1)).replace(microsecond=0)
        event = self.save(kind="event", title="Faceplate event", starts=start.isoformat(), ends=(start + timedelta(hours=1)).isoformat())
        self.call("list", {"fresh": True})
        raw = self.shared.sources[event["id"]][1]
        raw["data"].update(summary="Web event edit", location="Kept location", alarms=[{"action": "DISPLAY", "trigger": "-PT10M", "description": "reminder"}])
        self.shared.request("PUT", "/api/events/" + raw["id"], {"data": raw["data"], "etag": raw["etag"]})
        event = next(r for r in self.call("list", {"fresh": True})["records"] if r["id"] == event["id"])
        self.assertEqual(event["title"], "Web event edit")
        self.save(id=event["id"], version=event["version"], title="Faceplate event rename")
        self.call("list", {"fresh": True})
        raw = self.shared.sources[event["id"]][1]
        self.assertEqual(raw["data"]["location"], "Kept location")
        self.assertEqual(len(raw["data"]["alarms"]), 1)
        self.call("delete", {"id": event["id"], "version": raw["etag"]})
        self.assertNotIn(event["id"], [r["id"] for r in self.call("list", {"fresh": True})["records"]])


if __name__ == "__main__":
    unittest.main()
