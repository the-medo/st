#!/usr/bin/env python3
"""Save, find, revise, export and publish Herdr artifacts from any project."""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import shutil

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sm_manager.artifacts import ArtifactError, Library, MAX_BYTES, MAX_FILES, read_settings, safe_path
from sm_manager.artifact_context import conversation_id


def render_diagram(path, settings):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise ArtifactError("Choose a regular Excalidraw/JSON file up to 32 MiB.")
    command = settings.get("diagram_renderer") or [shutil.which("bun") or "bun", str(Path(__file__).resolve().with_name("render-excalidraw.ts"))]
    if not isinstance(command, list) or not command or not all(isinstance(arg, str) for arg in command):
        raise ArtifactError("The diagram renderer is not configured correctly.")
    try:
        result = subprocess.run(command, input=path.read_bytes(), capture_output=True, timeout=90)
    except subprocess.TimeoutExpired:
        raise ArtifactError("Diagram rendering timed out. The saved artifact is unchanged.") from None
    if result.returncode:
        message = result.stderr.decode(errors="replace")[-2000:]
        try:
            message = json.loads(message)["error"]
        except (ValueError, KeyError, TypeError):
            pass
        raise ArtifactError("Could not render the diagram: " + message)
    return json.loads(result.stdout)


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


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("projects", help="List the same project IDs, names and appearance as Agents")
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
    create.add_argument("--folder", help=argparse.SUPPRESS)  # Older skill copies: accepted but no longer used.
    create.add_argument("--conversation", default=os.environ.get("CODEX_THREAD_ID", ""), help="Creating conversation UUID (defaults to the current agent thread)")
    create.add_argument("--bundle", type=Path, help="Explicit output directory containing the entrypoint and assets")
    create.add_argument("--source", type=Path, action="append", default=[], help="Editable source kept private when sharing")
    diagram = commands.add_parser("diagram", help="Create an editable diagram from native .excalidraw or compact JSON; render SVG/PNG locally")
    diagram.add_argument("file", type=Path)
    diagram.add_argument("--title", required=True)
    diagram.add_argument("--project")
    diagram.add_argument("--folder", help=argparse.SUPPRESS)
    diagram.add_argument("--conversation", default=os.environ.get("CODEX_THREAD_ID", ""), help="Creating conversation UUID (defaults to the current agent thread)")
    save = commands.add_parser("save", help="Save a checked-out directory as the next revision of the same artifact")
    save.add_argument("directory", type=Path)
    save.add_argument("--note", default="")
    publish = commands.add_parser("publish", help="Explicitly publish the specified current revision")
    publish.add_argument("id")
    publish.add_argument("--revision", type=int, required=True)
    unpublish = commands.add_parser("unpublish", help="Revoke future access through the share link")
    unpublish.add_argument("id")
    origin = commands.add_parser("link-origin", help="Attach a verified creating conversation to an older artifact without an origin")
    origin.add_argument("id")
    origin.add_argument("--conversation", required=True)
    args = parser.parse_args(argv)
    try:
        library = Library(read_settings(args.config))
        if args.command == "projects":
            if library.projects.error:
                raise ArtifactError(library.projects.error)
            result = library.projects.items
        elif args.command == "list":
            result = library.list(args.query)
        elif args.command == "get":
            result = library.get(args.id)
        elif args.command == "checkout":
            result = library.checkout(args.id)
        elif args.command == "diagram":
            thread = conversation_id(args.conversation)
            bundle = render_diagram(args.file.expanduser(), library.settings)
            result = library.save({**bundle, "title": args.title, "project": library.projects.infer(Path.cwd(), thread) if args.project is None else args.project, "source_chat": thread})
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
            thread = conversation_id(args.conversation)
            result = library.save({"title": args.title, "project": library.projects.infer(Path.cwd(), thread) if args.project is None else args.project, "source_chat": thread, "entrypoint": entrypoint, "files": files})
        elif args.command == "save":
            directory = args.directory.expanduser().resolve()
            metadata = json.loads((directory / ".artifact.json").read_text())
            roles = {f["path"]: f["role"] for f in metadata["files"]}
            rendered = None
            if (metadata.get("editor") or {}).get("type") == "excalidraw":
                # Render before changing any stored revision or working exports. A
                # failed render and a stale base revision both leave history intact.
                source = directory / safe_path(metadata["editor"]["source"])
                rendered = render_diagram(source, library.settings)
            files = collect(directory)
            for file in files:
                file["role"] = roles.get(file["path"], "source" if file["path"].startswith("source/") else "output")
            if rendered:
                paths = {f["path"] for f in rendered["files"]}
                paths.add(metadata["editor"]["source"])
                files = [f for f in files if f["path"] not in paths] + rendered["files"]
            result = library.save({"base_revision": metadata["base_revision"], "entrypoint": rendered["entrypoint"] if rendered else metadata["entrypoint"], "editor": rendered["editor"] if rendered else metadata.get("editor"), "files": files, "note": args.note}, metadata["id"])
            if rendered:
                for file in rendered["files"]:
                    target = directory / file["path"]
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(base64.b64decode(file["base64"]))
                metadata.update(entrypoint=rendered["entrypoint"], editor=rendered["editor"])
            metadata["base_revision"] = result["revision"]
            metadata["files"] = [{"path": f["path"], "role": f["role"]} for f in files]
            (directory / ".artifact.json").write_text(json.dumps(metadata, indent=2))
        elif args.command == "publish":
            result = library.publish(args.id, args.revision)
        elif args.command == "link-origin":
            result = library.link_origin(args.id, args.conversation)
        else:
            result = library.unpublish(args.id)
        print(json.dumps(result, indent=2))
        return 0
    except (ArtifactError, OSError, ValueError, KeyError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
