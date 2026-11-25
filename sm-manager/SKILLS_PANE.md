# Skills and MCP pane experiment

The Agents header's book button opens **Skills & MCPs** beside the conversation.
Press and release **Ctrl** twice, then **S**, to toggle it; the button shows an S
keycap while shortcuts are ready. On a narrow screen it opens a sheet. This
branch is a read-only experiment.

## Assessment

The [Skillshare Herdr package](https://github.com/runkids/skillshare/tree/main/herdr/skillshare)
is a native Herdr mod built with `gpui-kit`, `gpui-base` and Herdr-specific layout,
command and machine APIs. ST embeds Ovis's React client, so copying the mod into
Herdr's configuration would not add a panel to ST. Its pure JavaScript model and
loader are separable, but a React view and an authenticated server adapter are
still required. The upstream project is MIT licensed; its notices must accompany
any code we later copy.

Skillshare manages a source catalog and synchronizes it to agent targets. It can
report sync drift and upstream skill updates, preview resources, install/update
and audit them, and synchronize source repositories across machines. It does not
supply evidence of which resources an individual conversation actually used.
That requires the agent's recorded history.

The first pane is a modest integration because ST already owns the selected
conversation, history, skill-read detection, right-side file panel, and responsive
sheet. A full equivalent of the upstream manager is larger: it needs serialized
mutations, audit/confirmation flows, versioned CLI compatibility, conflict
resolution, and correct per-machine routing. Those features should follow a
successful trial of this read-only view.

## Prototype behavior

- **Used** summarizes explicit skill reads and MCP calls from loaded chat history,
  updating with the chat stream. **Load earlier activity** pages the same history.
  Skill instructions loaded does not imply workflow completion. Prose, searches
  and opaque code-mode scripts are not interpreted as resource use. Counts cover
  only records the bridge receives; compacted/omitted events cannot be recovered.
- **Available** asks the existing local agent daemon for `skills/list` for the
  verified conversation's directory, and paginated `mcpServerStatus/list` for its
  thread. Disabled skills and unknown/failed MCP connection states stay explicit.
  Tool names/descriptions are shown; configuration, credentials, schemas, raw
  discovery errors and tool outputs are excluded from inventory responses.

The inventory route is owner-only, `no-store`, and accepts an existing pane/thread
identity, never a caller-supplied directory or command. The pane currently targets
ST's local Codex conversations. Other agents and remote machines need their own
adapters. There is no Updates tab, Skillshare CLI dependency or update-checking
endpoint. No install, sync, update or configuration mutation is offered.

The UI follows [Zed's separation of agent tools and MCP inventory](https://zed.dev/docs/ai/mcp),
with ST's existing right-side inspector and mobile sheet. The resource grouping
is inspired by Skillshare. No upstream UI code was copied.

## Runtime overhead

- Closed: the panel is unmounted, history reporting is disabled, and it makes no
  inventory requests. Its small UI module and CSS are still in the static bundle;
  structured skill/MCP metadata remains part of the existing chat responses.
- Open: Used aggregates the loaded conversation in browser memory as the history
  changes. It shares the existing turns rather than fetching another transcript.
  Work grows linearly with the loaded message parts. The open panel also receives
  these history updates while Available is selected.
- Selecting Available or pressing Refresh makes one HTTP request. The backend
  starts a short-lived Python bridge, verifies the conversation, connects to the
  existing daemon, and reads skills plus MCP status (additional pages when needed).
  It closes that connection afterwards. There are no inventory polling timers,
  model requests, tool executions or automatic update checks.

The experiment's separate preview services, including its private chat bridge,
cost memory independently of this pane. Deploying the feature into the existing
stack does not require another persistent resource service.

## Verification and preview

Run from `sm-manager` with the pinned Bun 1.4.4 on PATH:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
bun test frontend/src services/web-gateway services/ovis packages/theme
python3 -m unittest integrations.ovis.bridge.test_resources integrations.ovis.bridge.test_chat -q
python3 -m unittest discover -s integrations/ovis/app/server -p 'medo_bridge_test.py' -q
bun tests/ovis-browser.ts
```

Run focused native tests from `sm-manager/integrations/ovis/app`:

```sh
bun test server/medo.test.ts server/skill-activity.test.ts src/lib/resourceActivity.test.ts
```

Browser checks use synthetic data and cover usage, connection/error states,
filtering, on-demand inventory reads, desktop focus, mobile sizing, close/reopen races and
the existing shortcut/navigation acceptance. Set `ST_V2_EVIDENCE` to a private PNG
path to save before/after screenshots. Real chats are never used for screenshots.

A private branch preview uses `scripts/preview-v2.py` and `preview-ovis.py`, with
separate state and services. The preview gateway uses a private backend credential
after checking the Tailscale owner; the browser should never need an Ovis pairing
code. Startup checks authenticated health through both the backend and gateway.
Its chat bridge must run this checkout's
`integrations.ovis.bridge.chat_service` on its own socket to preserve the new
structured activity fields; the existing shared bridge remains unchanged. Keep
that unit in the preview profile's `units` array so the normal preview lifecycle
stops it too. Installing this feature later also needs the production chat bridge
to pick up the normalizer changes; restarting only the web server is insufficient.

The broader imported Ovis typecheck currently fails in 14 unchanged files
(Node type mismatches and absent upstream native-app sources). Its conventions
suite also has a pre-existing icon-cache expectation failure. The ST typecheck,
build, focused feature tests and browser acceptance are the checks for this
experiment; those unrelated upstream failures are not suppressed.
