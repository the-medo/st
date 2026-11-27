# Artifact library and sharing

The console's `/artifacts` page uses the owner-authenticated Python backend.
Its SQLite catalog and immutable content files live outside checkouts. The
`scripts/artifacts.py` CLI creates working copies with `.artifact.json`, and
checks the base revision on save so two agents cannot overwrite one another.
Moving an artifact or removing a project checkout does not change its identity.

The public Worker binds the private `artifacts` R2 bucket. It receives only
explicitly published output, never the editable source files. Uploads write
content-addressed objects before changing the share manifest. Every public
request checks the share manifest, including nested assets. The bucket must
have neither r2.dev public access nor a direct bucket custom domain enabled.
The custom domain belongs to the Worker.

The gallery follows the document-card pattern used by artifact libraries:
preview first, then title, project and sharing state. The agent handoff adds a
draft to a chosen open conversation and never sends it automatically or
replaces an existing draft. Copy instructions also works with other agents.

## Install

From `sm-manager`, run `python3 scripts/install-artifacts.py --publish-url
https://your-publishing-domain.example`. This installs the CLI and a discoverable
Codex skill independently of the checkout, along with private configuration and
a generated publisher credential. Re-run after changes to update the runtime.
The console reads that configuration by default; set `artifacts_config_path` in
its private profile to choose another library. For previews and tests, always
use an isolated data directory and credential.

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
