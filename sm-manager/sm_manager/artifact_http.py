"""Owner-authenticated library routes, kept separate from public sharing."""
import json
import re
import secrets
from urllib.parse import parse_qs, unquote, urlsplit

from .artifacts import ArtifactError, Library, MAX_BYTES, PREVIEW_POLICY, read_settings


def request(handler, config, token):
    url = urlsplit(handler.path)
    if not (url.path == "/api/artifacts" or url.path.startswith("/api/artifacts/")):
        return False
    try:
        library = Library(read_settings(config.get("artifacts_config_path")))
        path = url.path.removeprefix("/api/artifacts")
        if handler.command == "GET":
            if not path:
                query = parse_qs(url.query).get("q", [""])[0]
                handler.respond(200, {"artifacts": library.list(query), "token": token})
                return True
            file_match = re.fullmatch(r"/([a-f0-9]{32})/revisions/(\d+)/files/(.+)", path)
            if file_match:
                artifact_id, revision, name = file_match.groups()
                file, content = library.file(artifact_id, int(revision), unquote(name))
                download = parse_qs(url.query).get("download") == ["1"] or file["role"] == "source"
                handler.send_response(200)
                handler.send_header("Content-Type", file["mime"])
                handler.send_header("Content-Length", str(len(content)))
                handler.send_header("Cache-Control", "no-store")
                handler.send_header("X-Content-Type-Options", "nosniff")
                handler.send_header("Referrer-Policy", "no-referrer")
                handler.send_header("Content-Security-Policy", PREVIEW_POLICY if file["mime"] != "application/pdf" else "frame-ancestors 'self'")
                if download or file["mime"] not in ("text/html", "application/pdf", "text/css", "application/javascript", "text/javascript") and not file["mime"].startswith(("image/", "font/", "audio/", "video/")):
                    handler.send_header("Content-Disposition", "attachment")
                handler.end_headers()
                handler.wfile.write(content)
                return True
            if re.fullmatch(r"/[a-f0-9]{32}", path):
                revision = parse_qs(url.query).get("revision", [None])[0]
                handler.respond(200, library.get(path[1:], int(revision) if revision else None))
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
            handler.respond(200, result)
            return True
        handler.respond(404, {"error": "Artifact route not found."})
    except ArtifactError as error:
        handler.respond(error.status, {"error": str(error)})
    except (ValueError, TypeError, KeyError):
        handler.respond(400, {"error": "Invalid artifact request."})
    except OSError:
        handler.respond(503, {"error": "Artifact storage is unavailable."})
    return True
