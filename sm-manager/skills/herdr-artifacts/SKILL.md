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

Projects are the existing Agents projects. The CLI infers the registered project
from the creating conversation or repository, including linked worktrees; an
unmatched location stays unassigned. Use `herdr-artifacts projects` to see IDs
and names, then `--project PROJECT_ID` or `--project ''` to override the choice.
Do not invent project names or artifact folders. Artifacts are organized only by
project. A bundle must be a dedicated output directory. Include the HTML's
local images, styles and scripts; do not upload an entire repository. Previews
and shared pages block external scripts and network access, so bundle needed
dependencies. Source files are retained privately and excluded from publishing.

Creation records `CODEX_THREAD_ID` as the original conversation automatically.
When that environment variable is unavailable, supply `--conversation THREAD_UUID`
if the creating conversation's ID is known. Do not guess a conversation from its
title or use a terminal ID. Artifacts created directly in the browser can have no
conversation. Edits preserve the original conversation, even from another chat.

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
