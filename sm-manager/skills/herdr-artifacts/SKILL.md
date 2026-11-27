---
name: herdr-artifacts
description: Create editable Excalidraw diagrams and save standalone HTML, reports, PDFs, images, and other requested deliverables to the user's global Herdr artifact library; find, revise, or share existing artifacts across projects. Do not use for ordinary application source files, temporary test output, or documents the user explicitly wants only in a repository.
---

# Herdr artifacts

<!-- Managed by ST install-artifacts.py -->

Use `~/.local/bin/herdr-artifacts`. Run `--help` for options. It uses the private
configuration at `~/.config/herdr-artifacts/config.json` (or
`HERDR_ARTIFACTS_CONFIG`), independently of the current project.

When creating a standalone deliverable the user wants to keep, save the finished
output in the library and return its artifact ID and the library link. Keep the
editable source too when the output is generated from another format.

For editable Excalidraw diagrams, read [references/excalidraw.md](references/excalidraw.md).
The `diagram` command accepts JSON and renders SVG/PNG locally without MCP.
Existing diagram working copies use the same `save` command below; it regenerates
their previews from the native source.

```sh
~/.local/bin/herdr-artifacts create /path/to/diagram.html --title 'System diagram'
~/.local/bin/herdr-artifacts create /path/to/output/index.html --bundle /path/to/output --title 'Report'
~/.local/bin/herdr-artifacts create /path/to/report.pdf --title 'Report' --source /path/to/report.md
```

The CLI infers the project from the Git repository, including linked worktrees.
Use `--project NAME` or `--project ''` to override it, and `--folder NAME` to
organize it. A bundle must be a dedicated output directory. Include the HTML's
local images, styles and scripts; do not upload an entire repository. Previews
and shared pages block external scripts and network access, so bundle needed
dependencies. Source files are retained privately and excluded from publishing.

To improve an existing artifact, use its attached ID. If no ID is attached,
search with `herdr-artifacts list 'words'` and select the intended result. Do not
guess when several results match.

```sh
~/.local/bin/herdr-artifacts get ARTIFACT_ID
~/.local/bin/herdr-artifacts checkout ARTIFACT_ID
~/.local/bin/herdr-artifacts save /returned/working/directory --note 'Describe the change'
```

Edit the returned working copy and preserve `.artifact.json`; it records the
artifact's identity and starting revision. `save` updates that same artifact.
On a revision conflict, retrieve the latest revision and reconcile the changes;
do not create a replacement artifact or force an overwrite. A deliberate new
variant uses `create` with a distinct title.

Saving is private. Publish only when the user asks to share or update the shared
version. Publishing again preserves the share link; unpublished edits do not
change what its recipients see.

```sh
~/.local/bin/herdr-artifacts publish ARTIFACT_ID --revision CURRENT_REVISION
~/.local/bin/herdr-artifacts unpublish ARTIFACT_ID
```

Do not read or include the publisher credential in messages or artifacts. If
sharing fails, the private saved revision remains available. Report the failure
and its artifact ID rather than repeatedly creating copies.
