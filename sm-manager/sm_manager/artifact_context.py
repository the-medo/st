"""Read the Agents project catalog without creating projects or changing chats."""
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import uuid
from contextlib import closing


class ContextError(ValueError):
    pass


def conversation_id(value):
    if not value:
        return ""
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise ContextError("Choose a conversation UUID, not a terminal or chat title.") from None


def _name(value):
    return "".join(c for c in value.casefold() if c.isalnum())


class Projects:
    def __init__(self, settings):
        self.settings = settings
        self.root = Path(settings.get("agents_data_dir") or os.environ.get("ST_OVIS_SIDEBAR_DATA") or os.environ.get("MEDO_SIDEBAR_ROOT") or Path.home() / ".local/share/st-ovis/sidebar").expanduser()
        self.error = ""
        self.config = {}
        self.rows = []
        self.items = []
        try:
            self.config = json.loads((self.root / "projects.json").read_text())
            self.rows = self.config["projects"]
            appearances = json.loads((self.root / "appearance.json").read_text()) if (self.root / "appearance.json").is_file() else {}
            organization = json.loads((self.root / "organization.json").read_text()) if (self.root / "organization.json").is_file() else {}
            by_id = {p["id"]: {"id": p["id"], "name": p["name"], "appearance": {**p.get("appearance", {}), **appearances.get(p["id"], {})}} for p in self.rows}
            order = list(dict.fromkeys([key for key in organization.get("projectOrder", []) if key in by_id] + list(by_id)))
            self.items = [by_id[key] for key in order]
        except (OSError, ValueError, TypeError, KeyError):
            self.rows = []
            self.error = "Agents projects are unavailable. Existing artifacts are safe; retry when the catalog is available."

    def resolve(self, value, *, strict=True):
        if not isinstance(value, str):
            raise ContextError("Choose an Agents project or No project.")
        if not value.strip():
            return ""
        if self.error:
            if strict:
                raise ContextError(self.error)
            return ""
        for p in self.rows:
            if value == p["id"]:
                return value
        key = _name(value)
        matches = [p["id"] for p in self.rows if key in {_name(p["name"]), _name(Path(p["path"]).name), *(_name(Path(alias).name) for alias in p.get("aliases", []))}]
        if len(matches) == 1:
            return matches[0]
        if strict:
            raise ContextError("Choose an existing Agents project by ID (use 'herdr-artifacts projects'), or use --project ''.")
        return ""

    def _project_for(self, row):
        # Match the Agents sidebar resolver's precedence: an explicit assignment,
        # a unique alias, the most specific checkout, origin, then linked Git root.
        known = self.config.get("threadProjects", {}).get(row.get("id")) or row.get("project_id")
        if any(p["id"] == known for p in self.rows):
            return known
        path = row.get("cwd") or ""
        inside = lambda child, parent: child == parent or child.startswith(parent.rstrip("/") + "/")
        aliases = [p for p in self.rows if any(inside(path, alias) for alias in p.get("aliases", []))]
        if len(aliases) == 1:
            return aliases[0]["id"]
        matches = sorted((p for p in self.rows if inside(path, p["path"])), key=lambda p:len(p["path"]), reverse=True)
        if matches and matches[0]["path"] != self.config.get("workspaceRoot", str(Path.home()/"dev")):
            return matches[0]["id"]
        remote = (row.get("git_origin_url") or "").strip().removesuffix(".git").rstrip("/")
        remote = re.sub(r"^(?:https?://|ssh://)?(?:git@)?", "", remote).replace(":", "/").lower()
        owners = [p for p in self.rows if remote and remote in p.get("origins", [])]
        if len(owners) == 1:
            return owners[0]["id"]
        if Path(path).is_dir():
            try:
                result = subprocess.run(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], capture_output=True, text=True, timeout=3)
                if result.returncode == 0:
                    common = result.stdout.strip()
                    owners = sorted((p for p in self.rows if inside(common, p["path"])), key=lambda p:len(p["path"]), reverse=True)
                    if owners:
                        return owners[0]["id"]
            except (OSError, subprocess.SubprocessError):
                pass
        return matches[0]["id"] if matches else ""

    def infer(self, cwd, thread=""):
        if self.error:
            return ""
        row = {"id":thread, "cwd":str(Path(cwd).resolve())}
        if thread:
            # An agent may invoke the CLI from a temporary output directory.
            # Read only its own thread metadata; never resume or modify a chat.
            home = Path(self.settings.get("codex_home") or os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser().resolve()
            try:
                with closing(sqlite3.connect((home / "state_5.sqlite").as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
                    db.row_factory = sqlite3.Row
                    saved = db.execute("SELECT * FROM threads WHERE id=?", (thread,)).fetchone()
                    if saved:
                        row = dict(saved)
            except (sqlite3.Error, OSError):
                pass
        return self._project_for(row)
