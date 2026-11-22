#!/usr/bin/env python3
"""Install the pinned DAVe backend independently of development worktrees."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from sm_manager.config import config_path, load_config
from sm_manager.dave import DaveBridge, DaveUnavailable
from scripts.manage import unit_quote

MARKER = "# Managed by sm-manager/scripts/install-dave.py"
SERVICE = "sm-manager-dave.service"


def write(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(value)
    temporary.chmod(0o600)
    temporary.replace(path)


def run(*args):
    subprocess.run(args, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials", required=True, type=Path)
    parser.add_argument("--dav-url", required=True)
    parser.add_argument("--port", type=int, default=18647)
    parser.add_argument("--prepare-only", action="store_true", help="Start DAVe without changing/restarting the system console")
    args = parser.parse_args()
    os.umask(0o077)
    config = load_config()
    if not 1024 <= args.port <= 65535 or args.port == int(config["port"]):
        parser.error("Choose a separate unprivileged loopback port")
    node = shutil.which("node")
    if not node:
        parser.error("Put Node.js 22+ and npm on PATH")
    credentials = args.credentials.expanduser().resolve()
    values = json.loads(credentials.read_text())
    if not all(isinstance(values.get(key), str) and values[key] for key in ("username", "password")):
        parser.error("Credentials must contain username and password")
    private = config_path().parent / "dave"
    data = Path(config["data_dir"]) / "dave"
    unit = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "systemd/user" / SERVICE
    if unit.exists() and MARKER not in unit.read_text():
        parser.error("An unrelated DAVe service exists")
    marker = data / "owner"
    if data.exists() and (not marker.is_file() or marker.read_text() != MARKER):
        parser.error("The DAVe data directory belongs to another installation")
    active = subprocess.run(["systemctl", "--user", "is-active", "--quiet", SERVICE]).returncode == 0
    if not active:
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(("127.0.0.1", args.port))
    for folder in (private, data, data / "app", data / "releases", unit.parent):
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    write(marker, MARKER)
    integration = ROOT / "integrations/dave"
    digest = hashlib.sha256((integration / "upstream.json").read_bytes() + (integration / "st.patch").read_bytes()
                            + (ROOT / "scripts/build-dave.py").read_bytes()).hexdigest()[:16]
    release = data / "releases" / digest
    release.mkdir(exist_ok=True, mode=0o700)
    checkout, archive = release / "checkout", release / "source.tar.gz"
    if not (release / "built").exists():
        run(sys.executable, str(ROOT / "scripts/build-dave.py"), "--checkout", str(checkout), "--source-archive", str(archive))
        write(release / "built", digest)
    secret = private / "session-secret"
    if not secret.exists():
        write(secret, secrets.token_hex(32))
    environment = {"NODE_ENV": "production", "BIND_ADDRESS": "127.0.0.1", "PORT": str(args.port),
                   "DAV_BASE_URL": args.dav_url, "SESSION_SECRET": secret.read_text(), "TRUST_PROXY": "0",
                   "DATA_DIR": str(data / "app"), "FRONTEND_DIST": str(checkout / "packages/frontend/dist"),
                   "COMPLETED_TASK_RETENTION_DAYS": "90"}
    write(private / "backend.env", "\n".join(k + "=" + unit_quote(v) for k, v in environment.items()) + "\n")
    write(unit, f'''{MARKER}
[Unit]
Description=ST shared DAVe task and calendar backend
After=network.target

[Service]
WorkingDirectory={str(checkout).replace('%', '%%')}
EnvironmentFile={str(private / 'backend.env').replace('%', '%%')}
ExecStart={unit_quote(node)} {unit_quote(checkout / 'packages/backend/dist/server.js')}
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
''')
    run("systemd-analyze", "--user", "verify", str(unit))
    run("systemctl", "--user", "daemon-reload")
    run("systemctl", "--user", "enable", SERVICE)
    run("systemctl", "--user", "restart", SERVICE)
    bridge = DaveBridge(args.port, credentials)
    for _ in range(30):
        try:
            if bridge.request("GET", "/api/me")[0] == 200:
                break
        except DaveUnavailable:
            pass
        time.sleep(.5)
    else:
        raise SystemExit("DAVe did not become ready; the system console configuration was not changed")
    if not args.prepare_only:
        path = config_path()
        current = json.loads(path.read_text()) if path.exists() else {}
        if path.exists():
            write(private / "console-before-dave.json", path.read_text())
        current.update(dave_port=args.port, dave_credentials_path=str(credentials), dave_source_archive=str(archive))
        write(path, json.dumps(current, indent=2) + "\n")
        run("systemctl", "--user", "restart", "sm-manager.service")
    print(f"DAVe ready on 127.0.0.1:{args.port}; runtime: {checkout}")
    print("System console unchanged (prepare only)." if args.prepare_only else f"Planner: {config.get('public_url', '')}/planner/tasks")


if __name__ == "__main__":
    main()
