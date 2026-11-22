"""Private DAVe subapp: credentials and its session stay on the loopback bridge."""

import http.client
import json
import threading
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import unquote, urlsplit

PREFIX = "/planner"
MAX_BODY = 8 * 1024 * 1024
MAX_RESPONSE = 32 * 1024 * 1024
PAGES = {"/", "/tasks", "/calendar", "/contacts", "/notes", "/journals"}


class DaveUnavailable(Exception):
    pass


def upstream_path(target):
    """Accept only local DAVe pages/assets/API, including encoded-path checks."""
    url = urlsplit(target)
    if url.scheme or url.netloc or url.fragment or not url.path.startswith(PREFIX + "/"):
        return None
    path = url.path[len(PREFIX):]
    decoded = path
    for _ in range(3):
        decoded = unquote(decoded)
    if ("\\" in decoded or "//" in decoded or
            any(part in (".", "..") for part in decoded.split("/")) or
            any(ord(char) < 32 or ord(char) == 127 for char in target + decoded)):
        return None
    # Session creation is exclusively server-side; the browser never supplies credentials.
    if decoded.startswith("/api/auth/") or decoded == "/api/auth":
        return None
    if path in PAGES or path.startswith("/api/") or path.startswith("/assets/"):
        return path + ("?" + url.query if url.query else "")
    return None


class DaveBridge:
    def __init__(self, port, credentials_path):
        self.port = int(port)
        self.credentials_path = Path(credentials_path).expanduser()
        self.cookie = None
        self.lock = threading.Lock()

    def _request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                raise DaveUnavailable("DAVe response is too large")
            return response.status, dict(response.getheaders()), data
        except (OSError, http.client.HTTPException) as error:
            raise DaveUnavailable("DAVe is unavailable") from error
        finally:
            connection.close()

    def _login(self):
        try:
            raw = self.credentials_path.read_bytes()
            if len(raw) > 8192:
                raise ValueError()
            values = json.loads(raw)
            credentials = {key: values[key] for key in ("username", "password")}
            if not all(isinstance(value, str) and value for value in credentials.values()):
                raise ValueError()
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise DaveUnavailable("DAVe account configuration is unavailable") from error
        status, headers, _ = self._request("POST", "/api/auth/login", json.dumps(credentials).encode(),
                                            {"Content-Type": "application/json"})
        cookies = SimpleCookie()
        try:
            cookies.load(next((v for k, v in headers.items() if k.lower() == "set-cookie"), ""))
            session = cookies["dave_session"].value
        except (KeyError, http.cookies.CookieError) as error:
            raise DaveUnavailable("DAVe could not open the configured account") from error
        if status != 200 or not session:
            raise DaveUnavailable("DAVe could not open the configured account")
        self.cookie = "dave_session=" + session

    def request(self, method, path, body=None, content_type=None):
        is_api = path.startswith("/api/")
        if is_api:
            with self.lock:
                if self.cookie is None:
                    self._login()
                cookie = self.cookie
        headers = {"Accept-Encoding": "identity"}
        if content_type:
            headers["Content-Type"] = content_type
        if is_api:
            headers["Cookie"] = cookie
        response = self._request(method, path, body, headers)
        if is_api and response[0] == 401:
            # Only the session middleware's rejection guarantees that a write
            # never ran. A DAV-server 401 can follow a partially completed move.
            try:
                rejected_before_dispatch = json.loads(response[2]) == {
                    "error": "Not authenticated", "statusCode": 401}
            except (ValueError, UnicodeError):
                rejected_before_dispatch = False
            if method != "GET" and not rejected_before_dispatch:
                return response
            with self.lock:
                if self.cookie == cookie:
                    self.cookie = None
                    self._login()
                headers["Cookie"] = self.cookie
            response = self._request(method, path, body, headers)
        return response
