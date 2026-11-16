"""Device-scoped requests shared by the Codex worker and assistant tools."""

import json
import os
import socket
import subprocess
from pathlib import Path


def rpc(msg, device=None):
    device = device or os.environ.get("STAPP_DEVICE", "owner")
    payload = (json.dumps(dict(msg, device=device)) + "\n").encode()
    host = os.environ.get("STAPP_SSH")
    if host:
        if host.startswith("-"):
            raise ValueError("Expected an SSH host alias")
        response = subprocess.run(
            [
                "ssh",
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=5",
                host,
                "stctl",
                "bridge",
            ],
            input=payload,
            capture_output=True,
            check=True,
            timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout
    else:
        data = Path(os.environ.get("STAPP_DATA", Path.home() / ".local/share/stapp"))
        with socket.socket(socket.AF_UNIX) as sock:
            sock.settimeout(20)
            sock.connect(os.environ.get("STAPP_SOCKET", str(data / "control.sock")))
            sock.sendall(payload)
            with sock.makefile("rb") as stream:
                response = stream.readline(8 * 1024 * 1024)
    parsed = json.loads(response)
    if "error" in parsed:
        raise ValueError(parsed["error"])
    return parsed["result"]


class DeviceInbox:
    """Reuse one authenticated SSH connection while a device waits for deliveries."""

    def __init__(self):
        self.host = os.getenv("STAPP_SSH")
        self.child = None

    def fetch(self, after):
        if not self.host:
            return rpc({"op": "inbox", "after": after})
        if self.host.startswith("-"):
            raise ValueError("Invalid SSH alias")
        if self.child is None:
            self.child = subprocess.Popen(
                [
                    "ssh",
                    "-T",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ConnectTimeout=5",
                    "-o",
                    "ServerAliveInterval=5",
                    "-o",
                    "ServerAliveCountMax=2",
                    self.host,
                    "stctl",
                    "bridge",
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        try:
            self.child.stdin.write(
                (json.dumps({"op": "inbox", "after": after}) + "\n").encode()
            )
            self.child.stdin.flush()
            return json.loads(self.child.stdout.readline(8 * 1024 * 1024))["result"]
        except (OSError, ValueError, KeyError):
            self.child.kill()
            self.child.wait()
            self.child.stdin.close()
            self.child.stdout.close()
            self.child = None
            raise OSError("Inbox disconnected")
