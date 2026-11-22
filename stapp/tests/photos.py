"""Real daemon/CLI with an isolated mock Immich server; no live libraries touched."""

import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import integration

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "runtime"))
from transport import rpc

ASSET = "550e8400-e29b-41d4-a716-446655440000"
JPEG = b"\xff\xd8\xfftest-preview"


class Photos(unittest.TestCase):
    start = integration.Daemon.start
    stop = integration.Daemon.stop
    http = integration.Daemon.http
    tool = integration.Daemon.tool

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.requests = []
        self.response_code = 200
        self.visibility = "timeline"
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.handle_api()

            def do_POST(self):
                self.handle_api()

            def handle_api(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                test.requests.append((self.path, self.headers.get("x-api-key"), body))
                data = {
                    "/api/server/ping": {"res": "pong"},
                    "/api/server/version": {"major": 3, "minor": 4, "patch": 2},
                    "/api/users/me": {"name": "Test owner"},
                    "/api/albums": [{"id": ASSET, "albumName": "Holiday", "assetCount": 1}],
                    "/api/assets/" + ASSET: {"visibility": test.visibility},
                }.get(self.path, {"assets": {"items": [{"id": ASSET, "originalFileName": "beach.jpg", "type": "IMAGE"}], "nextPage": "2", "total": 1}})
                self.send_response(test.response_code)
                if test.response_code == 302:
                    self.send_header("Location", test.api + "/do-not-follow")
                self.end_headers()
                self.wfile.write(JPEG if "thumbnail?" in self.path else json.dumps(data).encode())

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        self.api = f"http://127.0.0.1:{server.server_port}"
        config = self.data / "photos.json"
        config.write_text(json.dumps({"api_url": self.api + "/api", "url": "https://photos.example", "api_key": "private-test-key"}))
        config.chmod(0o600)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self.env = dict(os.environ, STAPP_DATA=str(self.data), STAPP_PORT=str(self.port),
                        STAPP_WEB=str(root / "apps/kiosk/dist"), STAPP_PANEL_KEY="test-panel",
                        STAPP_PHOTOS_SCRIPT=str(root / "runtime/photos.py"), STAPP_PHOTOS_CONFIG=str(config))
        self.env.pop("STAPP_PLANNER_SOCKET", None)
        os.environ["STAPP_SOCKET"] = str(self.data / "control.sock")
        self.addCleanup(os.environ.pop, "STAPP_SOCKET", None)
        self.start()

    def test_cli_status_and_search_never_return_key(self):
        result = subprocess.check_output([root / "target/release/stctl", "photos", "status"], env=self.env, text=True)
        self.assertTrue(json.loads(result)["library_connected"])
        self.assertNotIn("private-test-key", result)
        found = self.tool("photos_search", query="beach", semantic=True, limit=4)
        self.assertEqual(found["items"][0]["url"], "https://photos.example/photos/" + ASSET)
        self.assertEqual(self.requests[-1][0], "/api/search/smart")
        self.assertEqual(self.requests[-1][2]["visibility"], "timeline")
        self.tool("photos_search", query="beach.jpg")
        self.assertEqual(self.requests[-1][2]["originalFileName"], "beach.jpg")
        self.assertEqual(self.requests[-1][1], "private-test-key")

    def test_unbound_remote_device_cannot_read_owner_photos(self):
        for device in ["pc", "room"]:
            with self.assertRaisesRegex(Exception, "active assistant request"):
                rpc({"op": "tools", "name": "photos_recent", "args": {}}, device)
        with self.assertRaisesRegex(Exception, "Unbound tool"):
            rpc({"op": "tools", "name": "photos_recent", "args": {}, "job": "fake", "key": "x", "claim": "fake"}, "owner")
        self.assertEqual(self.requests, [])

    def test_show_caches_only_preview_and_requires_authenticated_panel(self):
        result = self.tool("photos_show", id=ASSET)
        self.assertEqual(result["view"], "immich-" + ASSET)
        path = "/api/asset/photo/immich-" + ASSET
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.http(path)
        error.exception.close()
        self.assertEqual(self.http(path, "test-panel")[0], JPEG)
        state = json.loads(self.http("/api/display", "test-panel")[0])
        self.assertEqual(state["view"], "immich-" + ASSET)

    def test_hidden_photo_and_invalid_input_do_not_change_panel(self):
        self.visibility = "locked"
        with self.assertRaisesRegex(Exception, "cannot be shown"):
            self.tool("photos_show", id=ASSET)
        self.assertEqual(len(self.requests), 1)
        for args in [{"limit": 101}, {"page": 0}]:
            with self.assertRaisesRegex(Exception, "limit must"):
                self.tool("photos_recent", **args)
        with self.assertRaises(Exception):
            self.tool("photos_show", id="../../secrets")
        self.assertFalse((self.data / "photos").exists())

    def test_redirects_and_upstream_errors_are_bounded_and_sanitized(self):
        for code in [302, 401, 503]:
            self.response_code = code
            with self.assertRaisesRegex(Exception, f"HTTP {code}") as error:
                self.tool("photos_albums")
            self.assertNotIn("private-test-key", str(error.exception))
        self.assertEqual(len(self.requests), 3)


class Storage(unittest.TestCase):
    def test_missing_or_wrong_mount_refuses_start(self):
        spec = importlib.util.spec_from_file_location("immich_manage", root / "deploy/immich/manage.py")
        manager = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(manager)
        config = {"mount": "/nas", "source": "//nas/photos", "library": "/nas/immich"}
        for mount in [{"fstype": "ext4", "source": "/dev/disk"}, {"fstype": "cifs", "source": "//other/share"}]:
            with patch.object(manager, "filesystem", return_value=mount):
                with self.assertRaisesRegex(RuntimeError, "refusing local fallback"):
                    manager.check_storage(config)


if __name__ == "__main__":
    unittest.main()
