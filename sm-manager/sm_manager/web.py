"""Serve only files declared by the console build, never arbitrary source paths."""
import json
from pathlib import Path, PurePosixPath

WEB = Path(__file__).parent / "web"
PAGES = {"/", "/overview", "/projects", "/containers", "/github", "/storage",
         "/zed", "/dbs", "/air-quality", "/faceplate", "/agents", "/assistant"}
PUBLIC = {"st-logo.svg", "st-logo-light.svg", "st-logo-dark.svg",
          "favicon.svg", "favicon-light.svg", "favicon-dark.svg", "favicon.png", "favicon.ico",
          "apple-touch-icon.png", "zed.svg", "db.svg", "prusa-connect.svg", "ydistri.svg", "home-icons.svg"}


def asset(path, root=None):
    root = Path(root or WEB).resolve()
    if path in PAGES or path.startswith(("/agents/chat/", "/agents/session/")):
        name = "index.html"
    else:
        name = path.removeprefix("/")
        if name not in PUBLIC:
            try:
                manifest = json.loads((root / ".vite/manifest.json").read_text())
                allowed = {entry["file"] for entry in manifest.values()}
                for entry in manifest.values():
                    allowed.update(entry.get("css", []))
                    allowed.update(entry.get("assets", []))
            except (OSError, ValueError, TypeError, KeyError):
                allowed = set()
            if name not in allowed:
                return None
    if ".." in PurePosixPath(name).parts or "\\" in name or name.startswith("/"):
        return None
    target = (root / name).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        return None
    return target, "no-store" if name == "index.html" else (
        "private, max-age=31536000, immutable" if name.startswith("assets/") else "private, no-cache")
