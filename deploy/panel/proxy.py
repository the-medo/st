"""Serve the installed shell locally and authenticate requests to a single private STapp."""

import json
import shutil
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

config = json.loads((Path.home() / ".config/stapp/panel.json").read_text())
web = Path(__file__).resolve().parent / "web"
if urlsplit(config["server"]).scheme != "https":
    raise ValueError("Use the private HTTPS server URL")
local = "127.0.0.1:18642"
token = Path(config["key_file"]).read_text().strip()


class Panel(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(web), **kwargs)

    def allowed(self):
        return (
            self.headers.get("Host") == local
            and self.headers.get("Origin") in (None, "http://" + local)
            and self.headers.get("Sec-Fetch-Site") != "cross-site"
        )

    def list_directory(self, path):
        self.send_error(404)

    def do_GET(self):
        if not self.allowed():
            self.send_error(403)
            return
        if self.path.startswith("/api/"):
            self.proxy()
        else:
            super().do_GET()

    def do_POST(self):
        if not self.allowed() or self.path != "/api/display":
            self.send_error(403)
            return
        self.proxy()

    def proxy(self):
        if self.path not in (
            "/api/display",
            "/api/events",
        ) and not self.path.startswith("/api/asset/"):
            self.send_error(404)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 <= size <= 2048:
                self.send_error(413)
                return
            body = self.rfile.read(size) if self.command == "POST" else None
            request = urllib.request.Request(
                config["server"].rstrip("/") + self.path,
                data=body,
                headers={
                    "Authorization": "Bearer " + token,
                    "Content-Type": "application/json",
                },
            )
            with urllib.request.urlopen(request, timeout=25) as response:
                self.send_response(response.status)
                for key in (
                    "Content-Type",
                    "Cache-Control",
                    "Content-Security-Policy",
                    "X-Content-Type-Options",
                ):
                    if key in response.headers:
                        self.send_header(key, response.headers[key])
                self.end_headers()
                if self.path == "/api/events":
                    for line in response:
                        self.wfile.write(line)
                        self.wfile.flush()
                else:
                    shutil.copyfileobj(response, self.wfile)
        except urllib.error.HTTPError as exc:
            self.send_error(exc.code)
        except (BrokenPipeError, ConnectionResetError):
            return
        except (OSError, ValueError):
            self.send_error(503, "Display service unavailable")


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 18642), Panel).serve_forever()
