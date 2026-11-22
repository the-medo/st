#!/usr/bin/env python3
"""Start/stop an independent ST + DAVe preview without changing the installed ST."""

import argparse
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from sm_manager.config import load_config  # noqa: E402
from scripts.manage import unit_quote  # noqa: E402

MARKER = "# Managed by sm-manager/scripts/preview-dave.py"
SERVICES = ("st-dave-preview-backend.service", "st-dave-preview.service")
CONFIG = Path.home() / ".config/st-dave-preview"
DATA = Path.home() / ".local/share/st-dave-preview"
UNITS = Path.home() / ".config/systemd/user"


def run(*args, capture=False):
    return subprocess.check_output(args, text=True) if capture else subprocess.run(args, check=True)


def write(path, value):
    path.write_text(value)
    path.chmod(0o600)


def wait_ready(port):
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        ready = True
        for path in ("/api/health", "/planner/api/me"):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
            try:
                connection.request("GET", path)
                response = connection.getresponse()
                ready = ready and response.status == 200
                response.read(8192)
            except (OSError, http.client.HTTPException):
                ready = False
            finally:
                connection.close()
            if not ready:
                break
        if ready:
            return
        time.sleep(0.5)
    raise SystemExit("Preview is not ready. Check the two preview services and the configured DAV account.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("start", "stop", "status", "restart"))
    parser.add_argument("--checkout", type=Path)
    parser.add_argument("--credentials", type=Path)
    parser.add_argument("--dav-url")
    parser.add_argument("--source-archive", type=Path)
    parser.add_argument("--port", type=int, default=18645)
    parser.add_argument("--dave-port", type=int, default=18646)
    args = parser.parse_args()
    os.umask(0o077)
    tailscale = shutil.which("tailscale")
    if not tailscale:
        parser.error("Add tailscale to PATH")
    profile_path = CONFIG / "profile.json"
    profile = json.loads(profile_path.read_text()) if profile_path.exists() else None
    if profile and profile["source"] != str(ROOT):
        parser.error("This preview belongs to another checkout; stop/manage it there first")
    for name in SERVICES:
        path = UNITS / name
        if path.exists() and MARKER not in path.read_text():
            parser.error(f"Unrelated service already exists: {name}")
    if args.action == "status":
        run("systemctl", "--user", "status", *SERVICES, "--no-pager")
        if profile:
            print(profile["url"])
        return
    if args.action == "restart":
        if not profile:
            parser.error("No preview configured")
        run("systemctl", "--user", "restart", *SERVICES)
        wait_ready(profile["port"])
        print(profile["url"])
        return
    serve = json.loads(run(tailscale, "serve", "status", "--json", capture=True))
    if args.action == "stop":
        if not profile:
            parser.error("No preview configured")
        expected = {"Handlers": {"/": {"Proxy": profile["target"]}}}
        route = serve.get("Web", {}).get(profile["host"])
        if route and route != expected:
            parser.error("Preview route now belongs to another target")
        if route:
            run(tailscale, "serve", f"--https={profile['port']}", "off")
        run("systemctl", "--user", "disable", "--now", *reversed(SERVICES))
        print("Preview stopped; configuration and data retained.")
        return
    if not all((args.checkout, args.credentials, args.dav_url, args.source_archive)):
        parser.error("start requires --checkout, --credentials, --dav-url and --source-archive")
    if args.port == args.dave_port or any(not 1024 <= p <= 65535 for p in (args.port, args.dave_port)):
        parser.error("Choose two distinct unprivileged ports")
    node = shutil.which("node")
    if not node:
        parser.error("Add Node.js 22+ to PATH")
    checkout = args.checkout.expanduser().resolve()
    credentials = args.credentials.expanduser().resolve()
    archive = args.source_archive.expanduser().resolve()
    if not all(path.is_file() for path in (checkout / "packages/backend/dist/server.js", credentials, archive)):
        parser.error("Build DAVe first and supply existing credential/source files")
    for port in (args.port, args.dave_port):
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(("127.0.0.1", port))
        if str(port) in serve.get("TCP", {}):
            parser.error(f"Tailscale port {port} is occupied")
    status = json.loads(run(tailscale, "status", "--json", capture=True))
    dns = status["Self"]["DNSName"].rstrip(".")
    host = f"{dns}:{args.port}"
    target = f"http://127.0.0.1:{args.port}"
    url = f"https://{host}"
    for directory in (CONFIG, DATA, DATA / "app", DATA / "monitor"):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    config = load_config()
    for key in ("deployment_dir", "serve_mapping", "https_mapping"):
        config.pop(key, None)
    config.update(port=args.port, public_url=url, allowed_hosts=["localhost", "127.0.0.1", dns],
                  data_dir=str(DATA / "monitor"), dave_port=args.dave_port,
                  dave_credentials_path=str(credentials), dave_source_archive=str(archive))
    write(CONFIG / "monitor.json", json.dumps(config, indent=2) + "\n")
    # Keep the session secret stable across stop/start and rebuilds.
    secret_file = CONFIG / "session-secret"
    if not secret_file.exists():
        import secrets
        write(secret_file, secrets.token_hex(32))
    values = {"NODE_ENV": "production", "DAV_BASE_URL": args.dav_url,
              "SESSION_SECRET": secret_file.read_text().strip(), "PORT": str(args.dave_port),
              "BIND_ADDRESS": "127.0.0.1", "TRUST_PROXY": "0", "DATA_DIR": str(DATA / "app"),
              "FRONTEND_DIST": str(checkout / "packages/frontend/dist")}
    write(CONFIG / "dave.env", "\n".join(key + "=" + unit_quote(value) for key, value in values.items()) + "\n")
    for name, working, command, extra in (
        (SERVICES[0], checkout, f"{unit_quote(node)} {unit_quote(checkout / 'packages/backend/dist/server.js')}",
         f"EnvironmentFile={str(CONFIG / 'dave.env').replace('%', '%%')}\n"),
        (SERVICES[1], ROOT, f"{unit_quote(sys.executable)} -m sm_manager --config {unit_quote(CONFIG / 'monitor.json')} serve", ""),
    ):
        write(UNITS / name, f'''{MARKER}
[Unit]
Description=ST DAVe branch preview ({name})
After=network.target

[Service]
WorkingDirectory={str(working).replace('%', '%%')}
ExecStart={command}
{extra}Environment={unit_quote('PATH=' + os.environ.get('PATH', '/usr/bin:/bin'))}
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
''')
    write(profile_path, json.dumps({"source": str(ROOT), "host": host, "port": args.port,
                                   "target": target, "url": url}, indent=2) + "\n")
    run("systemctl", "--user", "daemon-reload")
    run("systemctl", "--user", "enable", "--now", *SERVICES)
    wait_ready(args.port)
    run(tailscale, "serve", "--bg", f"--https={args.port}", target)
    print(url)


if __name__ == "__main__":
    main()
