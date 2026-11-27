"""Durable, project-independent artifacts. Published output is a separate snapshot."""
import base64
from contextlib import closing
import hashlib
import json
import mimetypes
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import sqlite3
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
import uuid

MAX_BYTES = 32 * 1024 * 1024
MAX_FILES = 256
ID = re.compile(r"^[a-f0-9]{32}$")
MIME = re.compile(r"^[a-z0-9.+-]+/[a-z0-9.+-]+$")
PREVIEW_POLICY = ("sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; "
                  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
                  "font-src 'self' data:; media-src 'self' data: blob:; "
                  "connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")


class ArtifactError(ValueError):
    status = 400


class Conflict(ArtifactError):
    status = 409


class NotFound(ArtifactError):
    status = 404


def safe_path(value):
    if (not isinstance(value, str) or not value or len(value) > 512 or
            any(ord(c) < 32 for c in value) or any(c in value for c in "\\?#%") or
            value.startswith("/") or any(p in ("", ".", "..") for p in value.split("/"))):
        raise ArtifactError("Use a relative file path inside the artifact.")
    return value


def short_text(value, name, limit=200):
    if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 for c in value):
        raise ArtifactError(f"Invalid {name}.")
    return value.strip()


def read_settings(path=None):
    path = Path(path or os.environ.get("HERDR_ARTIFACTS_CONFIG", Path.home() / ".config/herdr-artifacts/config.json")).expanduser()
    if not path.is_file():
        raise ArtifactError("The artifact library is not configured on this instance.")
    settings = json.loads(path.read_text())
    if not isinstance(settings.get("data_dir"), str):
        raise ArtifactError("The artifact library needs a data directory.")
    return settings


class Library:
    def __init__(self, settings):
        self.settings = settings
        self.root = Path(settings["data_dir"]).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        (self.root / "objects").mkdir(exist_ok=True, mode=0o700)
        with closing(self.connect()) as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS artifacts (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT NOT NULL,
                    folder TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL,
                    revision INTEGER NOT NULL, published_revision INTEGER,
                    share_token TEXT UNIQUE, source_chat TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS revisions (
                    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
                    number INTEGER NOT NULL, created REAL NOT NULL, note TEXT NOT NULL,
                    manifest TEXT NOT NULL, PRIMARY KEY(artifact_id, number)
                );
            """)

    def connect(self):
        db = sqlite3.connect(self.root / "library.sqlite", timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        return db

    def _row(self, db, artifact_id):
        if not isinstance(artifact_id, str) or not ID.fullmatch(artifact_id):
            raise NotFound("Artifact not found.")
        row = db.execute("SELECT * FROM artifacts WHERE id=?", (artifact_id,)).fetchone()
        if row is None:
            raise NotFound("Artifact not found.")
        return dict(row)

    def _view(self, row):
        result = dict(row)
        token = result.pop("share_token", None)
        origin = self.settings.get("publish_url", "").rstrip("/")
        result["share_url"] = f"{origin}/a/{token}/" if token and result["published_revision"] and origin else None
        library_url = self.settings.get("library_url", "")
        result["library_url"] = f"{library_url}?id={row['id']}" if library_url else None
        return result

    def list(self, query=""):
        with closing(self.connect()) as db:
            rows = db.execute("SELECT * FROM artifacts ORDER BY updated DESC").fetchall()
            found = [dict(row) for row in rows if query.casefold() in " ".join((row["title"], row["project"], row["folder"])).casefold()]
            for row in found:
                manifest = json.loads(db.execute("SELECT manifest FROM revisions WHERE artifact_id=? AND number=?", (row["id"], row["revision"])).fetchone()[0])
                row["entrypoint"] = manifest["entrypoint"]
                row["mime"] = next(f["mime"] for f in manifest["files"] if f["path"] == manifest["entrypoint"])
            return [self._view(row) for row in found]

    def get(self, artifact_id, revision=None):
        with closing(self.connect()) as db:
            item = self._row(db, artifact_id)
            number = item["revision"] if revision is None else revision
            row = db.execute("SELECT * FROM revisions WHERE artifact_id=? AND number=?", (artifact_id, number)).fetchone()
            if row is None:
                raise NotFound("Revision not found.")
            result = self._view(item)
            result.update(manifest=json.loads(row["manifest"]), selected_revision=number,
                          history=[dict(r) for r in db.execute("SELECT number,created,note FROM revisions WHERE artifact_id=? ORDER BY number DESC", (artifact_id,))])
            return result

    def _blob(self, data):
        digest = hashlib.sha256(data).hexdigest()
        path = self.root / "objects" / digest
        if not path.exists():
            fd, temporary = tempfile.mkstemp(dir=path.parent)
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, path)
            finally:
                Path(temporary).unlink(missing_ok=True)
        return digest

    def save(self, payload, artifact_id=None):
        if not isinstance(payload, dict):
            raise ArtifactError("Expected an artifact object.")
        files = payload.get("files")
        if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
            raise ArtifactError(f"Choose between 1 and {MAX_FILES} files.")
        entrypoint = safe_path(payload.get("entrypoint"))
        manifest = {"entrypoint": entrypoint, "files": []}
        paths = set()
        total = 0
        for item in files:
            if not isinstance(item, dict):
                raise ArtifactError("Invalid file.")
            path = safe_path(item.get("path"))
            if path in paths:
                raise ArtifactError("File names must be unique.")
            paths.add(path)
            role = item.get("role", "output")
            if role not in ("output", "source"):
                raise ArtifactError("File role must be output or source.")
            try:
                data = base64.b64decode(item["base64"], validate=True)
            except (KeyError, ValueError, TypeError):
                raise ArtifactError("File contents must be base64 encoded.") from None
            total += len(data)
            if total > MAX_BYTES:
                raise ArtifactError("An artifact revision can contain up to 32 MiB.")
            mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
            manifest["files"].append({"path": path, "role": role, "size": len(data), "mime": mime, "sha256": self._blob(data)})
        if not any(f["path"] == entrypoint and f["role"] == "output" for f in manifest["files"]):
            raise ArtifactError("Choose an output file as the entrypoint.")
        note = short_text(payload.get("note", ""), "revision note", 500)
        now = time.time()
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if artifact_id:
                previous = self._row(db, artifact_id)
                if type(payload.get("base_revision")) is not int or payload["base_revision"] != previous["revision"]:
                    raise Conflict("This artifact changed. Read its latest revision before saving your changes.")
                number = previous["revision"] + 1
            else:
                artifact_id = uuid.uuid4().hex
                previous = {"title": "Untitled artifact", "project": "", "folder": "", "source_chat": ""}
                number = 1
            values = {key: short_text(payload.get(key, previous[key]), key, 500 if key == "source_chat" else 200) for key in ("title", "project", "folder", "source_chat")}
            if not values["title"]:
                raise ArtifactError("Give the artifact a title.")
            if number == 1:
                db.execute("INSERT INTO artifacts(id,title,project,folder,created,updated,revision,source_chat) VALUES(?,?,?,?,?,?,?,?)", (artifact_id, values["title"], values["project"], values["folder"], now, now, number, values["source_chat"]))
            else:
                db.execute("UPDATE artifacts SET title=?,project=?,folder=?,source_chat=?,updated=?,revision=? WHERE id=?", (values["title"], values["project"], values["folder"], values["source_chat"], now, number, artifact_id))
            db.execute("INSERT INTO revisions VALUES(?,?,?,?,?)", (artifact_id, number, now, note, json.dumps(manifest)))
        return self.get(artifact_id)

    def file(self, artifact_id, revision, path):
        item = self.get(artifact_id, revision)
        path = safe_path(path)
        file = next((f for f in item["manifest"]["files"] if f["path"] == path), None)
        if file is None:
            raise NotFound("File not found in this revision.")
        return file, (self.root / "objects" / file["sha256"]).read_bytes()

    def restore(self, artifact_id, number, base_revision):
        old = self.get(artifact_id, number)
        files = [{**f, "base64": base64.b64encode((self.root / "objects" / f["sha256"]).read_bytes()).decode()} for f in old["manifest"]["files"]]
        return self.save({"base_revision": base_revision, "entrypoint": old["manifest"]["entrypoint"], "files": files, "note": f"Restored revision {number}"}, artifact_id)

    def metadata(self, artifact_id, payload):
        values = {key: short_text(payload.get(key, ""), key) for key in ("title", "project", "folder")}
        if not values["title"]:
            raise ArtifactError("Give the artifact a title.")
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            self._row(db, artifact_id)
            db.execute("UPDATE artifacts SET title=?,project=?,folder=?,updated=? WHERE id=?", (values["title"], values["project"], values["folder"], time.time(), artifact_id))
        return self.get(artifact_id)

    def checkout(self, artifact_id):
        item = self.get(artifact_id)
        folder = self.root / "working" / artifact_id / uuid.uuid4().hex
        folder.mkdir(parents=True, mode=0o700)
        for file in item["manifest"]["files"]:
            target = folder / file["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(self.root / "objects" / file["sha256"], target)
        (folder / ".artifact.json").write_text(json.dumps({"id": artifact_id, "base_revision": item["revision"], "entrypoint": item["manifest"]["entrypoint"], "files": [{"path": f["path"], "role": f["role"]} for f in item["manifest"]["files"]]}, indent=2))
        return {"id": artifact_id, "title": item["title"], "revision": item["revision"], "directory": str(folder),
                "cli": self.settings.get("cli", str(Path.home() / ".local/bin/herdr-artifacts"))}

    def _remote(self, method, path, payload=None, blob=None):
        origin = self.settings.get("publish_url", "").rstrip("/")
        parsed = urlsplit(origin)
        if parsed.scheme != "https" or not parsed.hostname or parsed.path or parsed.query or parsed.fragment or parsed.username:
            raise ArtifactError("Sharing needs an HTTPS publishing service.")
        key_path = self.settings.get("publish_key_file")
        if not key_path:
            raise ArtifactError("Sharing is not configured on this instance.")
        key = Path(key_path).expanduser().read_text().strip()
        request = Request(origin + path, method=method, data=blob if blob is not None else json.dumps(payload).encode() if payload is not None else None,
                          headers={"Authorization": "Bearer " + key, "User-Agent": "Herdr-Artifacts/1.0", "Content-Type": "application/octet-stream" if blob is not None else "application/json"})
        try:
            with urlopen(request, timeout=45) as response:
                return json.loads(response.read(65536))
        except (HTTPError, URLError, TimeoutError):
            raise ArtifactError("The publishing service could not complete this change. Your saved revision is safe; retry sharing.") from None

    def publish(self, artifact_id, revision):
        # Serialize publication/revocation, including the remote acknowledgement. A failed
        # upload leaves the old published snapshot intact. Repeating it is idempotent.
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            item = self._row(db, artifact_id)
            if type(revision) is not int or revision != item["revision"]:
                raise Conflict("The artifact changed. Review the current revision before sharing.")
            token = item["share_token"] or secrets.token_urlsafe(24)
            # Persist the identity before remote publication so a lost response never creates
            # an untracked public URL. A token alone does not make an artifact public.
            db.execute("UPDATE artifacts SET share_token=? WHERE id=?", (token, artifact_id))
            db.commit()
            db.execute("BEGIN IMMEDIATE")
            current = self._row(db, artifact_id)
            if current["revision"] != revision or current["share_token"] != token:
                raise Conflict("The artifact changed. Review it before sharing.")
            manifest = json.loads(db.execute("SELECT manifest FROM revisions WHERE artifact_id=? AND number=?", (artifact_id, revision)).fetchone()[0])
            outputs = [f for f in manifest["files"] if f["role"] == "output"]
            for file in outputs:
                self._remote("PUT", f"/admin/objects/{file['sha256']}", blob=(self.root / "objects" / file["sha256"]).read_bytes())
            self._remote("PUT", f"/admin/shares/{token}", {"artifact_id": artifact_id, "revision": revision, "entrypoint": manifest["entrypoint"], "files": outputs})
            db.execute("UPDATE artifacts SET published_revision=? WHERE id=?", (revision, artifact_id))
        return self.get(artifact_id)

    def unpublish(self, artifact_id):
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            item = self._row(db, artifact_id)
            if item["share_token"]:
                self._remote("DELETE", f"/admin/shares/{item['share_token']}")
                db.execute("UPDATE artifacts SET published_revision=NULL WHERE id=?", (artifact_id,))
        return self.get(artifact_id)
