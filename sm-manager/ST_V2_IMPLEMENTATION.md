# S.T. v2 console and Ovis implementation plan

Status: proposed implementation, 24 November 2026. This change contains the plan
only. Development starts on `feature/st-v2`, based on S.T. commit
`6ea1c652b8bd3655f17bb88b2d5937bacb9770a5`.

The intended result is one S.T. web application: its existing system console
rebuilt with Ovis's React and TypeScript stack, followed by an **Ovis** navigation
item that opens the existing project/chat sidebar and conversation interface
beside S.T.'s sidebar. Ovis's application source and our integration code will
live in this repository. Herdr continues to own terminal sessions, and the
existing managed Codex daemon continues to own Codex execution and history.

There are two release gates: **console parity first**, then **integrated Ovis**.
The frontend migration can be reviewed and deployed independently of the chat
integration. Neither gate requires rewriting the resource collector, assistant,
voice clients, or touchscreen.

## 1. Scope and product decisions

| Area | Decision for this merge |
| --- | --- |
| Main dashboard/system console | Rewrite `sm-manager/sm_manager/static` application behavior in React and TypeScript. Preserve its pages, calculations, links, error states, and controls. |
| S.T. navigation | Keep S.T. branding and the persistent outer sidebar. Add **Ovis** as a distinct destination. |
| Ovis | Reuse the customized working client, including its projects/folders, saved Codex history, composer, chat, terminal, attachments, and model controls. |
| Integration target | A lazy-loaded React feature inside the S.T. shell, with an explicit host interface. A standalone URL remains available during migration and rollback. |
| System backend | Keep Python, SQLite, collection/attribution, history retention, CLI, and existing API contracts. Add only integration-related endpoints and delivery support. |
| Web transport | Introduce a small Bun gateway when Ovis integration starts, for one browser origin and HTTP, streaming, and WebSocket routing. Keep backend services independently supervised. |
| Planner | Preserve the existing DAVe integration and its persistent embedded document, route contract, credentials handling, and source download. React adoption does not imply a DAVe rewrite. |
| Faceplate | Port the console's screenshot viewer and night-mode control. Keep the actual Svelte/Three.js touchscreen and Rust service. |
| Assistant/voice | Keep existing device identity, reply routing, worker, and CLI behavior. This merge does not redirect voice requests into Ovis. |
| Project identities | Keep monitor repositories/worktrees, Ovis projects, and planner collections distinct. Add explicit links where useful; do not merge their IDs or stores. |
| Workmode | Preserve its current console filtering. It does not implicitly hide Ovis conversations or alter planner data. |
| Upstream updates | Pin imported Ovis source and dependencies. Review updates deliberately; disable upstream self-update actions in the integrated deployment. |

Existing Ovis settings and broader features need an inventory before pruning.
Preserve established behavior by default. Hosting, pairing, and update controls
that conflict with S.T.'s deployment should be disabled through explicit
capabilities, with the remaining supported settings still accessible.

### Desktop and small-screen behavior

```text
┌────────────────┬──────────────────────┬──────────────────────────────────┐
│ S.T. sidebar   │ Ovis sidebar         │ Ovis conversation                │
│                │                      │                                  │
│ Home           │ Search               │ Title / model / reasoning        │
│ Overview       │ Project              │ Chat ↔ Terminal                  │
│ Projects       │   Folder             │                                  │
│ Containers     │     Recent chats     │ Messages, activity, code, images │
│ Codex          │     Show more        │ or the same session's terminal   │
│ Storage        │   New conversation   │                                  │
│ Ovis  ←        │                      │                                  │
│ Tasks/Calendar │ Settings             │ Composer and attachments         │
│ Devices        │                      │                                  │
└────────────────┴──────────────────────┴──────────────────────────────────┘
```

S.T.'s sidebar stays mounted when switching between console and Ovis. Ovis owns
its inner project navigation. On narrow screens, each sidebar becomes a named
drawer with separate controls; the conversation receives the available width.
Keyboard focus, Escape, scroll containers, and drawer dismissal must have one
clear owner. Avoid two competing fullscreen layouts or global keyboard handlers.

Changing console pages and returning to Ovis should preserve the selected chat,
unsent draft, chat/terminal choice, and useful scroll position. It must not send a
draft, start a second terminal, or stop an agent. Browser refresh and disconnect
recovery are separate acceptance cases from in-tab navigation.

## 2. Findings that affect implementation

### S.T. console baseline

The console is currently a Python standard-library HTTP server with a buildless
frontend: roughly 4,500 lines across its JavaScript and CSS, plus HTML. Its API
and data collection are already separated from most rendering code.

Important existing behavior is spread across `app.js`, `home.js`,
`air-quality.js`, `dbs.js`, `workmode.js`, `night-mode.js`, and
`planner-shell.js`. The server also injects home service cards, the configured
printer link, and planner availability into HTML. React must receive equivalent
safe configuration; copying only the visible DOM would lose that behavior.

The server has an explicit static-file allowlist and no WebSocket upgrade or
streaming reverse proxy. Its DAVe bridge is bounded request/response forwarding;
it is not sufficient for Ovis terminal traffic.

The installed updater validates a candidate checkout and switches the runtime
clone to `main`. It currently validates Python tests without building a frontend.
The React build must become part of candidate preparation before release gate A.

`sm-manager/AGENTS.md` currently requires a buildless UI. The requested migration
supersedes that frontend constraint. Update the component instructions with the
implementation, preserving the requirements for lightweight collection, private
access, isolated tests, and independent deployment.

### Ovis baseline

The working custom Ovis checkout is based on upstream
`1d71a718db4e0318c2d7d3f3a80c3e8c939e36c1`, version `0.5.9`, with local tracked
changes and untracked integration files. The commit alone does **not** reproduce
the working application. Importing current upstream alone would lose the work
from the earlier integration.

The inspected lockfile pins React/React DOM `19.3.0`, TypeScript `7.0.2`, Vite
`8.3.4`, and the React Vite plugin `6.1.2`; the package manager is Bun `1.4.4`.
Ovis uses ordinary CSS, xterm.js, Markdown rendering, syntax highlighting, and
WebSockets. It includes dependency patches and a custom xterm build; these are
part of the working baseline, not optional cleanup.

Its main application, chat view, and composer are large, interdependent
components. Reusing only `ChatView.tsx` and `Composer.tsx` would omit providers,
transport, selection, settings, rendering helpers, and terminal lifecycle logic.
Import a working dependency closure first, then expose a hostable feature.

The custom additions include:

- `MedoProjects`, project appearance and folder organization, five recent chats
  per group, search, archived history, and saved-history preview.
- `MedoModelPicker`, including model/reasoning changes before the first message.
- `server/medo.ts`, `server/medo-bridge.py`, and `shared/medo.ts`.
- Managed-daemon history pagination and changes to conversation selection,
  defaults, Markdown image paths, composer behavior, and cookie names.

The Python adapter imports `server.py`, `organization.py`, and `chat_service.py`
from a separate `herdr-codex-sidebar` directory. That directory is not a Git
checkout; its transitive dependencies include `attachments.py` and
`daemon_transport.py`. It also mixes executable code with private project and
organization data. A complete repository integration must separate these.

The previous integration reports focused tests and browser checks passing, but
its full upstream unit run had unresolved environment/fixture failures. Treat
those results as a baseline to reproduce, not as a fully green upstream suite.

## 3. Architecture and repository layout

### Frontend and backend ownership

```text
Private browser URL
        │
Private Tailscale Serve
        │
S.T. Bun gateway, loopback
        ├── S.T. React assets and application routes
        ├── Monitor API ───────────── Python monitor + existing SQLite history
        ├── Planner routes/API ────── existing Python DAVe bridge → DAVe/Radicale
        └── Ovis HTTP/events/WS ────── imported Ovis Bun service
                                               ├── Herdr Core terminals
                                               └── packaged Python adapter
                                                       └── existing chat bridge
                                                           and managed Codex daemon
```

The gateway owns routing and delivery; domain authorization remains enforced in
the services. An Ovis outage should show an Ovis-specific error while the console
continues working. A stale monitor sample should not prevent opening chats.
Keep separate liveness/readiness reporting for the gateway, collector, planner,
Ovis, Herdr, and Codex dependencies.

During the console-only phase, Python can serve the built React assets directly.
The Bun gateway is introduced after parity, before Ovis is enabled. This avoids
coupling the frontend rewrite to a simultaneous backend migration.

### Proposed layout

```text
sm-manager/
  package.json                       # Bun workspace and orchestration scripts
  bun.lock                           # Reproducible integrated dependency graph
  frontend/
    package.json
    vite.config.ts
    src/
      app/                           # Shell, routing, configuration, providers
      components/                    # S.T. UI primitives and charts
      features/
        home/ overview/ projects/ containers/ codex/ storage/
        zed/ dbs/ air-quality/ faceplate/ planner/ ovis/
      lib/                           # Typed API clients and lifecycle helpers
      styles/                        # Scoped S.T. styles and design tokens
  services/
    web-gateway/                     # Bun HTTP/stream/WebSocket entry point
  integrations/
    dave/                            # Existing pinned integration, retained
    ovis/
      upstream.json                  # Revision, import manifest, checksums
      README.md                      # Import/update instructions and capabilities
      app/                           # Actual vendored source, build inputs, tests
        src/ server/ shared/ scripts/ patches/ ...
        LICENSE
        THIRD_PARTY_NOTICES.md
      bridge/                        # Reusable Python adapter/bridge source
      tests/                         # S.T.-specific integration contracts
  sm_manager/                        # Existing collector and API package
  scripts/                           # Build, preview, install, update, rollback
  tests/                             # Existing backend tests + browser acceptance
```

Use committed source, not a symlink to the current Ovis directory, a separately
cloned unpinned repository, or a runtime download of its latest branch. Preserve
upstream-relative build paths until they are deliberately adapted. Exclude
dependencies, built assets, runtime configuration, databases, and user files.

Use Bun workspaces for these console/Ovis packages and a single active lockfile.
Record the original Ovis lockfile checksum with the import. Resolve patches from
the workspace root and verify that the integrated build still uses them. Keep
the touchscreen's existing npm build and DAVe's separate build untouched.

### Frontend conventions

- Match the inspected Ovis versions initially. Dependency upgrades are a later
  change. Deduplicate React and React DOM across shell and Ovis.
- Use strict TypeScript, including checked indexed access. Import shared server
  protocol declarations as types only, following Ovis's existing constraint.
- Use functional React components and CSS variables; adapt proven Ovis
  primitives where practical. Avoid introducing Tailwind or another component
  framework solely for the console migration.
- Add a small typed router boundary. Select a maintained router in the
  foundation phase and pin its version; S.T. remains the sole owner of browser
  history. Ovis selection and DAVe navigation adapt to that boundary.
- Keep fetching behind typed feature clients with cancellation, deduplication,
  explicit freshness, and background refresh. Reuse Ovis transport/state where
  it already exists; do not put both applications into a new global store.
- Lazy-load Ovis, the terminal, and other heavy features. The home page should
  not initialize Ovis sockets or import its Markdown/terminal dependency tree.

## 4. Routes, APIs, and state

### Route ownership

| Browser path | Owner and behavior |
| --- | --- |
| `/` | React home dashboard. |
| `/overview`, `/projects`, `/containers`, `/codex`, `/storage` | React monitor pages. `/codex` continues to mean resource/history metadata. |
| `/zed`, `/dbs`, `/air-quality`, `/faceplate` | React console features. |
| `/ovis` | Persistent Ovis feature and its project sidebar. |
| `/ovis/chat/:threadId` | Stable saved-chat link; route resolution can show history without creating a terminal. |
| `/ovis/session/:paneId` | Active session before a saved thread ID is known; validate availability on load. |
| `/planner/tasks`, `/planner/calendar`, other existing planner pages | Preserve the outer navigation and embedded DAVe contract. |
| Existing `/#home`, `/#overview`, `/#system`, other known hashes | Compatibility redirects using replace, preserving supported query state such as Workmode. |
| Existing `/api/*` monitor endpoints | Remain compatible for the frontend and callers. |
| `/api/ui-config` | Proposed allowlisted UI configuration endpoint. |
| `/ovis/api/*`, `/ovis/ws`, required Ovis file/event paths | Explicit Ovis namespace forwarded to the imported server. |

Route precedence must keep API, asset, DAVe embedded-document, and source archive
requests out of the SPA fallback. Unknown API/static paths return errors, not
`index.html`. Refresh, pasted links, browser Back/Forward, query strings, hashes,
and modified-click/new-tab behavior need browser tests.

Ovis currently assumes root-relative URLs in multiple places. Add an explicit
transport/base-path configuration and audit fetches, WebSockets, event streams,
upload/download URLs, file previews, generated links, auth callbacks, icons,
fonts, workers, and manifests. Vite's `base` setting handles built asset URLs;
it does not fix arbitrary runtime URL construction.

`/api/ui-config` should expose only validated service cards, optional capability
flags, display metadata, and approved external links. Refactor the existing
`home.py` validation into reusable data production. Never serialize the full
Python configuration, credentials paths, tokens, or private service settings.

### Native Ovis feature interface

Introduce an `OvisFeature` entry point with explicit inputs for:

- Active/hidden state, content container, scoped portal root, and theme tokens.
- API/WebSocket base paths and a host-provided navigation adapter.
- Selected stable thread/session route and a callback for selection changes.
- Document-title/unread updates and supported deployment capabilities.

Move startup work out of Ovis's standalone `main.tsx` where necessary. The
integrated feature must not create a second React root, register a root service
worker, replace global navigation, or assume it owns `document.body`.

Scope Ovis global CSS, body/document effects, dialogs, portal targets, z-indexes,
shortcuts, and focus management. Map shared theme tokens gradually, retaining
the working chat appearance. A portal targeting `document.body` can escape CSS
scoping; the portal root must be part of the integration contract.

Load Ovis once after the first visit, retain useful state across console
navigation, and suspend hidden rendering/polling. Hidden terminal views must
not resize panes to zero or take keyboard input. On reactivation, measure the
container and fit xterm before accepting input. Keep any required background
status connection explicit, with bounded work and no duplicate subscriptions.

Existing DAVe can remain an isolated persistent frame. Its current full-page
navigation behavior is preserved in the parity release; changing the planner's
sidebar layout is a separate product decision.

### Session and data ownership

| Data | Authority | Migration policy |
| --- | --- | --- |
| Monitor history and discovery | Python monitor/SQLite | Reuse existing schema and IDs; do not reset history. |
| Codex conversation history | Existing managed Codex daemon/history | Read through the adapter; no re-import, duplicate database, or direct writes to Codex tables. |
| Herdr terminals | Existing Herdr Core session | Attach/resume explicitly; retain pane identity and ownership labels. |
| Ovis projects/folders/appearance | Existing shared sidebar store | Keep IDs and file formats compatible; separate code paths from configured data paths. |
| Ovis preferences/uploads | Existing Ovis private state | Configure existing locations during cutover; no destructive relocation. |
| Browser preferences/drafts | Existing browser storage, then namespaced S.T. storage | Version migrations on the new origin; preserve server-synced preferences. |
| Planner data | Existing DAVe/Radicale account | Preserve bridge/session handling and data storage. |

Opening an existing chat must retain the same relationship between its saved
thread ID and live terminal. Preserve the launch lock, owned-terminal reuse,
title-based thread identification, and managed-daemon connection. An unrelated
standalone writer produces an actionable error; the integration does not kill
that process or silently create another writer.

Browser-local storage is origin-specific, so moving from Ovis's separate port
does not automatically transfer drafts or local preferences. Inventory those
keys, preserve centrally stored settings automatically, and provide a deliberate
export/import path for supported local preferences/drafts if needed. Do not move
auth tokens or secret-input values. Keep the old address available during this
transition.

## 5. Private access and transport requirements

S.T.'s current console access and Ovis's owner/device permissions differ. Being
able to view machine metrics must not automatically grant terminal control.
Preserve Ovis's existing authorization for reads, writes, attachments, and
WebSocket upgrades, including read-only device restrictions.

The gateway must:

- Bind to loopback, sit behind the owned private Serve route, and validate the
  configured public Host and Origin on HTTP and WebSocket requests.
- Define a trusted-proxy contract for Tailscale identity. Reject spoofed identity
  and forwarded headers from untrusted ingress; do not treat every forwarded
  request as a trusted local owner because its peer is loopback.
- Preserve the public origin consistently downstream without disabling either
  backend's checks. Test actual private HTTPS access as well as direct requests.
- Route only configured upstreams and known namespaces. Never accept an arbitrary
  upstream URL from a client.
- Preserve status codes, content types, bounded uploads, streaming cancellation,
  and WebSocket text/binary frames, close semantics, and backpressure.
- Retain the monitor's night-mode token and DAVe's write token/session behavior.
  Never automatically replay an uncertain mutation after reconnect.
- Namespace Ovis auth, device, and stream cookies per deployment, with intentional
  paths and secure flags. Cookies are shared across ports on the same hostname;
  a preview must not overwrite the production cookies.
- Keep APIs, chats, uploads, tokens, and HTML out of shared caches. Use immutable
  caching only for fingerprinted static assets and revalidation for mutable
  manifests/bootstrap files.
- Keep an explicit asset manifest/allowlist and traversal checks when replacing
  the Python static server's fixed list. Do not expose the source tree or private
  filesystem through a general static mount.

Audit Ovis file/media routes as well as JSON endpoints; its rendered attachments
and generated local-file links must retain their existing access checks.
Derive a CSP from actual feature needs, including local fonts, workers, blobs,
and WebSockets. Keep the console unframeable and retain DAVe's narrow same-origin
embedding exception. Do not weaken CSP globally to make a broken preview work.

The integrated entry point initially uses S.T.-owned delivery and no Ovis root
service worker. Preserve standalone Ovis PWA behavior at the old address during
transition. Add an S.T.-owned installable shell only after route/cache/update
tests establish that it cannot intercept planner/API traffic or pin old assets.

## 6. Implementation sequence

Each phase should produce a reviewable commit or small PR with its own tests.
The dependency order is intentional: source preservation and discovery, console
parity, transport, native integration, then production cutover.

### Phase 0 — Preserve the working integration and establish baselines

1. Record the S.T. base revision, Ovis upstream revision, local modified files,
   and untracked integration files. Capture a source-only import manifest with
   checksums; preserve upstream notices and dependency patches.
2. Inventory the separate sidebar/bridge directory and its transitive imports.
   Separate source from private JSON catalogs, images, attachments, logs,
   credentials, and databases. Record a file-hash manifest for non-Git source.
3. Record compatible Bun, Herdr Core, Codex CLI/daemon, and chat-bridge versions
   and capabilities. Determine the minimum services needed by the integrated
   client and which are shared with native Herdr.
4. Create synthetic monitor, catalog, history, and attachment fixtures. Capture
   representative screenshots using these fixtures; never commit live machine
   snapshots or conversations.
5. Reproduce focused Ovis tests and classify existing upstream failures. Build a
   page/feature acceptance checklist from section 7.
6. Document intended deviations from upstream and update the implementation
   instructions when code migration begins.

**Exit:** the working custom source is reproducible and preserved; no required
behavior depends on remembering changes from another chat. Production services
and the original custom checkout remain intact.

### Phase 1 — React foundation and build delivery

1. Add the Bun workspace, strict TypeScript, Vite/React build, scripts, and
   lockfile matching Ovis's baseline. Keep implementation under `sm-manager`.
2. Implement `StShell`, the outer sidebar, routes, loading/error boundaries,
   accessible navigation, and compatibility redirects for current bookmarks.
3. Add typed monitor API contracts from synthetic backend fixtures. Implement
   safe bootstrap configuration and capability-driven optional links.
4. Extract reusable UI foundations: buttons, fields, dialogs, tables, tabs,
   statuses, charts, spacing/colors, and focus styling. Preserve ST branding.
5. Teach Python to serve an explicitly built asset manifest safely, with deep
   links, MIME types, compression, and caching. Extend package data handling for
   nested built assets if distributing the Python package.
6. Add repeatable build checks to CI and candidate preparation. Retain a legacy
   console mode while the React pages are incomplete; previews select the new UI.

**Exit:** a clean checkout installs, typechecks, builds, and serves the React
shell with real API data and synthetic browser tests. The installer/updater
cannot switch to a revision with missing assets.

### Phase 2 — Console pages and behavioral parity

Port in these groups, keeping existing backend calculations authoritative:

1. **Home and shell:** configured service cards, CPU/RAM summaries, sparklines,
   connection states, branding, sidebar counts, Workmode, external launches.
2. **Overview:** machine health, selectable history and series, allocation,
   time ranges, chart scaling and keyboard tooltips, cleanup review briefs.
3. **Projects/Containers/Codex/Storage:** search/sort/filter, worktree attribution,
   project metadata/icons, usage tables, scan lifecycle, retained history.
4. **Zed and DBs:** grouping, URL validation, exact checkout launches, stale
   connection handling, multiple-database selection.
5. **Air quality and Faceplate:** chart controls, fullscreen/compact behavior,
   sensor freshness, screenshot state, and server-confirmed night-mode control.
6. **Planner host:** port the existing lazy/persistent iframe and validated
   messages into React; preserve drafts, history, focus return, visibility
   notifications, error/retry, source archive, and write tokens.

Move pure domain presentation logic into tested TypeScript functions, then
replace DOM mutation with components. Existing JavaScript UI tests are useful
behavioral specifications, but their VM/DOM stubs should not dictate React
structure. Retain them until equivalent behavior is covered; remove them only
with the retired implementation.

**Release gate A:** every existing console feature passes the parity checklist
through the private preview URL. Ovis is not required to run this release.

### Phase 3 — Import Ovis and package the custom bridge

1. Vendor the pinned application source and all required build/test inputs,
   then apply the working custom delta as a separately reviewable change.
2. Preserve `LICENSE`, third-party notices, fonts/icons notices, generated
   protocol/theme inputs, patches, and the xterm build. Record what was excluded
   and why it is outside the application's dependency closure.
3. Move the reusable Python bridge modules into the repo, with explicit package
   imports. Remove `sys.path` imports from a developer checkout and hardcoded
   owner paths; configure data roots, executable paths, sockets, and state.
4. Keep the current shared chat service available. Package its source and install
   support here, but reuse the running service initially. Any later service-code
   migration must preserve its socket/protocol and native Herdr compatibility.
5. Separate source location from sidebar data location. Use existing configured
   data files during cutover with compatible locking and atomic writes; do not
   create a second independent organization store.
6. Reproduce the standalone customized application from this repository using
   isolated state before changing its layout or transport.

**Exit:** building and running from S.T. requires no Ovis/sidebar developer source
checkout. It can intentionally depend on configured shared runtime services and
private data, whose setup is documented.

### Phase 4 — Gateway and Ovis namespace

1. Add the loopback Bun gateway and explicit route table. Keep existing monitor
   and planner URLs compatible; isolate Ovis under its namespace.
2. Implement/test HTTP and streaming forwarding plus a real WebSocket bridge.
   Prove frame order, bounded queues, cancellation, reconnect, and authentication
   before sending interactive terminal traffic through it.
3. Add base-path/transport configuration to the imported Ovis client and server
   integration. Inventory every non-API file/media route and generated URL.
4. Implement the trusted-ingress identity contract, origin checks, cookie
   namespaces, limits, CSP, cache policy, and component health reporting.
5. Verify existing monitor, night-mode, DAVe, Ovis HTTP, and live terminal
   behavior through the exact private HTTPS preview address.

**Exit:** an isolated standalone Ovis view works under S.T.'s origin, including
uploads, event streams, file previews, and terminal input/output. Authentication
works without broadening who can control a session.

### Phase 5 — Native Ovis inside the S.T. shell

1. Add the Ovis sidebar item and lazy `OvisFeature` boundary. Preserve the existing
   custom project/chat sidebar beside S.T.'s sidebar.
2. Extract standalone startup into a reusable feature initializer. Adapt
   selection, routing, titles, settings providers, CSS, portals, keyboard events,
   resize observers, and optional PWA startup to the host interface.
3. Implement retained state and active/hidden lifecycle. Ensure React Strict Mode
   mount/cleanup checks cannot duplicate sessions, subscriptions, or sends.
4. Add stable saved-chat links and active-session links; distinguish previewing
   history from explicit resume/new-session actions.
5. Keep Chat and Terminal on the same Herdr pane, using the same Codex thread.
   Preserve history paging, working-activity collapse, model controls,
   attachments, code rendering, prompt answers, and disconnect-safe drafts.
6. Implement responsive double-sidebar behavior and accessibility checks.
   Keep Ovis theme/preferences available while the S.T. shell remains coherent.

**Exit:** the complete nested experience works without a second browser window.
Round trips between Ovis, console, and planner preserve intended state and do not
interfere with execution. A temporary iframe can help diagnose a difficult
integration, but it does not satisfy this native-integration phase.

### Phase 6 — Acceptance, performance, and failure recovery

1. Run the console parity matrix and Ovis workflows end to end, using isolated
   monitor data, synthetic catalogs, and a dedicated `HC_SESSION`.
2. Use fake Codex/bridge protocols for deterministic CI. Live agent tests use
   explicitly owned test chats and never real user conversations as fixtures.
3. Test long history, multiple tabs, folder synchronization, uploads/images,
   narrow screens, keyboard/IME input, disconnects, service restarts, stale data,
   and active-writer conflicts.
4. Profile home initial load, Ovis cold/warm load, hidden-view work, memory, and
   terminal responsiveness against the phase-0 baseline. Fix leaks and repeated
   mounting before adding additional caching or virtualization.
5. Verify public-host/origin rejection, read-only restrictions, forged proxy
   headers, path traversal, stale tokens, and API/static fallback boundaries.

**Release gate B:** console parity and the integrated Ovis acceptance cases pass;
remaining unsupported upstream capabilities are explicitly listed and gated.
No undocumented known failures are described as a passing suite.

### Phase 7 — Installation, cutover, and rollback

1. Extend lifecycle commands to own the gateway, monitor, Ovis bridge/service,
   build artifacts, and health checks. Preserve existing CLI names and private
   configuration conventions. Shared Herdr/Codex services are external
   dependencies, never children to kill on web-service shutdown.
2. Build release artifacts in staging before switching: source revision,
   frozen dependencies, patched sources, frontend assets, bridge code, and
   backend versions must be one coherent release manifest.
3. Extend the installed updater to validate that staged release, retain the
   previous runnable release, activate atomically, and restore it if startup or
   smoke checks fail. Keep the active service available during dependency
   installation/build. Offline boot uses the last installed release.
4. Account for the existing updater being installed outside the checkout:
   upgrade/install the new updater and units before relying on its new checks.
   Do not assume old five-minute polling learns the new build procedure by
   itself. Test the upgrade path from the current installed format.
5. Keep the stable external S.T. URL. At cutover, move the monitor to its reserved
   internal loopback port and place the gateway behind S.T.'s existing owned
   Serve route. Update host allowlists and readiness probes coherently.
6. Reuse configured private history, preferences, uploads, and shared project
   data. Verify rollback compatibility before any schema or file-format change.
   Keep backups outside Git.
7. Preserve the standalone Ovis route during acceptance. Retire its browser
   entry point only after the integrated route is established; never end the
   Herdr terminals it exposes as a side effect.
8. Verify from another PC: reload, auth persistence, an owned test chat, terminal
   toggle, attachment preview, console navigation, and planner navigation.

**Exit:** S.T. v2 runs from its independent deployment directory, survives reboot,
updates safely, and can roll back without losing monitor history or chats.

## 7. Feature acceptance matrix

| Feature | Required checks |
| --- | --- |
| Home | RAM uses decimal GB as today; CPU and 15-minute sparklines retain gaps; services remain usable during monitor outage; configured links retain order and validation. |
| Overview | Whole-host percentages, all six time ranges through 30 days, scale selection, combined/project/worktree series, legends, hover/touch/keyboard inspection, stale/empty states. |
| Health/cleanup | Same readiness/health semantics and candidate rules; copied briefs retain identities; selecting/copying performs no cleanup. |
| Projects | Running-only/search/sort, nested worktrees, metadata/icons, trusted app/repository links, Zed/DB actions, and Workmode. |
| Containers/Codex | Assigned/unassigned resources, no double counting introduced in presentation, Codex recency stays distinct from active-work claims. |
| Storage | Single-scan lifecycle, 202/409 handling, partial-result bounds, cached timestamps, shared Docker sizes, no deletion action. |
| Zed/DBs | Grouping, exact encoded paths, external handlers, fresh/stale catalogs, multiple DB choices, offline retry. |
| Air quality | Sensor cards, history/buckets, independent chart controls, fullscreen, compact/mobile layout, unavailable and stale readings. |
| Faceplate | Waiting/missing/stale capture states; authoritative night mode; token refresh/error; no accidental host suspension. |
| Planner | Tasks/calendar and other supported deep links; draft/scroll retention; Back/Forward/reload; narrow screens; credentials remain server-side; source archive remains accessible. |
| Ovis sidebar | Same projects/folders/colors/icons, five recent chats plus Show more, search/archive, missing-checkout history, cross-browser organization updates. |
| Ovis conversations | New/resumed/read-only history, long paginated history, commentary/final/tool distinctions, collapsed work, stable selection after refresh. |
| Chat/Terminal | Same pane/thread identity, output ordering, resizing, terminal input/IME, reconnect; no input replay or second writer. |
| Composer/settings | Unsent drafts retained; model/reasoning changes before and after first send; supported slash-command/prompt behavior; repeated clicks do not duplicate actions. |
| Attachments/rendering | File/image upload, image previews/lightbox, angle-bracket file paths, code highlighting, permitted file links, errors and size limits. |
| Shell lifecycle | Both sidebars on desktop, independent drawers on mobile, focus/shortcuts scoped, console↔Ovis↔planner round trips, no hidden zero-size terminal updates. |
| Deployment | Fresh install, isolated preview, offline restart, failed build, failed health check, rollback, reboot, and old-updater transition. |

## 8. Test and preview strategy

Keep the existing Python suite and add coverage only where backend delivery,
configuration, proxying, or update behavior changes. Preserve attribution,
PID reuse, history, ownership, and access-boundary tests.

Add TypeScript unit tests for API normalization, Workmode, chart series,
navigation compatibility, configuration validation, and lifecycle rules. Use
component/browser tests for actual interactions, not snapshots that merely
mirror component markup. Carry forward Ovis's focused adapter, history,
Markdown, selection, prompt, and terminal tests.

Playwright acceptance should run against a built preview with synthetic data
and test doubles by default. Its critical paths are a console navigation tour,
a planner round trip with an unsaved draft, and an Ovis round trip with a draft
and live test session. Browser screenshots use fixture data only.

Current console checks, from `sm-manager`, remain relevant during migration:

```sh
python3 -m unittest discover -s tests -v
python3 -m compileall -q sm_manager scripts
node --test tests/*_ui.js
```

Planned additional commands, to implement with the workspace/lifecycle scripts:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test:unit
bun run build
bun run test:integration
bun run test:browser
python3 scripts/preview-v2.py start
python3 scripts/preview-v2.py status
python3 scripts/preview-v2.py stop
```

The preview launcher should reserve distinct ports and service names per
worktree, read the machine's private access profile, and print a stable private
HTTPS URL. Keep listeners on loopback and own only that preview's Serve route.
Use separate monitor/state directories, cookie names, and test Herdr session;
do not clone credentials or point tests at the live Codex database. Leave the
preview running for review once implementation reaches a runnable phase.

The planning-only worktree does not need a service or preview deployment.

## 9. Risks and decisions to resolve in the first phases

| Risk or open detail | Resolution and gate |
| --- | --- |
| Working customization is outside committed Ovis history | Preserve tracked and untracked source, plus external bridge source hashes, before porting. Phase 0. |
| Sidebar directory mixes code and live data | Package source and make data paths configurable; preserve shared format/locking. Phases 0/3. |
| Ovis assumes full-page ownership | Prove scoped CSS, portals, routing, document effects, and hidden lifecycle with the complete feature. Phase 5. |
| Stateful terminal transport through another hop | Prove WebSocket streaming/backpressure, authorization, reconnect, and resize under isolation. Phase 4 before enabling interactive use. |
| Existing Ovis and S.T. access models differ | Specify trusted identity and retain Ovis owner/read-only checks; forged-header tests. Phase 4. |
| Two clients could resume/create the same conversation | Preserve shared locking, owned terminal reuse, daemon routing, and conflict errors across standalone/integrated clients. Phases 3–6. |
| Shared bridge is also used by native Herdr | Package and test protocol compatibility; reuse the current running bridge until a coordinated code cutover is justified. Phases 3/7. |
| Large dependency graph and patched xterm | Preserve custom build pipeline and frozen versions; split application chunks; avoid casual dependency pruning. Phases 1/3/6. |
| Browser-only drafts/settings do not move between ports | Inventory storage, retain old URL, offer explicit supported export/import without transferring secrets. Phases 0/7. |
| Installed updater expects buildless Python | Add staged artifacts and an explicit updater/unit upgrade path before shipping React as default. Phases 1/7. |
| Ovis API surface exceeds the initial feature set | Inventory runtime routes/capabilities; retain required routes, gate unsupported hosting/update functions. Phases 0/4. |
| Router choice and responsive widths | Choose and pin in phase 1; verify small desktop widths and phone layouts in browser tests, with configurable Ovis sidebar sizing. |

No product clarification is required to begin with these defaults: **Ovis** is
the new menu label, existing console behavior is the parity target, and native
React composition is the integration target. Broader sidebar redesign, a
unified project model, and a native planner composition can follow separately.

## 10. Completion criteria and maintenance

The merge is complete when:

1. A fresh clone contains all application and custom bridge source needed to
   build the console and Ovis, with explicit shared-service prerequisites.
2. The React console passes every parity row, preserving existing URLs through
   compatibility routes and preserving Python/CLI behavior.
3. Selecting Ovis keeps S.T.'s navigation visible and exposes the complete
   customized chat/terminal workflow next to it.
4. Existing history, project/folder identities, settings, uploads, and terminals
   survive the transition; no second Codex execution backend is introduced.
5. One private origin serves the experience with working authentication,
   authorization, live streams, uploads, deep links, and reconnect behavior.
6. The independent deployment builds reproducibly, updates from a coherent
   release, and rolls back successfully without private data loss.
7. Instructions, CI, notices, supported-capability list, and preview lifecycle
   describe the final implementation. Legacy console assets are removed only
   after release gate A and a retained rollback release exist.

For later Ovis upgrades, record the new upstream revision, compare its changes
with the import manifest and custom delta, refresh dependency patches/types,
run focused and integrated acceptance tests, and deploy through S.T.'s release
mechanism. Track compatibility with Herdr and Codex explicitly. Avoid automatic
upstream updates that bypass those checks.

## References

- [Console instructions](AGENTS.md), [console behavior/setup](README.md),
  [HTTP server](sm_manager/server.py), [current UI](sm_manager/static/index.html),
  [planner lifecycle](sm_manager/static/planner-shell.js), and
  [installed updater](scripts/updater.py).
- [STapp instructions](../stapp/AGENTS.md) and
  [assistant/faceplate documentation](../stapp/README.md).
- [Pinned upstream Ovis source](https://github.com/devswha/ovis/tree/1d71a718db4e0318c2d7d3f3a80c3e8c939e36c1).
  The local customization and external bridge must be captured separately as
  described above; this upstream link alone is not the working custom client.
- [React lazy loading](https://react.dev/reference/react/lazy) supports deferring
  the Ovis component code until its first use; retained state and effect
  suspension still require explicit lifecycle design.
- [Vite production base paths](https://vite.dev/guide/build.html#public-base-path)
  cover built assets; runtime API/socket/file URL construction needs its own
  integration audit.
- [Bun WebSockets](https://bun.sh/docs/runtime/http/websockets) describes upgrade,
  message, and backpressure APIs; forwarding between two sockets is explicit
  gateway work and must be tested.

## Implementation checkpoint — 2026-11-24

The branch now has a working native integrated preview. Each implementation
milestone is committed separately as `the-medo` on `feature/st-v2`.

Implemented:

- Preserved the customized Ovis source, dependency patches, MIT notices and
  Python bridge with source hashes and explicit private data paths.
- Added the pinned Bun workspace, React 19/TypeScript/Vite console, typed monitor
  clients, native console pages, charts, Workmode, device controls and retained
  DAVe frame/navigation.
- Added a loopback HTTP/WebSocket gateway with origin/host checks, preserved
  public identity, streaming bodies, bounded socket forwarding, and managed
  update/runtime restrictions.
- Mounted Ovis in the same React root, lazy loaded beside the S.T. sidebar.
  Themes, DOM queries, portals and keyboard handling are scoped to its panel.
  Chat selection/drafts survive console navigation; Chat/Terminal and the mobile
  drawers work in browser acceptance. Existing query-based session links remain.
- Packaged the Ovis web server without its self updater. The preview owns its
  monitor, gateway and Ovis services; the shared managed Codex service and Herdr
  terminal daemon remain external. The preview has separate cookies/state and
  shares the original launch lock/catalog intentionally.
- Added persistent private preview lifecycle and activation failure recovery.
  Extended the production updater source with staged frozen builds, version
  checks, artifact rollback, and retained previous artifacts. The installed
  production updater and service layout have not been switched.

Verification completed:

| Check | Result |
| --- | --- |
| Python monitor/lifecycle/updater suite | 114 passed |
| Packaged Python bridge and history adapter | 32 + 2 passed |
| Existing legacy UI checks under Node | 38 passed |
| New frontend/gateway/cookie unit checks | 8 passed |
| Focused Ovis auth/access/Medo/Markdown suite | 163 passed |
| Ovis file-serving/auth/gateway checks during namespace work | 106 passed (overlaps the checks above) |
| Production console build and TypeScript checks | Passed |
| Clean disposable clone: frozen install, build and validation | Passed |
| Console browser acceptance | Passed with synthetic APIs |
| Native Ovis browser acceptance | Passed with demo data through the real Python asset/CSP server, on desktop and a 390px viewport |
| Actual Herdr PTY through Ovis and gateway | Passed in an isolated HOME/socket/session; terminal survived web-service shutdown |
| Private HTTPS preview | Monitor, Ovis health, owner authentication and catalog reads verified |

The home entry's JavaScript/CSS totals approximately 93 KiB gzipped in this build;
the large Ovis feature stays in dynamically loaded chunks. This is a build-size
measurement, not a completed long-running performance study.

Release gates remain open. Before production cutover, finish the complete parity
matrix, long-history/attachment/IME and disconnect cases, saved-thread path-link
handling, cross-PC acceptance with an explicitly owned test Codex conversation,
and the production three-service installer/updater migration. The preview is
restricted to its configured Tailscale owner. Delegated-device rollout, native
mobile/desktop relay hosting and the root PWA require separate acceptance.
The full upstream Ovis test matrix has not been claimed as passing.

The existing S.T. and standalone Ovis installations remain available. Preview
addresses and real-machine screenshots are kept in private local profiles/cache,
not in the repository. Use the lifecycle and verification commands in README.md.

## Original console styling restored — 2026-11-24

The React console now imports the preserved `static/style.css` and `home.css`
through a Vite scope adapter. The original dark blue palette, 174px sidebar,
12px console typography, tinted home cards and sparklines, compact monitoring
panels, project/worktree layouts, container memory emphasis, and amber Workmode
styling are restored. Tablet navigation returns to the 54px icon rail; phones
use the original horizontal navigation. Ovis and the planner fill the remaining
height below the console navigation.

The console CSS scope stops at the Ovis root. Legacy home `rem` sizes retain
their original 12px baseline without changing Ovis's document baseline.
Validation: TypeScript and production build passed; all 8 frontend/gateway
unit checks and both browser acceptance suites passed. A local synthetic-data
comparison against the original HTML/CSS matched 15 computed style properties
on 18 shell/home selectors at 1440px, 900px and 390px viewport widths. Fixture
screenshots were inspected for home, monitoring views, Workmode and embedded
Ovis. Browser coverage also checks the original desktop/tablet sidebar widths,
mobile project overflow and the Ovis viewport below mobile navigation.

## Shared application theme — 2026-11-24

`packages/theme` now owns the console/Workmode colors, typography, spacing and
corner tokens. The legacy and React consoles use its generated stylesheet.
Hosted Ovis consumes a resolved appearance entry for both CSS and terminal
canvas colors, plus shared typography/shape tokens. Its Appearance page explains
the host theme without changing saved standalone preferences. Theme application
runs before paint. The planner proxy adds same-origin theme assets that map DAVe
and FullCalendar tokens; validated parent messages keep the retained frame in
sync with Workmode. Navigation preserves the host context and both apps' drafts.

Validation: build, TypeScript, frozen workspace install, 11 shared frontend/unit
checks, 115 Python checks, both browser acceptance suites, and all 240 focused
Ovis appearance/settings/preference checks passed. The legacy visual comparison
still matches the pre-extraction styles at desktop/tablet/mobile widths. The
broader Ovis conventions run passed 18 checks and exposed its existing icon-cache
assertion requiring a static icon URL in `src`; the imported source instead uses
bundled images. That unrelated check and the icon assets are unchanged.

See `packages/theme/README.md` for the package contract, adapters and generation
commands. Static Python assets are generated and checked in; `theme:check`
verifies that they match the package sources.

## Chart tooltip parity restored — 2026-11-24

The shared React chart now renders a floating tooltip inside the plot, with a
crosshair, colored sample markers and per-series readings, replacing the hover
text previously relegated to its footer. Overview, worktree history and all
AirQ history axes share the fix. Tooltips support hover, tap and keyboard
inspection, remain readable while hovered, and dismiss on Escape or outside
interaction. Placement respects viewport edges, scrolling dialogs and fullscreen
charts. Slightly offset series timestamps match within half a bucket; missing
and non-finite samples remain missing. History-derived arrays are memoized so
pointer movement does not repeatedly sort all collected readings.

Validated with TypeScript, production build, the chart/unit suite and browser
checks for multi-series values, CPU/memory units, missing air readings, legend
filtering, keyboard stepping, dialog Escape behavior, fullscreen and phone taps.
