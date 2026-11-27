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
| `ST_OVIS_HC_BIN`, `ST_OVIS_CODEX_BIN`, `ST_OVIS_CLAUDE_BIN` | Explicit installed executable paths when needed. |
| `CLAUDE_CONFIG_DIR` | Claude's existing configuration/transcript directory; defaults to `~/.claude`. |
| `ST_OVIS_ATTACHMENTS` | Existing bridge attachment directory. |
| `OVIS_STATE_DIR` | Ovis preferences/device state, separate per deployment. |
| `HC_SESSION` | Dedicated test session for tests/previews; leave production session configuration intact. |

Existing Codex catalog and organization IDs, atomic writes, managed-daemon protocol,
and launch ownership rules are preserved. Ovis web instances sharing a sidebar data directory
serialize launches through its `ovis-launch.lock`; separate Ovis state directories
do not split that lock. The legacy sidebar launcher retains its independent
`~/.local/state/herdr-codex-sidebar/launch.lock`. To install the packaged chat service later, use
`python3 -m integrations.ovis.bridge.chat_service` from `sm-manager`. Do not run
a second service on the existing socket. The integrated client initially uses
the already-running shared service.

## Conversation providers

S.T.'s New conversation dialog offers Codex (initially selected) and Claude,
with model/reasoning choices and remaining weekly usage for each CLI's current
account. It uses the existing CLI sign-in and usage reader without refreshing
credentials. Missing or stale usage is shown as unavailable. Claude model aliases
resolve through the installed CLI and organization policy.

Claude launches directly through Herdr and stores its own history. The private
`claude-conversations.json` beside the sidebar configuration records its session
UUID, project, working directory, configuration directory and display name. Only
sessions created or subsequently switched in S.T. are indexed. Native session
records plus process birth times identify live conversations; a saved launch
label cannot bind a later `/clear` or `/resume` to the previous history. The
sidebar supports saved reading and resume without copying transcript content.

First messages use Ovis's existing page-bound queue. Loss of page ownership
holds the message for the user; a queue failure after launch keeps the message
as a draft in the created conversation. Saved per-provider permission presets
apply when starting a new conversation.

Checks from `sm-manager`:

```sh
python3 -m unittest discover -s integrations/ovis/bridge -p 'test_*.py'
python3 integrations/ovis/app/server/medo_bridge_test.py
HERDR_TEST_MODE=unit bun test --cwd integrations/ovis/app server/medo.test.ts src/lib/markdown.test.ts
bun run build:ovis
```

Provider-specific checks use synthetic history and an isolated Herdr instance:

```sh
mkdir -p "$HOME/.cache/ovis-tmp/providers"
export TMPDIR="$HOME/.cache/ovis-tmp/providers"
python3 integrations/ovis/app/server/medo_bridge_test.py
HERDR_TEST_MODE=unit bun test --cwd integrations/ovis/app server/medo.test.ts src/lib/medoProviders.test.ts
(cd integrations/ovis/app && bun scripts/medo-sidebar-browser-qa.ts)
ST_OVIS_HC_BIN="$(command -v hc)" python3 tests/ovis-providers.py
```

Set `UI_EVIDENCE_DIR` for the browser check to save synthetic desktop and phone
screenshots. The Herdr check uses a fake Claude process and never calls a model
or reads the owner's CLI histories.
