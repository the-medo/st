# Artifact library and sharing

The console's `/artifacts` page uses the owner-authenticated Python backend.
Its SQLite catalog and immutable content files live outside checkouts. The
`scripts/artifacts.py` CLI creates working copies with `.artifact.json`, and
checks the base revision on save so two agents cannot overwrite one another.
Moving an artifact or removing a project checkout does not change its identity.

Private previews use signed URLs scoped to one revision’s output, valid for at
most one hour and invalidated by a monitor restart. This lets sandboxed frames
load relative assets without owner cookies. Source files and library actions
remain owner-only; preview capabilities cannot access them.

The public Worker binds the private `artifacts` R2 bucket. It receives only
explicitly published output, never the editable source files. Uploads write
content-addressed objects before changing the share manifest. Every public
request checks the share manifest, including nested assets. The bucket must
have neither r2.dev public access nor a direct bucket custom domain enabled.
The custom domain belongs to the Worker.

If a network response is lost, the library marks the sharing status unconfirmed
and keeps the same link available to retry or revoke. Publication is serialized
per artifact; draft saves and other artifacts remain available during uploads.

The gallery follows the document-card pattern used by artifact libraries:
preview first, then title, project and sharing state. The agent handoff adds a
draft to a chosen open conversation and never sends it automatically or
replaces an existing draft. Copy instructions also works with other agents.

## Install

From `sm-manager`, run `bun install --frozen-lockfile` and `bun run build`, then
`bun node_modules/playwright-core/cli.js install chromium` if Chromium is not
already installed. Run `python3 scripts/install-artifacts.py --publish-url
https://your-publishing-domain.example`. This installs the CLI and a discoverable
Codex skill independently of the checkout, along with private configuration and
a generated publisher credential. Re-run after changes to update the runtime.
The installer copies the compiled Excalidraw renderer and Playwright runtime
outside the checkout. It records the Bun executable; pass `--bun /path/to/bun`
if it is not on PATH. Chromium is discovered in the user's Playwright cache or
through `BROWSER_EXECUTABLE`. Rendering launches a browser only for that command;
no additional service or MCP configuration is needed.
The console reads that configuration by default; set `artifacts_config_path` in
its private profile to choose another library. For automated tests and synthetic preview screenshots, always use an isolated
data directory and credential. An owner preview may point to the installed
library when manually reviewing the actual integration.

Deploy `services/artifact-publisher/worker.ts` with its R2 binding and the
`PUBLISH_KEY` secret from the generated `publish_key_file`. Assign a dedicated
custom domain to this Worker. Keep the credential outside Git and never put it
in browser configuration. `wrangler.jsonc` is the source configuration; domain
and account choices belong in deployment configuration.

No changes to a paid subscription are required. Storage and request charges
follow the account's R2 and Workers plans. This implementation permits 256 files
and 32 MiB per revision. It uploads files separately to avoid base64 overhead
in the Worker. Imported local bundles must include their dependencies; remote
scripts, fonts and network requests are blocked in HTML previews and shares.

## Excalidraw drawings

`herdr-artifacts diagram scene.json --title 'System diagram'` accepts native
Excalidraw JSON or compact SDK element skeletons. The revision contains a private
`source/diagram.excalidraw` and public-ready `diagram.svg` / `diagram.png`.
Check out the artifact, edit the native source, and use `save` to regenerate both
outputs under the same ID. Native IDs and bindings are preserved. Source content
is not embedded in exports. Publishing still requires an explicit action.

The browser's New diagram / Edit diagram uses the same normalization and export
code. Saving a stale browser revision leaves the drawing open with an original
download for recovery. Extra attached files are retained. Restore preserves the
editor type of the chosen revision. Imported images must be embedded data URLs;
webpage embeds are not supported. Each complete revision retains the 32 MiB
limit. Excalidraw 0.18.1 is pinned; its local font fallback transformation in
`frontend/excalidraw-assets.ts` must be reviewed when upgrading the SDK.

## Verify

```sh
python3 -m unittest discover -s tests -p test_artifacts.py -v
bun test services/artifact-publisher
bun run typecheck
bun run build
bun run test:artifacts-browser
```

Browser tests use synthetic data and isolated local services. Public smoke
tests should use synthetic output, check that private source cannot be fetched,
update the published revision under the same URL, revoke access, and verify
both the entrypoint and its assets become unavailable. Revocation affects
future requests; it cannot erase copies a recipient already saved.

Back up the local catalog using SQLite's backup API together with the immutable
objects. Keep the live database on local storage. NAS backups are optional and
are configured separately. Content-addressed objects currently retain old
versions; automatic garbage collection is deliberately absent until retention
rules are chosen. The source files and catalog remain the complete local
record; R2 is the publishing destination.
