"""Supervise the native listener, handle device-specific deliveries, and expose Windows tray controls."""
import json
import os
import subprocess
import sys
import threading
import time
import tempfile
from pathlib import Path
from transport import rpc

state=Path(os.environ["STAPP_CLIENT_STATE"]);state.mkdir(parents=True,exist_ok=True)
muted=state/"muted";speaking=state/"speaking";speaking.unlink(missing_ok=True)
stopping=threading.Event()
child=None
icon=None
pending={}
def listen():
    global child
    while not stopping.is_set():
        try:
            if not muted.exists():
                child=subprocess.Popen([os.environ["STAPP_VOICE_BIN"]])
                child.wait()
        except OSError as exc: print(type(exc).__name__,file=sys.stderr)
        stopping.wait(2)
def say(text):
    target=os.getenv("STAPP_SPEAKER_NODE")
    voice=os.getenv("STAPP_PIPER_MODEL")
    if not target or not voice:return
    speaking.touch()
    try:
        with tempfile.TemporaryDirectory() as temp:
            wav=Path(temp)/"reply.wav"
            subprocess.run([sys.executable,"-m","piper","-m",voice,"-f",str(wav)],input=text.encode(),check=True,timeout=45)
            subprocess.run(["pw-play","--target",target,str(wav)],check=True,timeout=60)
    finally:speaking.unlink(missing_ok=True)
def deliveries():
    cursor=state/"cursor"
    after=int(cursor.read_text()) if cursor.exists() else 0
    while not stopping.is_set():
        try:
            for e in rpc({"op":"inbox","after":after}):
                if e["kind"]=="question":pending[e["id"]]=e["text"]
                elif e["kind"] in ("completed","failed","interrupted"):pending.pop(e["id"],None)
                if icon:icon.notify(e["text"][:240],"S.T.")
                elif os.environ["STAPP_DEVICE"]=="room":
                    try:say(e["text"][:450])
                    except (OSError,subprocess.SubprocessError):pass # Panel delivery is independent.
                after=e["seq"];tmp=cursor.with_suffix(".new");tmp.write_text(str(after));tmp.replace(cursor)
        except (OSError,ValueError,subprocess.SubprocessError):pass
        stopping.wait(1.5)
def main():
    global icon
    if os.name=="nt":
        import pystray
        from PIL import Image,ImageDraw
        image=Image.new("RGB",(64,64),"#18392a");ImageDraw.Draw(image).text((12,18),"S.T.",fill="white",font_size=22)
        def toggle(*_):
            if muted.exists():muted.unlink()
            else:
                muted.touch()
                if child and child.poll() is None:child.terminate()
        def answer(*_):
            from tkinter import simpledialog,Tk
            root=Tk();root.withdraw()
            try:
                for job,question in list(pending.items()):
                    response=simpledialog.askstring("S.T.",question,parent=root)
                    if response is not None:
                        rpc({"op":"answer","id":job,"text":response});pending.pop(job,None)
            finally:root.destroy()
        def quit_(*_):
            stopping.set()
            if child and child.poll() is None:child.terminate()
            icon.stop()
        icon=pystray.Icon("STapp",image,"S.T.",pystray.Menu(pystray.MenuItem("Mute microphone",toggle,checked=lambda _:muted.exists()),pystray.MenuItem("Answer pending question",answer),pystray.MenuItem("Quit",quit_)))
    threading.Thread(target=listen,daemon=True).start()
    threading.Thread(target=deliveries,daemon=True).start()
    if icon:icon.run()
    else:stopping.wait()
if __name__=="__main__":main()
