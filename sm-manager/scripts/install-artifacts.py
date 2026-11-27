#!/usr/bin/env python3
"""Install the project-independent artifact CLI and agent skill; keep data private."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
MARKER = "Managed by ST install-artifacts.py"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--publish-url", required=True)
    parser.add_argument("--library-url", help="Owner-only console artifacts page")
    args = parser.parse_args()
    url = urlsplit(args.publish_url)
    if url.scheme != "https" or not url.hostname or url.path not in ("", "/") or url.username or url.query or url.fragment:
        parser.error("Use the publisher's HTTPS origin.")
    os.umask(0o077)
    config_root = Path.home() / ".config/herdr-artifacts"
    data_root = Path.home() / ".local/share/herdr-artifacts"
    runtime = data_root / "runtime"
    cli = Path.home() / ".local/bin/herdr-artifacts"
    skill = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "skills/herdr-artifacts/SKILL.md"
    for target in (cli, skill):
        if target.exists() and MARKER not in target.read_text():
            parser.error(f"{target} already exists and belongs to another installation.")
    for folder in (config_root, runtime / "scripts", runtime / "sm_manager", cli.parent, skill.parent):
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    config_path = config_root / "config.json"
    settings = json.loads(config_path.read_text()) if config_path.exists() else {}
    settings.setdefault("data_dir", str(data_root / "library"))
    settings.setdefault("publish_key_file", str(config_root / "publish.key"))
    settings.update(publish_url=args.publish_url.rstrip("/"), cli=str(cli))
    if args.library_url:
        library_url = urlsplit(args.library_url)
        if library_url.scheme != "https" or not library_url.hostname or library_url.username or library_url.query or library_url.fragment:
            parser.error("Use the owner-only library's HTTPS page URL without a query or fragment.")
        settings["library_url"] = args.library_url
    key = Path(settings["publish_key_file"])
    if not key.exists():
        key.write_text(secrets.token_urlsafe(48) + "\n")
        key.chmod(0o600)
    for name in ("sm_manager/__init__.py", "sm_manager/artifacts.py", "scripts/artifacts.py"):
        shutil.copyfile(ROOT / name, runtime / name)
    cli.write_text(f'''#!/usr/bin/env python3
# {MARKER}
import os, runpy
os.environ.setdefault("HERDR_ARTIFACTS_CONFIG", {str(config_path)!r})
runpy.run_path({str(runtime / 'scripts/artifacts.py')!r}, run_name="__main__")
''')
    cli.chmod(0o755)
    shutil.copyfile(ROOT / "skills/herdr-artifacts/SKILL.md", skill)
    config_path.write_text(json.dumps(settings, indent=2) + "\n")
    config_path.chmod(0o600)
    print(json.dumps({"cli": str(cli), "skill": str(skill), "config": str(config_path), "publish_url": settings["publish_url"]}, indent=2))


if __name__ == "__main__":
    main()
