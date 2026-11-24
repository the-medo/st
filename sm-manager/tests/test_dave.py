import concurrent.futures
import gzip
import http.client
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from sm_manager.config import load_config
from sm_manager.dave import DaveBridge, DaveUnavailable, MAX_BODY, upstream_path
from sm_manager.server import handler_for


class DaveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        cls.credentials = cls.root / "credentials.json"
        cls.credentials.write_text(json.dumps({"username": "fixture", "password": "fixture-secret"}))
        cls.archive = cls.root / "source.tar.gz"
        cls.archive.write_bytes(b"source-fixture")
        cls.calls = []
        cls.login_count = 0
        cls.valid_cookie = "dave_session=server-session"

        class Backend(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def respond(self, status, payload, headers=None):
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Set-Cookie", "should-not-reach-browser=secret")
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode())

            def do_GET(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length)
                cls.calls.append((self.command, self.path, dict(self.headers), body))
                if self.path == "/api/auth/login":
                    if json.loads(body) != {"username": "fixture", "password": "fixture-secret"}:
                        return self.respond(401, {"error": "bad credentials"})
                    cls.login_count += 1
                    cls.valid_cookie = f"dave_session=server-session-{cls.login_count}"
                    return self.respond(200, {"ok": True}, {"Set-Cookie": cls.valid_cookie + "; HttpOnly"})
                if self.path.startswith("/api/") and self.headers.get("Cookie") != cls.valid_cookie:
                    return self.respond(401, {"error": "Not authenticated", "statusCode": 401})
                if self.path == "/api/dav-auth-failure":
                    return self.respond(401, {"error": "Session expired, please log in again", "statusCode": 401})
                if self.path == "/api/redirect":
                    return self.respond(302, {}, {"Location": "https://untrusted.invalid"})
                if self.path == "/api/failure":
                    return self.respond(500, {"error": "failed write"})
                return self.respond(200, {"ok": True, "path": self.path})

            do_POST = do_PUT = do_PATCH = do_DELETE = do_GET

        cls.backend = ThreadingHTTPServer(("127.0.0.1", 0), Backend)
        cls.backend_thread = threading.Thread(target=cls.backend.serve_forever, daemon=True)
        cls.backend_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.backend.shutdown()
        cls.backend.server_close()
        cls.backend_thread.join()
        cls.tmp.cleanup()

    def setUp(self):
        self.calls.clear()
        type(self).login_count = 0
        type(self).valid_cookie = "expired"
        self.config = {"allowed_hosts": ["localhost"], "port": 0,
                       "dave_port": self.backend.server_port,
                       "dave_credentials_path": str(self.credentials), "dave_source_archive": str(self.archive)}
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(None, self.config))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path, method="GET", headers=None, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        connection.request(method, path, body, {"Host": "localhost", **(headers or {})})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_automatic_login_is_server_side_and_shared(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.request("/planner/api/me", headers={
                "Cookie": "dave_session=attacker", "Authorization": "Bearer attacker"}), range(4)))
        self.assertEqual(self.login_count, 1)
        for status, headers, body in results:
            self.assertEqual(status, 200)
            self.assertNotIn("Set-Cookie", headers)
            self.assertNotIn(b"fixture-secret", body)
        for method, path, headers, body in self.calls:
            self.assertNotIn("Authorization", headers)
            if path == "/api/me":
                self.assertEqual(headers["Cookie"], self.valid_cookie)

    def test_mutations_require_token_and_retain_payload(self):
        self.assertEqual(self.request("/planner/api/tasks", "POST", body=b"{}")[0], 403)
        self.assertEqual(self.calls, [])
        token = json.loads(self.request("/planner/api/st-session")[2])["token"]
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            self.assertEqual(self.request("/planner/api/tasks?uid=abc", method,
                {"X-ST-Planner-Token": token, "Content-Type": "application/json"}, b'{"value":1}')[0], 200)
            self.assertEqual(self.calls[-1][3], b'{"value":1}')

    def test_access_and_path_boundaries_precede_automatic_login(self):
        for headers in ({"Host": "evil.invalid"}, {"Origin": "https://evil.invalid"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.request("/planner/api/st-session", headers=headers)[0], 403)
        for path in ("/planner/api/auth/login", "/planner/api/%61uth/login", "/planner/api/../auth/login",
                     "/planner/api/%252e%252e/auth/login", "/planner//api/me", "/planner/.env"):
            self.assertEqual(self.request(path)[0], 404, path)
        self.assertEqual(self.calls, [])
        self.assertIsNone(upstream_path("https://evil.invalid/planner/api/me"))

    def test_session_expiry_refreshes_once_but_failed_writes_are_not_replayed(self):
        self.assertEqual(self.request("/planner/api/me")[0], 200)
        type(self).valid_cookie = "expired"
        self.assertEqual(self.request("/planner/api/me")[0], 200)
        self.assertEqual(self.login_count, 2)
        token = json.loads(self.request("/planner/api/st-session")[2])["token"]
        before = len(self.calls)
        self.assertEqual(self.request("/planner/api/failure", "POST", {"X-ST-Planner-Token": token}, b"{}")[0], 500)
        self.assertEqual(len(self.calls), before + 1)
        before = len(self.calls)
        self.assertEqual(self.request("/planner/api/dav-auth-failure", "POST", {"X-ST-Planner-Token": token}, b"{}")[0], 401)
        self.assertEqual(len(self.calls), before + 1)

    def test_static_source_and_navigation_need_no_dav_session(self):
        status, headers, body = self.request("/planner/tasks")
        self.assertEqual(status, 200)
        self.assertIn(b'data-st-view="planner"', body)
        self.assertIn(b'/planner-shell.js', body)
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        self.assertIn("font-src 'self' data:", headers["Content-Security-Policy"])
        self.assertNotIn("font-src", self.request("/")[1]["Content-Security-Policy"])
        self.assertEqual(self.request("/planner/assets/app.js")[0], 200)
        self.assertEqual(self.request("/planner/source.tar.gz")[2], b"source-fixture")
        self.assertEqual(self.login_count, 0)
        body = self.request("/")[2]
        self.assertIn(b'href="/planner/tasks"  class="nav-link"', body)
        self.assertIn(b'href="/planner/calendar"  class="nav-link"', body)
        self.assertEqual(self.request("/planner")[1]["Location"], "/planner/tasks")
        self.assertEqual(self.request("/planner/")[1]["Location"], "/planner/tasks")

    def test_static_compression_and_validators_never_cache_account_data(self):
        status, headers, body = self.request("/app.js", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Encoding"], "gzip")
        self.assertEqual(headers["Vary"], "Accept-Encoding")
        self.assertEqual(headers["Cache-Control"], "private, no-cache")
        self.assertEqual(gzip.decompress(body), self.request("/app.js")[2])
        status, cached, body = self.request("/app.js", headers={
            "Accept-Encoding": "gzip", "If-None-Match": headers["ETag"]})
        self.assertEqual(status, 304)
        self.assertEqual(body, b"")
        self.assertEqual(cached["ETag"], headers["ETag"])
        self.assertNotIn("Content-Encoding", self.request("/app.js", headers={"Accept-Encoding": "gzip;q=0"})[1])
        for path in ("/planner/api/me", "/planner/api/st-session", "/planner/tasks", "/planner/source.tar.gz"):
            status, headers, _ = self.request(path, headers={"Accept-Encoding": "gzip"})
            self.assertEqual(status, 200)
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertNotIn("ETag", headers)

    def test_hashed_assets_are_immutable_and_only_embedded_html_can_be_framed(self):
        with patch.object(DaveBridge, "request", return_value=(200, {"Content-Type": "text/javascript"}, b"/* asset */" * 200)):
            status, headers, body = self.request("/planner/assets/TasksPage-AbCd1234.js", headers={"Accept-Encoding": "gzip"})
            self.assertEqual(status, 200)
            self.assertEqual(headers["Cache-Control"], "private, max-age=31536000, immutable")
            self.assertEqual(headers["Content-Encoding"], "gzip")
            self.assertEqual(self.request("/planner/assets/unhashed.js")[1]["Cache-Control"], "private, no-cache")
        with patch.object(DaveBridge, "request", return_value=(200, {"Content-Type": "text/html"}, b"<div>Planner</div>")):
            status, headers, body = self.request("/planner/tasks?st-embedded=1")
            self.assertEqual(body, b"<div>Planner</div>")
            self.assertIn("frame-ancestors 'self'", headers["Content-Security-Policy"])
            self.assertEqual(headers["X-Frame-Options"], "SAMEORIGIN")
            self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertIn("frame-ancestors 'none'", self.request("/?st-embedded=1")[1]["Content-Security-Policy"])
        self.assertEqual(self.request("/planner/api/auth/login?st-embedded=1")[0], 404)

    def test_react_planner_inherits_only_static_same_origin_theme_assets(self):
        self.config["frontend"] = "react"
        html = b"<!doctype html><html><head></head><body>Fixture planner</body></html>"
        with patch.object(DaveBridge, "request", return_value=(200, {"Content-Type": "text/html"}, html)):
            status, headers, body = self.request("/planner/tasks?st-embedded=1")
            self.assertEqual(status, 200)
            self.assertIn(b'href="/st-theme.css"', body)
            self.assertIn(b'href="/st-planner.css"', body)
            self.assertIn(b'<script src="/st-planner.js"></script></head>', body)
            self.assertNotIn("'unsafe-inline'", headers["Content-Security-Policy"].split("script-src", 1)[1].split(";", 1)[0])
            self.config.pop("frontend")
            self.assertEqual(self.request("/planner/tasks?st-embedded=1")[2], html)
        for path in ["/st-theme.css", "/st-planner.css", "/st-planner.js"]:
            status, headers, body = self.request(path)
            self.assertEqual(status, 200)
            self.assertEqual(headers["Cache-Control"], "private, no-cache")

    def test_errors_hide_upstream_authentication_and_redirects(self):
        self.assertEqual(self.request("/planner/api/redirect")[0], 502)
        with patch.object(DaveBridge, "request", side_effect=DaveUnavailable("private details")):
            status, headers, body = self.request("/planner/api/tasks")
        self.assertEqual(status, 503)
        self.assertNotIn(b"private details", body)
        self.assertNotIn("Location", headers)
        token = json.loads(self.request("/planner/api/st-session")[2])["token"]
        self.assertEqual(self.request("/planner/api/tasks", "POST", {
            "X-ST-Planner-Token": token, "Content-Length": str(MAX_BODY + 1)})[0], 400)

    def test_config_rejects_self_proxy_and_missing_source_or_credentials(self):
        path = self.root / "config.json"
        for values in ({"dave_port": 8790}, {"dave_port": 18888}):
            path.write_text(json.dumps(values))
            with self.assertRaises(ValueError):
                load_config(path)


if __name__ == "__main__":
    unittest.main()
