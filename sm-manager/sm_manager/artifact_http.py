"""Owner-authenticated library routes, kept separate from public sharing."""
import json
import hashlib
import hmac
import re
import secrets
import time
from urllib.parse import parse_qs, unquote, urlsplit

from .artifacts import ArtifactError, Library, MAX_BYTES, PREVIEW_POLICY, read_settings
from .artifact_context import ContextError

PREVIEW_ROUTE = re.compile(r"/api/artifact-preview/([a-f0-9]{32})/([1-9]\d*)/(\d{10})/([a-f0-9]{64})/(.+)")


def preview_request(method, path):
    return method == "GET" and PREVIEW_ROUTE.fullmatch(path) is not None


def signature(token, artifact_id, revision, expires):
    return hmac.new(token.encode(), f"{artifact_id}/{revision}/{expires}".encode(), hashlib.sha256).hexdigest()


def owner_view(item, token):
    revision = item.get("selected_revision", item["revision"])
    # Stable within a half-hour window; always expires within one hour. Restarting
    # the monitor also invalidates these read-only, revision-scoped capabilities.
    expires = (int(time.time()) // 1800 + 2) * 1800
    signed = signature(token, item["id"], revision, expires)
    return {**item, "preview_base": f"/api/artifact-preview/{item['id']}/{revision}/{expires}/{signed}/"}


def send_file(handler, file, content, download=False, preview=False):
    handler.send_response(200)
    handler.send_header("Content-Type", file["mime"])
    handler.send_header("Content-Length", str(len(content)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("Referrer-Policy", "no-referrer")
    handler.send_header("Content-Security-Policy", PREVIEW_POLICY if file["mime"] != "application/pdf" else "frame-ancestors 'self'")
    if preview:
        # Sandboxed module scripts/fonts have an opaque origin. The capability,
        # not cookies, grants access to this revision's output files only.
        handler.send_header("Access-Control-Allow-Origin", "*")
    if download or file["role"] == "source" or file["mime"] not in ("text/html", "application/pdf", "text/css", "application/javascript", "text/javascript") and not file["mime"].startswith(("image/", "font/", "audio/", "video/")):
        handler.send_header("Content-Disposition", "attachment")
    handler.end_headers()
    handler.wfile.write(content)


def request(handler, config, token):
    url = urlsplit(handler.path)
    preview = PREVIEW_ROUTE.fullmatch(url.path) if handler.command == "GET" else None
    if preview:
        artifact_id, revision, expires, signed, name = preview.groups()
        if int(expires) <= time.time() or int(expires) > time.time() + 3600 or not hmac.compare_digest(signature(token, artifact_id, revision, expires), signed):
            handler.respond(403, {"error": "Preview expired. Refresh the library."})
            return True
    if not (url.path == "/api/artifacts" or url.path.startswith("/api/artifacts/")):
        if not preview:
            return False
    try:
        library = Library(read_settings(config.get("artifacts_config_path")))
        if preview:
            file, content = library.file(artifact_id, int(revision), unquote(name))
            if file["role"] != "output":
                handler.respond(404, {"error": "Preview file not found."})
                return True
            send_file(handler, file, content, preview=True)
            return True
        path = url.path.removeprefix("/api/artifacts")
        if handler.command == "GET":
            if not path:
                query = parse_qs(url.query).get("q", [""])[0]
                handler.respond(200, {"artifacts": [owner_view(item, token) for item in library.list(query)], "projects": library.projects.items, "projects_error": library.projects.error, "token": token})
                return True
            file_match = re.fullmatch(r"/([a-f0-9]{32})/revisions/(\d+)/files/(.+)", path)
            if file_match:
                artifact_id, revision, name = file_match.groups()
                file, content = library.file(artifact_id, int(revision), unquote(name))
                download = parse_qs(url.query).get("download") == ["1"] or file["role"] == "source"
                send_file(handler, file, content, download)
                return True
            if re.fullmatch(r"/[a-f0-9]{32}", path):
                revision = parse_qs(url.query).get("revision", [None])[0]
                handler.respond(200, owner_view(library.get(path[1:], int(revision) if revision else None), token))
                return True
        if handler.command == "POST":
            if not secrets.compare_digest(handler.headers.get("X-ST-Artifacts-Token", "").encode(), token.encode()):
                handler.respond(403, {"error": "Refresh the artifact library before saving changes."})
                return True
            if handler.headers.get("Content-Type") != "application/json" or handler.headers.get("Transfer-Encoding"):
                raise ArtifactError("Expected a JSON artifact action.")
            length = int(handler.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BYTES * 4 // 3 + 1024 * 1024:
                raise ArtifactError("An artifact revision can contain up to 32 MiB.")
            handler.connection.settimeout(30)
            body = handler.rfile.read(length)
            if len(body) != length:
                raise ArtifactError("The upload was incomplete.")
            payload = json.loads(body)
            if not isinstance(payload, dict):
                raise ArtifactError("Expected an artifact object.")
            if not path:
                result = library.save(payload)
            else:
                match = re.fullmatch(r"/([a-f0-9]{32})/(save|restore|checkout|publish|unpublish|metadata)", path)
                if not match:
                    handler.respond(404, {"error": "Artifact action not found."})
                    return True
                artifact_id, action = match.groups()
                if action == "save":
                    result = library.save(payload, artifact_id)
                elif action == "restore":
                    result = library.restore(artifact_id, payload.get("revision"), payload.get("base_revision"))
                elif action == "checkout":
                    result = library.checkout(artifact_id)
                elif action == "publish":
                    result = library.publish(artifact_id, payload.get("revision"))
                elif action == "metadata":
                    result = library.metadata(artifact_id, payload)
                else:
                    result = library.unpublish(artifact_id)
            handler.respond(200, owner_view(result, token) if "manifest" in result else result)
            return True
        handler.respond(404, {"error": "Artifact route not found."})
    except ContextError as error:
        handler.respond(400, {"error": str(error)})
    except ArtifactError as error:
        handler.respond(error.status, {"error": str(error)})
    except (ValueError, TypeError, KeyError):
        handler.respond(400, {"error": "Invalid artifact request."})
    except OSError:
        handler.respond(503, {"error": "Artifact storage is unavailable."})
    return True
