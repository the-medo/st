# Ovis source baseline

This directory preserves the working customized Ovis client before integration.
`upstream.json` records its upstream base. `source-manifest.json` records the
SHA-256 of every imported source file, including the uncommitted customization
and the external Python bridge. Subsequent integration commits intentionally
change these files; the manifest remains a record of the original import.

`app/` contains the web frontend, Bun server, shared protocols, patches, build
scripts and tests. Native mobile applications, marketing sites, release/CI
workflows, recordings, private deployment notes and runtime data are excluded.
Upstream MIT and third-party notices are retained. `bridge/` contains the custom
sidebar/chat service source; its live project catalogs and account data are not
part of the repository.

The original import is preserved in the source manifest. The bridge now uses
explicit data paths and the native frontend uses the host in `frontend/src/features/ovis`.
Follow `../../ST_V2_IMPLEMENTATION.md` for the integration sequence. Never start tests
against the owner's Herdr session or Codex database. Existing production Ovis
and the shared chat bridge remain independently managed.

## Packaged bridge configuration

The custom adapter imports `integrations.ovis.bridge` from this repository.
It never imports executable code from the configured data directory. Configure
these variables in a private service environment file:

| Variable | Purpose |
| --- | --- |
| `ST_OVIS_SIDEBAR_DATA` | Existing directory containing projects/organization/appearance JSON and icon data. `MEDO_SIDEBAR_ROOT` remains a data-only compatibility alias. |
| `ST_OVIS_CODEX_SOCKET` | Existing managed daemon control socket. Defaults beneath `CODEX_HOME`. |
| `ST_OVIS_CHAT_SOCKET` | Existing shared chat-bridge socket. Defaults to the user's runtime directory. |
| `ST_OVIS_HC_BIN`, `ST_OVIS_CODEX_BIN` | Explicit installed executable paths when needed. |
| `ST_OVIS_ATTACHMENTS` | Existing bridge attachment directory. |
| `OVIS_STATE_DIR` | Ovis preferences/device state, separate per deployment. |
| `HC_SESSION` | Dedicated test session for tests/previews; leave production session configuration intact. |

The catalog, organization IDs, atomic writes, managed-daemon protocol, and launch
ownership rules are unchanged. Standalone and integrated launchers share
`~/.local/state/herdr-codex-sidebar/launch.lock`; separate Ovis state directories
do not split the launch lock. To install the packaged chat service later, use
`python3 -m integrations.ovis.bridge.chat_service` from `sm-manager`. Do not run
a second service on the existing socket. The integrated client initially uses
the already-running shared service.

Checks from `sm-manager`:

```sh
python3 -m unittest discover -s integrations/ovis/bridge -p 'test_*.py'
python3 integrations/ovis/app/server/medo_bridge_test.py
HERDR_TEST_MODE=unit bun test --cwd integrations/ovis/app server/medo.test.ts src/lib/markdown.test.ts
bun run build:ovis
```
