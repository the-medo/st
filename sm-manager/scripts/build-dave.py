#!/usr/bin/env python3
"""Build the pinned, patched DAVe subapp; keep dependencies and secrets out of ST."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
INTEGRATION = ROOT / "integrations/dave"


def run(*args, cwd=None, capture=False, env=None):
    return subprocess.check_output(args, cwd=cwd, env=env) if capture else subprocess.run(args, cwd=cwd, env=env, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", required=True, type=Path, help="Dedicated DAVe checkout (created if absent)")
    parser.add_argument("--source-archive", required=True, type=Path, help="Private output for the source download")
    args = parser.parse_args()
    checkout = args.checkout.expanduser().resolve()
    archive = args.source_archive.expanduser().resolve()
    upstream = json.loads((INTEGRATION / "upstream.json").read_text())
    patch = (INTEGRATION / "st.patch").read_bytes()
    if not checkout.exists():
        run("git", "clone", upstream["repository"], str(checkout))
        run("git", "checkout", "--detach", upstream["revision"], cwd=checkout)
    actual = run("git", "rev-parse", "HEAD", cwd=checkout, capture=True).decode().strip()
    if actual != upstream["revision"]:
        raise SystemExit("Checkout is at another revision; use a fresh destination.")
    changes = run("git", "diff", "--binary", "HEAD", cwd=checkout, capture=True)
    if changes and changes != patch:
        raise SystemExit("Checkout has edits other than the recorded ST patch; preserve them before rebuilding.")
    if not changes:
        run("git", "apply", "--index", str(INTEGRATION / "st.patch"), cwd=checkout)
    env = {**os.environ, "VITE_ST_INTEGRATION": "1"}
    run("npm", "ci", "--no-audit", "--no-fund", cwd=checkout)
    run("npm", "run", "build", cwd=checkout, env=env)
    # The archive contains exact source + license + lockfile, not runtime config,
    # credentials, caches, node_modules, or Git internals.
    files = run("git", "ls-files", "-z", cwd=checkout, capture=True).decode().split("\0")
    archive.parent.mkdir(parents=True, exist_ok=True)
    temporary = archive.with_suffix(".tmp")
    with tarfile.open(temporary, "w:gz") as bundle:
        for name in filter(None, files):
            path = checkout / name
            if path.is_symlink() or not path.is_file():
                raise SystemExit(f"Unexpected source file: {name}")
            bundle.add(path, arcname="dave/" + name)
    temporary.replace(archive)
    print(f"DAVe {upstream['version']} built at {checkout}")
    print(f"Matching source archive: {archive}")


if __name__ == "__main__":
    main()
