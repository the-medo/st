#!/usr/bin/env python3
"""Save, find, revise, export and publish Herdr artifacts from any project."""
import argparse
import base64
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sm_manager.artifacts import ArtifactError, Library, MAX_BYTES, MAX_FILES, read_settings, safe_path


def file_entry(path, name, role="output"):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise ArtifactError("Choose regular files up to 32 MiB; symlinks are not imported.")
    return {"path": safe_path(name), "role": role, "base64": base64.b64encode(path.read_bytes()).decode()}


def collect(folder):
    files = []
    total = 0
    for path in sorted(folder.rglob("*")):
        if path.is_symlink():
            raise ArtifactError("Remove symlinks before importing an artifact bundle.")
        relative = path.relative_to(folder)
        if any(part.startswith(".") or part in ("node_modules", "__pycache__") for part in relative.parts):
            continue
        if path.is_file():
            if len(files) >= MAX_FILES:
                raise ArtifactError("The bundle contains too many files. Use a dedicated output folder.")
            total += path.stat().st_size
            if total > MAX_BYTES:
                raise ArtifactError("An artifact revision can contain up to 32 MiB.")
            files.append(file_entry(path, relative.as_posix()))
    return files


def project_name():
    try:
        common = subprocess.check_output(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], stderr=subprocess.DEVNULL, text=True, timeout=3).strip()
        return Path(common).parent.name
    except (OSError, subprocess.SubprocessError):
        return ""


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path)
    commands = parser.add_subparsers(dest="command", required=True)
    find = commands.add_parser("list", help="Find artifacts across all projects")
    find.add_argument("query", nargs="?", default="")
    get = commands.add_parser("get", help="Read metadata and revision history")
    get.add_argument("id")
    checkout = commands.add_parser("checkout", help="Create an editable copy with the identity and base revision preserved")
    checkout.add_argument("id")
    create = commands.add_parser("create", help="Import a finished output or dedicated HTML bundle")
    create.add_argument("file", type=Path)
    create.add_argument("--title", required=True)
    create.add_argument("--project")
    create.add_argument("--folder", default="")
    create.add_argument("--bundle", type=Path, help="Explicit output directory containing the entrypoint and assets")
    create.add_argument("--source", type=Path, action="append", default=[], help="Editable source kept private when sharing")
    save = commands.add_parser("save", help="Save a checked-out directory as the next revision of the same artifact")
    save.add_argument("directory", type=Path)
    save.add_argument("--note", default="")
    publish = commands.add_parser("publish", help="Explicitly publish the specified current revision")
    publish.add_argument("id")
    publish.add_argument("--revision", type=int, required=True)
    unpublish = commands.add_parser("unpublish", help="Revoke future access through the share link")
    unpublish.add_argument("id")
    args = parser.parse_args(argv)
    try:
        library = Library(read_settings(args.config))
        if args.command == "list":
            result = library.list(args.query)
        elif args.command == "get":
            result = library.get(args.id)
        elif args.command == "checkout":
            result = library.checkout(args.id)
        elif args.command == "create":
            path = args.file.expanduser().absolute()
            if args.bundle:
                root = args.bundle.expanduser().resolve()
                if not path.resolve().is_relative_to(root):
                    raise ArtifactError("The entrypoint must be inside the bundle.")
                files = collect(root)
                entrypoint = path.relative_to(root).as_posix()
            else:
                entrypoint = path.name
                files = [file_entry(path, entrypoint)]
            total = sum(len(f["base64"]) * 3 // 4 - f["base64"].count("=") for f in files)
            if len(files) + len(args.source) > MAX_FILES:
                raise ArtifactError("Choose up to 256 files including editable source.")
            for source in args.source:
                source = source.expanduser()
                total += source.stat().st_size
                if total > MAX_BYTES:
                    raise ArtifactError("An artifact revision can contain up to 32 MiB.")
                files.append(file_entry(source, "source/" + source.name, "source"))
            result = library.save({"title": args.title, "project": project_name() if args.project is None else args.project, "folder": args.folder, "entrypoint": entrypoint, "files": files})
        elif args.command == "save":
            directory = args.directory.expanduser().resolve()
            metadata = json.loads((directory / ".artifact.json").read_text())
            roles = {f["path"]: f["role"] for f in metadata["files"]}
            files = collect(directory)
            for file in files:
                file["role"] = roles.get(file["path"], "source" if file["path"].startswith("source/") else "output")
            result = library.save({"base_revision": metadata["base_revision"], "entrypoint": metadata["entrypoint"], "files": files, "note": args.note}, metadata["id"])
            metadata["base_revision"] = result["revision"]
            metadata["files"] = [{"path": f["path"], "role": f["role"]} for f in files]
            (directory / ".artifact.json").write_text(json.dumps(metadata, indent=2))
        elif args.command == "publish":
            result = library.publish(args.id, args.revision)
        else:
            result = library.unpublish(args.id)
        print(json.dumps(result, indent=2))
        return 0
    except (ArtifactError, OSError, ValueError, KeyError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
