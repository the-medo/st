"""Publish PNG frames from the dedicated faceplate output; run in its Wayland session."""
import argparse
import os
import subprocess
import time
import urllib.request
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument("--output",required=True,help="The dedicated kiosk output on the panel host")
parser.add_argument("--server",required=True,help="Private HTTPS STapp origin")
parser.add_argument("--key-file",required=True)
args=parser.parse_args()
if not args.server.startswith("https://"):parser.error("Expected a private HTTPS URL")
token=Path(args.key_file).read_text().strip()
while True:
    try:
        data=subprocess.check_output(["grim","-o",args.output,"-"],timeout=5)
        request=urllib.request.Request(args.server.rstrip('/')+"/api/frame",data=data,headers={"Authorization":"Bearer "+token,"Content-Type":"image/png"})
        with urllib.request.urlopen(request,timeout=5):pass
    except (OSError,subprocess.SubprocessError) as exc:
        print("Frame unavailable:",type(exc).__name__,flush=True)
    time.sleep(2)
