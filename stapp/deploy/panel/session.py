"""Keep Chromium, the private API relay and physical capture alive in the panel session."""

import json
import signal
import subprocess
import sys
import time
from pathlib import Path

base = Path(__file__).resolve().parent
cfg = json.loads((Path.home() / ".config/stapp/panel.json").read_text())
commands = [
    [sys.executable, str(base / "proxy.py")],
    [
        sys.executable,
        str(base / "capture.py"),
        "--server",
        cfg["server"],
        "--output",
        cfg["output"],
        "--key-file",
        cfg["key_file"],
    ],
    [
        "chromium",
        "--kiosk",
        "--no-first-run",
        "--noerrdialogs",
        "--disable-session-crashed-bubble",
        "--user-data-dir=" + str(Path.home() / ".local/share/stapp-panel/browser"),
        "--app=http://127.0.0.1:18642/",
    ],
]
processes = {}
stopping = False


def stop(*_):
    global stopping
    stopping = True


for sig in (signal.SIGTERM, signal.SIGINT):
    signal.signal(sig, stop)
try:
    while not stopping:
        for index, command in enumerate(commands):
            if index not in processes or processes[index].poll() is not None:
                processes[index] = subprocess.Popen(command)
        time.sleep(2)
finally:
    for child in processes.values():
        if child.poll() is None:
            child.terminate()
