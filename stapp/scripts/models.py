"""Install checksum-pinned local wake and Whisper models."""

import hashlib
import os
import sys
import tarfile
import urllib.request
from pathlib import Path

MODELS = [
    (
        "kws-models",
        "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01",
        "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a",
    ),
    (
        "asr-models",
        "sherpa-onnx-whisper-base",
        "911b2083efd7c0dca2ac3b358b75222660dc09fb716d64fbfc417ba6c99ff3de",
    ),
]


def install(root):
    root.mkdir(parents=True, exist_ok=True)
    for tag, name, digest in MODELS:
        file = root / (name + ".tar.bz2")
        if not file.exists():
            urllib.request.urlretrieve(
                f"https://github.com/k2-fsa/sherpa-onnx/releases/download/{tag}/{name}.tar.bz2",
                file,
            )
        with file.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != digest:
                file.unlink()
                raise RuntimeError("Model checksum mismatch: " + name)
        with tarfile.open(file) as archive:
            archive.extractall(root, filter="data")


if __name__ == "__main__":
    install(Path(sys.argv[1]))
