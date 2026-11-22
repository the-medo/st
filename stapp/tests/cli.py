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


if __name__ == "__main__":
    unittest.main()
