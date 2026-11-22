#!/usr/bin/env python3
"""Private Immich deployment. Never removes library files or Docker volumes."""

import argparse
import gzip
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = Path.home() / ".local/share/stapp-immich"
CONFIG = Path.home() / ".config/stapp/immich-deployment.json"
NETWORK_FS = {"cifs", "nfs", "nfs4"}


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def docker():
    return shutil.which("docker") or str(Path.home() / ".local/bin/docker")


def compose(*args, **kwargs):
    return subprocess.run([docker(), "compose", "--project-directory", str(ROOT),
                           "-f", str(ROOT / "compose.yml"), *args], check=True, **kwargs)


def private_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("w") as handle:
        os.chmod(path, 0o600)
        json.dump(value, handle, indent=2)


def filesystem(path):
    # Touch the path first to activate an existing systemd automount.
    path.stat()
    mounts = json.loads(run("findmnt", "-J", "-T", str(path), "-o", "TARGET,SOURCE,FSTYPE"))["filesystems"]
    return next(m for m in reversed(mounts) if m["fstype"] != "autofs")


def check_storage(config):
    mount = filesystem(Path(config["mount"]))
    if mount["fstype"] not in NETWORK_FS or mount["source"] != config["source"]:
        raise RuntimeError("Expected NAS share is not mounted; refusing local fallback")
    library = Path(config["library"])
    if filesystem(library)["source"] != config["source"]:
        raise RuntimeError("Photo library is not on the configured NAS share")
    if filesystem(ROOT)["fstype"] in NETWORK_FS:
        raise RuntimeError("PostgreSQL must be on local storage")


def write_units():
    units = Path.home() / ".config/systemd/user"
    units.mkdir(parents=True, exist_ok=True)
    (units / "stapp-immich.service").write_text(f"""[Unit]
Description=S.T. Immich photo backend
After=network-online.target
StartLimitIntervalSec=0

[Service]
Environment=PATH={Path.home()}/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/python3 {ROOT}/manage.py run
ExecStop=/usr/bin/python3 {ROOT}/manage.py stop-containers
Restart=always
RestartSec=30
TimeoutStopSec=120
UMask=0077

[Install]
WantedBy=default.target
""")
    (units / "stapp-immich-backup.service").write_text(f"""[Unit]
Description=Immich database backup to the Steam Machine SSD
After=stapp-immich.service

[Service]
Type=oneshot
Environment=PATH={Path.home()}/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/python3 {ROOT}/manage.py backup
UMask=0077
""")
    (units / "stapp-immich-backup.timer").write_text("""[Unit]
Description=Daily Immich database backup

[Timer]
OnCalendar=*-*-* 03:15:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
""")


def install(args):
    if CONFIG.exists():
        raise RuntimeError("Already configured; use start/status. Upgrade explicitly after a backup.")
    mount_path = Path(args.mount).resolve(strict=True)
    mount = filesystem(mount_path)
    if mount["fstype"] not in NETWORK_FS:
        raise RuntimeError("--mount must be an existing NAS mount")
    library = mount_path / "immich"
    if library.exists():
        raise RuntimeError("The immich directory already exists; refusing to adopt unknown data")
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    if filesystem(ROOT)["fstype"] in NETWORK_FS:
        raise RuntimeError("Deployment and PostgreSQL need local storage")
    ts = json.loads(run("tailscale", "status", "--json"))
    dns = ts["Self"]["DNSName"].rstrip(".")
    serve = json.loads(run("tailscale", "serve", "status", "--json"))
    if str(args.port) in serve.get("TCP", {}):
        raise RuntimeError("Tailscale port already belongs to another service")
    import socket
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", args.port))
    library.mkdir(mode=0o700)
    (ROOT / "postgres").mkdir(mode=0o700)
    shutil.copy2(Path(__file__).with_name("compose.yml"), ROOT / "compose.yml")
    shutil.copy2(__file__, ROOT / "manage.py")
    environment = ROOT / ".env"
    environment.write_text(
        f"UPLOAD_LOCATION={library}\nDB_DATA_LOCATION={ROOT}/postgres\n"
        f"IMMICH_VERSION=v3.4.2\nST_IMMICH_PORT={args.port}\nTZ=Europe/Budapest\n"
        f"DB_PASSWORD={secrets.token_hex(32)}\nDB_USERNAME=postgres\nDB_DATABASE_NAME=immich\n"
    )
    environment.chmod(0o600)
    config = {"version": "v3.4.2", "mount": str(mount_path), "source": mount["source"],
              "library": str(library), "port": args.port, "url": f"https://{dns}:{args.port}"}
    private_json(CONFIG, config)
    check_storage(config)
    write_units()
    compose("pull")
    run("systemctl", "--user", "daemon-reload")
    run("systemctl", "--user", "enable", "--now", "stapp-immich.service")
    run("systemctl", "--user", "enable", "--now", "stapp-immich-backup.timer")
    # Publish only the dedicated private HTTPS port; preserve all existing routes.
    run("tailscale", "serve", "--bg", f"--https={args.port}", f"http://127.0.0.1:{args.port}")
    print(json.dumps(config, indent=2))


def backup(config):
    check_storage(config)
    folder = ROOT / "database-backups"
    folder.mkdir(mode=0o700, exist_ok=True)
    destination = folder / (time.strftime("immich-%Y%m%d-%H%M%S") + ".sql.gz")
    temporary = destination.with_suffix(".partial")
    command = [docker(), "compose", "--project-directory", str(ROOT), "-f", str(ROOT / "compose.yml"),
               "exec", "-T", "database", "pg_dumpall", "--clean", "--if-exists", "--username=postgres"]
    try:
        with subprocess.Popen(command, stdout=subprocess.PIPE) as process:
            with gzip.open(temporary, "wb") as output:
                shutil.copyfileobj(process.stdout, output)
            if process.wait() != 0:
                raise RuntimeError("Database backup failed")
        temporary.chmod(0o600)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    print(destination)
    for old in sorted(folder.glob("immich-*.sql.gz"))[:-14]:
        old.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    init = sub.add_parser("install")
    init.add_argument("--mount", required=True)
    init.add_argument("--port", type=int, default=2283)
    for action in ["run", "start", "stop", "stop-containers", "status", "backup", "refresh-runtime"]:
        sub.add_parser(action)
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == "install":
        install(args)
        return
    config = json.loads(CONFIG.read_text())
    if args.action == "refresh-runtime":
        if Path(__file__).resolve().parent == ROOT.resolve():
            raise RuntimeError("Run refresh-runtime from the reviewed source checkout")
        shutil.copy2(__file__, ROOT / "manage.py")
        write_units()
        run("systemctl", "--user", "daemon-reload")
        run("systemctl", "--user", "enable", "--now", "stapp-immich-backup.timer")
        print("Runtime supervisor refreshed; container images and data unchanged")
    elif args.action == "run":
        check_storage(config)
        compose("up", "--abort-on-container-failure", "--remove-orphans")
    elif args.action == "start":
        check_storage(config)
        run("systemctl", "--user", "start", "stapp-immich.service")
    elif args.action == "stop":
        run("systemctl", "--user", "stop", "stapp-immich.service")
    elif args.action == "stop-containers":
        compose("stop", "--timeout", "60")
    elif args.action == "backup":
        backup(config)
    else:
        print(json.dumps(config, indent=2))
        compose("ps")
        with urllib.request.urlopen(f"http://127.0.0.1:{config['port']}/api/server/ping", timeout=5) as r:
            print(r.read().decode())


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.exit(str(error))
