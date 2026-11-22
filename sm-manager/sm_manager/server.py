import base64
import gzip
import hashlib
import json
import re
from functools import lru_cache
from html import escape
import logging
import mimetypes
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .collector import Collector, cleanup_plan
from .air_quality import AirQuality
from .dbs import read_db_catalog
from .history import RETENTION_HOURS
from .zed import read_catalog
from .night_mode import request as night_request
from .dave import DaveBridge, DaveUnavailable, MAX_BODY, MAX_RESPONSE, PAGES, PREFIX, upstream_path

STATIC = Path(__file__).parent / "static"


@lru_cache(maxsize=32)
def compressed_asset(body):
    return gzip.compress(body, compresslevel=6, mtime=0)


def accepts_gzip(value):
    for encoding in value.lower().split(","):
        name, *parameters = encoding.strip().split(";")
        if name != "gzip":
            continue
        try:
            return all(float(p.strip()[2:]) > 0 for p in parameters if p.strip().startswith("q="))
        except ValueError:
            return False
    return False


def read_faceplate_frame(path):
    """Read STapp's latest atomically published capture, bounded to its upload limit."""
    try:
        with Path(path).expanduser().open("rb") as handle:
            data = handle.read(3 * 1024 * 1024 + 1)
    except FileNotFoundError:
        return None
    if len(data) > 3 * 1024 * 1024:
        raise ValueError("Frame exceeds limit")
    frame = json.loads(data)
    if not isinstance(frame, dict) or frame.get("display") != "SCR-SM1":
        raise ValueError("Unexpected display")
    image = frame.get("image")
    prefix = "data:image/png;base64,"
    if not isinstance(image, str) or not image.startswith(prefix):
        raise ValueError("Expected PNG")
    if not base64.b64decode(image[len(prefix):], validate=True).startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Invalid PNG")
    timestamp = frame.get("timestamp")
    if type(timestamp) is not int or timestamp <= 0:
        raise ValueError("Invalid capture time")
    return {"display": "SCR-SM1", "timestamp": timestamp, "image": image}


def handler_for(collector, config, air_quality=None, night_control=night_request):
    token = secrets.token_urlsafe(32)
    dave = DaveBridge(config["dave_port"], config["dave_credentials_path"]) if config.get("dave_port") else None
    class Handler(BaseHTTPRequestHandler):
        server_version = "SMManager"

        def log_message(self, format, *args):
            logging.getLogger("http").debug(format, *args)

        def respond(self, status, payload, content_type="application/json", icon=False, cache=None):
            body = json.dumps(payload, separators=(",", ":")).encode() if content_type == "application/json" and not isinstance(payload, bytes) else payload
            # Only static code/styles/HTML are compressed or given validators.
            # Account data and mutation/session responses always remain no-store.
            compressible = status == 200 and cache is not None and len(body) >= 1024 and (
                content_type.startswith("text/") or "javascript" in content_type or "svg" in content_type)
            encoded = compressible and accepts_gzip(self.headers.get("Accept-Encoding", ""))
            if encoded:
                body = compressed_asset(body)
            etag = '"' + hashlib.sha256(body).hexdigest() + '"' if status == 200 and cache and cache != "no-store" else None
            if etag and etag in self.headers.get("If-None-Match", "").split(", "):
                status = 304
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "private, max-age=3600" if icon else cache or "no-store")
            if etag:
                self.send_header("ETag", etag)
            if compressible:
                self.send_header("Vary", "Accept-Encoding")
            if encoded:
                self.send_header("Content-Encoding", "gzip")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            policy = "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" if icon else "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
            url = urlsplit(self.path)
            if (not icon and status == 200 and content_type.startswith("text/html") and
                    url.path.removeprefix(PREFIX) in PAGES and url.path.startswith(PREFIX + "/") and
                    parse_qs(url.query).get("st-embedded") == ["1"]):
                policy = policy.replace("frame-ancestors 'none'", "frame-ancestors 'self'")
                self.send_header("X-Frame-Options", "SAMEORIGIN")
            if not icon and urlsplit(self.path).path.startswith(PREFIX + "/"):
                # FullCalendar bundles its navigation icon font as a data URL.
                policy += "; font-src 'self' data:"
            self.send_header("Content-Security-Policy", policy)
            self.end_headers()
            try:
                if status != 304:
                    self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def access_error(self):
            # Host validation blocks DNS rebinding. Never enable wildcard hosts or CORS.
            host = self.headers.get("Host", "").lower()
            allowed = {str(h).lower() for h in config["allowed_hosts"]}
            allowed |= {f"{h}:{config['port']}" for h in list(allowed)}
            if host not in allowed:
                return "Host not allowed"
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                return "Cross-site access denied"
            origin = self.headers.get("Origin")
            if origin and origin not in {f"http://{host}", f"https://{host}"}:
                return "Origin not allowed"
            return None

        def dave_request(self):
            if dave is None:
                return self.respond(503, {"error": "Tasks and Calendar are not configured on this ST instance."})
            path = urlsplit(self.path).path
            if path in (PREFIX, PREFIX + "/"):
                self.send_response(302)
                self.send_header("Location", PREFIX + "/tasks")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if path == PREFIX + "/source.tar.gz" and self.command == "GET":
                try:
                    with Path(config["dave_source_archive"]).expanduser().open("rb") as source:
                        body = source.read(MAX_RESPONSE + 1)
                    if len(body) > MAX_RESPONSE:
                        raise ValueError()
                except (OSError, ValueError):
                    return self.respond(503, {"error": "Planner source archive unavailable."})
                return self.respond(200, body, "application/gzip")
            if path == PREFIX + "/api/st-session" and self.command == "GET":
                return self.respond(200, {"token": token})
            target = upstream_path(self.path)
            if target is None or (self.command != "GET" and not target.startswith("/api/")):
                return self.respond(404, {"error": "Not found"})
            body = None
            if self.command != "GET":
                if not secrets.compare_digest(self.headers.get("X-ST-Planner-Token", "").encode(), token.encode()):
                    return self.respond(403, {"error": "Refresh the planner session.", "code": "ST_SESSION_EXPIRED"})
                if self.headers.get("Transfer-Encoding"):
                    return self.respond(400, {"error": "Unsupported transfer encoding"})
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 <= length <= MAX_BODY:
                        raise ValueError()
                    self.connection.settimeout(15)
                    body = self.rfile.read(length)
                    if len(body) != length:
                        raise ValueError()
                except (ValueError, OSError):
                    return self.respond(400, {"error": "Invalid planner request body"})
            try:
                status, headers, data = dave.request(self.command, target, body, self.headers.get("Content-Type"))
            except DaveUnavailable:
                return self.respond(503, {"error": "Planner temporarily unavailable. Try again shortly."})
            # Do not forward upstream cookies, redirects or authentication headers.
            if 300 <= status < 400:
                return self.respond(502, {"error": "Unexpected planner redirect"})
            content_type = next((v for k, v in headers.items() if k.lower() == "content-type"), "application/octet-stream")
            cache = None
            if status == 200 and path.startswith(PREFIX + "/assets/") and (
                    "javascript" in content_type or content_type.startswith("text/css")):
                cache = "private, max-age=31536000, immutable" if re.fullmatch(
                    r"/planner/assets/[\w.-]+-[\w-]{8,}\.(js|css)", path) else "private, no-cache"
            elif status == 200 and path.removeprefix(PREFIX) in PAGES:
                cache = "no-store"
            return self.respond(status, data, content_type, cache=cache)

        def do_PUT(self):
            if error := self.access_error():
                return self.respond(403, {"error": error})
            if urlsplit(self.path).path.startswith(PREFIX + "/"):
                return self.dave_request()
            return self.respond(501, {"error": "Unsupported action"})

        do_DELETE = do_PATCH = do_PUT

        def do_POST(self):
            if error := self.access_error():
                return self.respond(403, {"error": error})
            if urlsplit(self.path).path.startswith(PREFIX + "/"):
                return self.dave_request()
            if urlsplit(self.path).path != "/api/night-mode":
                return self.respond(501, {"error": "Unsupported action"})
            if not secrets.compare_digest(self.headers.get("X-SM-Token", "").encode(), token.encode()):
                return self.respond(403, {"error": "Refresh the page before changing night mode."})
            if self.headers.get("Content-Type") != "application/json" or self.headers.get("Transfer-Encoding"):
                return self.respond(400, {"error": "Expected a small JSON action"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 128:
                    raise ValueError()
                self.connection.settimeout(3)
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict) or set(payload) != {"action"} or payload["action"] not in ("on", "off", "toggle"):
                    raise ValueError()
            except (ValueError, OSError):
                return self.respond(400, {"error": "Use action on, off, or toggle"})
            result = night_control(payload["action"])
            return self.respond(200 if result.get("available") and not result.get("error") else 409, {**result, "token": token})

        def do_GET(self):
            if error := self.access_error():
                return self.respond(403, {"error": error})
            url = urlsplit(self.path)
            planner_shell = (dave is not None and url.path.startswith(PREFIX + "/") and
                             url.path.removeprefix(PREFIX) in PAGES - {"/"} and
                             parse_qs(url.query).get("st-embedded") != ["1"])
            if (url.path == PREFIX or url.path.startswith(PREFIX + "/")) and not planner_shell:
                return self.dave_request()
            if url.path == "/api/night-mode":
                return self.respond(200, {**night_control("status"), "token": token})
            if url.path.startswith("/api/"):
                if url.path == "/api/air-quality":
                    if air_quality is None:
                        return self.respond(503, {"error": "Air quality collector unavailable"})
                    try:
                        query = parse_qs(url.query)
                        hours = float(query.get("hours", ["24"])[0])
                        bucket = query.get("bucket", ["auto"])[0]
                        return self.respond(200, air_quality.query(
                            hours, bucket_seconds=None if bucket == "auto" else int(bucket)))
                    except ValueError:
                        return self.respond(400, {"error": f"Use hours=0.25..{RETENTION_HOURS} and bucket=auto,60,300,900,1800,3600,21600,86400; choose a bucket within the range and at most 1440 intervals."})
                if url.path == "/api/faceplate":
                    try:
                        return self.respond(200, read_faceplate_frame(config["faceplate_frame_path"]))
                    except (OSError, ValueError, RecursionError):
                        return self.respond(503, {"error": "Faceplate capture unavailable"})
                if url.path == "/api/dbs":
                    try:
                        catalog = read_db_catalog(config["db_catalog_path"], config.get("cloudbeaver_host", ""))
                    except OSError:
                        return self.respond(503, {"error": "Could not read the DB catalog. Check db_catalog_path."})
                    except (ValueError, RecursionError):
                        return self.respond(503, {"error": "Invalid DB catalog. Expected a version 1 connections file with a UTC check time."})
                    return self.respond(200, catalog)
                snapshot = collector.get_snapshot()
                if url.path == "/api/zed":
                    projects = (snapshot or {}).get("projects", [])
                    paths = {w["path"] for p in projects for w in p["worktrees"]}
                    if projects:
                        cached = collector.disk_usage.status({p["id"] for p in projects})["projects"]
                        paths.update(w["path"] for p in cached.values() for w in p.get("worktrees", []) if w.get("path"))
                    try:
                        catalog = read_catalog(config["zed_catalog_path"], paths)
                    except OSError:
                        return self.respond(503, {"error": "Could not read the Zed catalog. Check zed_catalog_path."})
                    except (ValueError, RecursionError):
                        return self.respond(503, {"error": "Invalid Zed catalog. Expected a version 1 projects file."})
                    return self.respond(200, catalog)
                if url.path == "/api/health":
                    healthy = bool(snapshot and not snapshot["stale"])
                    return self.respond(200 if healthy else 503, {"status": "ok" if healthy else "warming" if not snapshot else "stale", "last_sample": snapshot["timestamp"] if snapshot else None})
                if not snapshot:
                    return self.respond(503, {"error": "Taking the first sample. Please wait a moment."})
                if url.path == "/api/snapshot":
                    return self.respond(200, snapshot)
                if url.path.startswith("/api/project-icon/"):
                    parts = url.path.split("/")
                    if len(parts) != 5 or parts[3] not in {p["id"] for p in snapshot["projects"]}:
                        return self.respond(404, {"error": "Project icon not found"})
                    icon = collector.get_project_icon(parts[3], parts[4])
                    if not icon:
                        return self.respond(404, {"error": "Project icon not found"})
                    return self.respond(200, icon["data"], icon["mime"], icon=True)
                if url.path == "/api/history":
                    query = parse_qs(url.query)
                    try:
                        hours = float(query.get("hours", ["24"])[0])
                        entity = query.get("entity", ["host"])[0]
                        if len(entity) > 100 or not 0.25 <= hours <= RETENTION_HOURS:
                            raise ValueError()
                    except ValueError:
                        return self.respond(400, {"error": f"Use hours=0.25..{RETENTION_HOURS} and a valid entity"})
                    return self.respond(200, collector.history.query(entity, hours))
                if url.path == "/api/disk-usage":
                    query = parse_qs(url.query)
                    project_ids = {project["id"] for project in snapshot["projects"]}
                    if query.get("scan") == ["1"]:
                        project_id = query.get("project", [""])[0]
                        if project_id not in project_ids:
                            return self.respond(404, {"error": "Project not found"})
                        if not collector.disk_usage.start(snapshot["projects"], project_id):
                            return self.respond(409, {"error": "Another project scan is in progress"})
                        return self.respond(202, collector.disk_usage.status(project_ids))
                    return self.respond(200, collector.disk_usage.status(project_ids))
                if url.path.startswith("/api/cleanup-plan/"):
                    plan = cleanup_plan(snapshot, url.path.rsplit("/", 1)[-1])
                    return self.respond(200 if plan else 404, plan or {"error": "Worktree not found"})
                return self.respond(404, {"error": "Not found"})
            name = {"/": "index.html", "/app.js": "app.js", "/style.css": "style.css",
                    "/favicon.svg": "favicon.svg", "/st-logo.svg": "st-logo.svg",
                    "/workmode.js": "workmode.js", "/ydistri.svg": "ydistri.svg",
                    "/zed.svg": "zed.svg", "/db.svg": "db.svg",
                    "/prusa-connect.svg": "prusa-connect.svg",
                    "/night-mode.js": "night-mode.js", "/dbs.js": "dbs.js", "/air-quality.js": "air-quality.js"}.get(url.path)
            if planner_shell:
                name = "index.html"
            elif url.path == "/planner-shell.js":
                name = "planner-shell.js"
            if not name:
                return self.respond(404, {"error": "Not found"})
            mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
            body = (STATIC / name).read_bytes()
            if name == "index.html":
                body = body.replace(b"data-planner-link", b"" if dave else b"hidden")
                body = body.replace(b'data-st-view="console"', b'data-st-view="planner"' if planner_shell else b'data-st-view="console"')
                printer = config.get("printer_url", "")
                link = 'href="' + escape(printer, quote=True) + '"' if printer.startswith("https://") else "hidden"
                body = body.replace(b"data-printer-link", link.encode())
            return self.respond(200, body, mime + ("; charset=utf-8" if mime.startswith("text/") else ""),
                                cache="no-store" if name == "index.html" else "private, no-cache")

    return Handler


def serve(config):
    collector = Collector(config)
    air_quality = AirQuality(config)
    server = ThreadingHTTPServer(("127.0.0.1", config["port"]), handler_for(collector, config, air_quality))
    air_thread = threading.Thread(target=air_quality.run, name="air-quality", daemon=True)
    air_thread.start()
    thread = threading.Thread(target=collector.run, name="collector", daemon=True)
    thread.start()
    logging.info("SM Manager listening at http://127.0.0.1:%s", config["port"])
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        air_quality.stop_event.set()
        air_thread.join(timeout=15)
        if not air_thread.is_alive():
            air_quality.close()
        collector.stop_event.set()
        thread.join(timeout=30)
        if not thread.is_alive():
            collector.history.close()
