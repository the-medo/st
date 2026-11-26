"""Exercise the unified executable without controlling real host services."""

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]


class Cli(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.backend = self.path / "monitor"
        self.backend.write_text(f"#!{sys.executable}\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\nsys.exit(7 if 'fail' in sys.argv else 0)\n")
        self.backend.chmod(0o700)
        self.env = dict(os.environ, ST_MONITOR_BIN=str(self.backend), STAPP_SOCKET=str(self.path / "control.sock"), STAPP_DEVICE="owner")
        self.env.pop("STAPP_SSH", None)
        self.env.pop("ST_MONITOR_DISPATCHED", None)

    def cli(self, *args, executable="st"):
        return subprocess.run([ROOT / "target/release" / executable, *args], env=self.env,
                              capture_output=True, text=True, timeout=5)

    def test_monitor_commands_and_arguments(self):
        for args, expected in [
            (["status"], ["status"]), (["status", "--json"], ["status", "--json"]),
            (["night"], ["night", "status"]), (["night", "on", "--json"], ["night", "on", "--json"]),
            (["night", "off"], ["night", "off"]), (["night", "toggle"], ["night", "toggle"]),
            (["cleanup-plan", "tree with spaces"], ["cleanup-plan", "tree with spaces"]),
            (["monitor", "--config", "/path with spaces", "status", "--json"], ["--config", "/path with spaces", "status", "--json"]),
        ]:
            with self.subTest(args=args):
                result = self.cli(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), expected)

    def test_monitor_exit_status_is_preserved(self):
        self.assertEqual(self.cli("monitor", "fail").returncode, 7)

    def test_remote_flags_never_control_the_local_screen(self):
        self.env["STAPP_SSH"] = "paired-pc"
        result = self.cli("night", "on")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("owner SSH session", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_request_status_still_uses_device_scoped_rpc(self):
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(self.env["STAPP_SOCKET"])
            server.listen(1)
            server.settimeout(5)
            def reply():
                with server.accept()[0] as conn:
                    request = json.loads(conn.makefile("rb").readline())
                    conn.sendall(json.dumps({"result": request}).encode() + b"\n")
            thread = threading.Thread(target=reply)
            thread.start()
            result = self.cli("status", "request-123")
            thread.join(timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"op": "status", "id": "request-123", "device": "owner"})

    def test_legacy_cli_and_photo_commands_remain_available(self):
        self.assertIn("photos", self.cli("--help").stdout)
        self.assertIn("semantic", self.cli("photos", "search", "--help").stdout)
        self.assertEqual(self.cli("night", "status", executable="stctl").returncode, 0)
        self.env["ST_MONITOR_BIN"] = str(ROOT / "target/release/st")
        self.assertIn("points back", self.cli("night", "status").stderr)
        self.env["ST_MONITOR_BIN"] = str(ROOT / "target/release/stctl")
        self.assertIn("delegates back", self.cli("night", "status").stderr)


    def exchange_cli(self, args, responses, input=None):
        requests, errors = [], []
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(self.env["STAPP_SOCKET"])
            server.listen(4)
            server.settimeout(2)
            def reply():
                try:
                    for response in responses:
                        with server.accept()[0] as conn:
                            conn.settimeout(2)
                            requests.append(json.loads(conn.makefile("rb").readline()))
                            conn.sendall(json.dumps(response).encode() + b"\n")
                except Exception as error:
                    errors.append(error)
            thread = threading.Thread(target=reply)
            thread.start()
            result = subprocess.run([ROOT / "target/release/st", *args], env=self.env,
                                    input=input, capture_output=True, text=True, timeout=5)
            thread.join(timeout=3)
        Path(self.env["STAPP_SOCKET"]).unlink()
        self.assertFalse(errors, errors)
        return result, requests

    def test_planner_filters_open_hidden_tasks_and_recurring_creation(self):
        records = [
            {"id":"a","kind":"task","title":"Printer filter","done":False,"project_id":"hidden","labels":["home"]},
            {"id":"b","kind":"task","title":"Other","done":True},
            {"id":"c","kind":"note","title":"Printer note"},
        ]
        result, requests = self.exchange_cli(["tasks","list","--project","hidden","--label","home","--search","PRINTER"], [{"result":records}])
        self.assertEqual(json.loads(result.stdout), records[:1])
        self.assertTrue(requests[0]["planner"])
        result, requests = self.exchange_cli(["planner","tasks","add","Filter","--due","2026-12-01","--repeat","weekly","--weekdays","MO,FR","--interval","2","--count","6","--zone","Europe/Paris","--label","home"], [{"result":{"id":"new"}}])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(requests[0]["args"]["recurrence"], {"frequency":"weekly","interval":2,"mode":"due","weekdays":["MO","FR"],"count":6})
        self.assertTrue(requests[0]["key"])

    def test_edit_fetches_version_and_sends_only_changed_fields(self):
        current = {"id":"task","kind":"task","version":"etag","title":"Existing","due":"2026-12-01","recurrence":{"frequency":"daily"}}
        result, requests = self.exchange_cli(["tasks","edit","task","--title","Renamed","--clear-project","--clear-labels"], [{"result":current},{"result":{"id":"task"}}])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(requests[0]["name"], "get_record")
        self.assertEqual(requests[1]["args"], {"id":"task","version":"etag","kind":"task","title":"Renamed","project_id":None,"labels":[]})

    def test_failed_completion_retains_exact_retry_payload(self):
        result, requests = self.exchange_cli(["tasks","complete","task"], [{"result":{"id":"task","kind":"task","version":"v1"}},{"error":"Write response lost"}])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[1]["name"], "complete_task")
        self.assertEqual(requests[1]["args"], {"id":"task","version":"v1"})
        self.assertIn(requests[1]["key"], result.stderr)
        self.assertIn('"version":"v1"', result.stderr)
        self.assertIn("st rpc", result.stderr)
        # A wrong record kind must never reach the destructive endpoint.
        result, requests = self.exchange_cli(["tasks","delete","event"], [{"result":{"kind":"event","version":"v1"}}])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(requests), 1)

    def test_calendar_overlap_and_local_validation(self):
        records = [{"kind":"event","id":"span","starts":"2026-11-29","ends":"2026-12-03"},
                   {"kind":"event","id":"end","starts":"2026-11-29","ends":"2026-12-01"},
                   {"kind":"event","id":"midnight","starts":"2026-11-30T22:00:00+01:00","ends":"2026-12-01T00:00:00+01:00"},
                   {"kind":"event","id":"future","starts":"2026-12-02T09:00:00+01:00"}]
        result, _ = self.exchange_cli(["calendar","list","--from","2026-12-01","--to","2026-12-01"], [{"result":records}])
        self.assertEqual([r["id"] for r in json.loads(result.stdout)], ["span"])
        for args in [["calendar","list","--from","2026-02-30"], ["tasks","add","x","--interval","2"], ["tasks","edit","id"], ["tasks","add","x","--due","2026-01-01","--clear-due"]]:
            result = self.cli(*args)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("Connect to STapp socket", result.stderr)

    def test_note_body_stdin_and_raw_rpc_file(self):
        result, requests = self.exchange_cli(["notes","add","Résumé","--body-file","-"], [{"result":{"id":1}}], input="first line\nsecond line")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(requests[0]["args"]["body"], "first line\nsecond line")
        self.assertFalse(requests[0]["planner"])
        result, requests = self.exchange_cli(["rpc","@-"], [{"result":[]}], input='{"op":"pending"}')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(requests, [{"op":"pending","device":"owner"}])
        for value in ["null", "[]", '"text"']:
            self.assertIn("Expected a JSON object", self.cli("rpc",value).stderr)

    def test_console_delegation_preserves_arguments_and_bridge_boundary(self):
        for args in [["agents","--help"], ["agents","read","w1:p2","--machine","desk","--json"], ["worktrees","--running"], ["containers","--project","st"]]:
            result = self.cli(*args)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), args)
        self.env["STAPP_SSH"] = "paired-device"
        self.assertIn("owner SSH session", self.cli("agents","list").stderr)


if __name__ == "__main__":
    unittest.main()
