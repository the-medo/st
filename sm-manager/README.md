# ST · System console

The React v2 migration is developed on `feature/st-v2`. See
[the implementation plan](ST_V2_IMPLEMENTATION.md). From this directory run
`bun install --frozen-lockfile`, `bun run typecheck`, `bun run test:unit`, and
`bun run build`. A private configuration with `"frontend": "react"` selects
the built console; existing installations retain the legacy frontend during
the migration. Built output and local configuration stay out of Git.

The React console supports scoped shortcuts: tap and release **Ctrl twice**
within 700 ms to show the current page's keys, or press and release **Ctrl+Shift**
to open the main sidebar's keys directly. The bottom-right Ctrl ring fills halfway
after the first tap and fully when ready. **Escape cancels completely**;
**Shift alone** or **Left Arrow** returns to the main sidebar while armed.
Shortcut mode expires after eight seconds without a choice (except in the recent
items picker, or while Planner loads its Quick Add control). Existing modifier combinations keep their normal behavior.
The sequence works in Agents, terminals, and the embedded planner without
inserting a shortcut letter into a draft. Reduced-motion preferences apply.

| Key | Destination | Key | Destination |
| --- | --- | --- | --- |
| H | Home | A | Agents |
| O | Overview | P | Projects |
| N | Containers | X | Codex |
| S | Storage | Z | Zed |
| D | DBs | T | Tasks |
| C | Calendar | F | Faceplate |
| R | Prusa Connect (new tab) | Q | Air quality |
| W | Toggle Workmode | | |

Only currently available sidebar items have active shortcuts. Workmode hides
device shortcuts, and navigation retains the current Workmode setting and the
last Agents conversation.

Opening Agents or Planner with a main-sidebar shortcut keeps the mode ready:

- **Planner:** Contacts **O**, Calendar **C**, Tasks **T**, Notes **N**, Journals
  **J**. The current page has no navigation key. **Q** opens its New form and
  ends shortcut mode. Calendar shows a temporary **+ New** button on today;
  when today is outside the visible date range, it appears on the toolbar.
- **Agents:** the first nine projects get **1–9**; rendered conversations get
  **A–Z**, skipping **E** and **Q**. Folded conversations and those behind Show
  more are excluded. **Q** opens the New conversation chooser.
- **Selected project:** its first conversation opens automatically. Its own
  first nine visible conversations get **1–9**, **Q** creates a conversation in
  that project, and **O** opens project options. Selecting a conversation ends
  shortcut mode.
- **Inside a conversation:** double Ctrl shows the Agents sidebar keys together
  with **T** new terminal, **Y** switch chat/terminal, **F** files, **O** more
  options, and **Q** new conversation. Projects still use **1–9**; conversation
  letters skip **E/Q** and the reserved toolbar keys **T/Y/F/O** in this mode.
  A collapsed Agents sidebar opens so its keys are visible.
- **Recent items:** **E** from any Agents shortcut scope opens this tab's recent
  conversations and terminals, with the previous visit highlighted. **E** or
  **Down** advances; **Shift+E** or **Up** goes back. **Enter** opens the selection;
  **Escape** cancels without navigating. Visits remain in memory for this page
  session, with chat and terminal views tracked separately. Rows show conversation
  names, project names, live status, and agent icons. Status/name updates keep the
  order and highlighted selection stable.
- **Saved histories:** ended and archived conversations open in the main page,
  with read-only history and support for reload and browser Back/Forward. The
  embedded Agents view uses recents and the sidebar instead of top tabs; **+**
  still creates a terminal.

A quiet, local dashboard for the projects running on your machine. See which app,
branch, worktree, or Docker container is using memory and CPU without asking an
agent to inspect the host every time.

**Linux · Python 3.11+ · buildless system console; optional DAVe subapp uses Node.js**

The dashboard is branded **ST**. Its chiseled vector mark lives in
`sm_manager/static/st-logo.svg`; `sm_manager/static/favicon.svg` uses the same
geometry in black on an ivory tile for browser tabs. Keep both paths in sync
when editing the mark. The header uses the light mark against the dark sidebar.
The shared `st` CLI covers the assistant, photos, system status and screen
control. Python package, service and configuration names remain stable; `sm`
is retained as the monitor backend and a compatibility command.

## Homepage

The homepage keeps the sidebar and puts your services next to compact, live RAM
and CPU charts. RAM leads with used GB (decimal gigabytes), with total capacity
and percentage below; CPU leads with its percentage. Both cards link to
**Overview**. The charts show whole-machine percentages and 15 minutes of history.
Links remain available if the monitor is still starting or offline.
Click the **ST logo** to open this homepage (`#home`, also the default at `/`).
**Overview** (`#overview`) opens the original dashboard with the full resource
charts, machine health, allocation, cleanup candidates and process tables.
The **System monitor** card opens that same Overview; existing `#system` links
remain an alias for it.

Prusa Local uses `printer_url`; Planner appears when DAVe is configured.
Air quality, Faceplate and System monitor are built in. Add other services to
`home_links` in the private `~/.config/sm-manager/config.json`, then restart the
monitor. Entries appear before the built-in services, in configuration order:

```json
{
  "home_links": [
    {
      "name": "Audiobookshelf",
      "url": "https://books.example.com",
      "description": "Audiobooks, podcasts and your next chapter.",
      "category": "Listen",
      "icon": "headphones",
      "tone": "amber"
    }
  ]
}
```

`name` and an HTTPS `url` without embedded credentials are required. Other fields
are optional. Icons: `headphones`, `printer`, `calendar`, `air`, `screen`, `system`,
`link`. Tones: `amber`, `coral`, `violet`, `mint`, `blue`, `slate`. Unknown icon/tone
values fall back to `link`/`slate`; invalid links are skipped. External services
open in a new tab. No external icons, fonts or service-status checks are loaded.

## What it does

- Groups running processes and containers by Git repository and worktree.
- Shows machine CPU, memory, swap, listening ports, and larger host processes.
- Keeps a rolling 30 days of machine, project, and worktree history in SQLite.
- Compares all projects on one CPU or memory chart, with a dashed combined-total
  line and a clickable legend. Individual project, worktree, and whole-machine
  views remain available.
- Discovers Codex worktrees and shows local thread recency and runtime overhead.
- Links to apps that already have a private Tailscale Serve route.
- Opens the exact remote checkout in your local Zed client from the dashboard.
- Charts an optional M5Stack AirQ device with 30-day history and source-linked
  ventilation, particle-exposure, and relative gas-index indicators.
- Copies a cleanup brief with exact resource identities for an agent to review.
- Checks Docker, private Tailscale access, sleep protection, free disk space,
  memory pressure, and observed operating-system version changes.
- Lists sustained low-CPU worktrees for cleanup review and copies a combined
  brief for selected candidates.
- Scans project disk usage on demand, including dependencies, build caches,
  Git metadata, and associated Docker storage, including stopped containers.

Resource monitoring and cleanup briefs remain read only. The optional Faceplate
night-mode switch controls the paired screen's power; it does not suspend the
computer or stop applications.

The Projects page shows a project info panel beside each worktree table: a local
favicon (or initials), description, package version, checkout path, repository
link, and discovered private app links. Metadata is refreshed with discovery,
preferring the primary checkout. Bounded scans read `package.json`,
`pyproject.toml`, HTML icon declarations, and common favicon files; dependencies,
build output, hidden files, and symlinks are skipped. Icons are served locally
with the same access checks as the API. No external favicon service is used.

## Tasks and Calendar

With DAVe configured, the sidebar opens **Tasks** at `/planner/tasks` and
**Calendar** at `/planner/calendar`. These are full-page ST subapps: DAVe owns
the sidebar, collections, search, settings and editors. Click the ST logo to
return to the system console. Direct links, refresh and browser Back work;
mobile has an ST home button as well as DAVe's drawer and bottom navigation.

The browser needs no additional login. ST's loopback bridge opens the configured
DAVe account on the server and retains its session there. DAV credentials and
DAVe cookies are never sent to the browser. Host/origin checks remain in force,
and writes require a token obtained from the same ST origin. This is a shared
owner account for the existing private Tailscale access boundary, not a public
or multi-user deployment. Keep DAVe itself on loopback.

The integration is an optional frontend patch against the pinned upstream in
`integrations/dave/upstream.json`. Radicale and DAVe's backend remain upstream.
The system console keeps its Python standard-library backend; Node.js 22+ and
DAVe dependencies run separately. The sidebar's **DAVe · Source** link downloads
the exact patched source, including its AGPL license and dependency lockfile.

ST loads the planner on its first visit in a persistent same-origin frame. This
isolates DAVe's styles and portals while keeping both interfaces, cached queries,
scroll positions and unfinished planner drafts in memory during a round trip.
The outer shell owns browser history; DAVe uses a memory router and validated
same-origin messages. Direct `/planner/tasks` and `/planner/calendar` links,
reload, Back/Forward and modified-click/new-tab navigation still work. Only the
explicit embedded planner document permits same-origin framing; the console
remains unframeable. Neither app's state survives a full browser reload.

Planner pages, search and settings load as separate JavaScript chunks. Hashed
JS/CSS assets use private immutable caching; console assets revalidate with
ETags. The Python gateway gzips static text when supported, so this also works
in branch previews without reverse-proxy configuration. HTML, API data, session
tokens and source archives remain `no-store`. Hidden planner polling pauses;
returning displays the cached view immediately and refreshes in the background.

Build from this component directory, with Node/npm on PATH:

```sh
python3 scripts/build-dave.py \
  --checkout /path/to/dedicated/dave-checkout \
  --source-archive /path/to/private/dave-source.tar.gz
```

The builder clones the pinned revision if the checkout is absent and applies
the tracked patch. It refuses unrelated edits; keep an experimental checkout
and regenerate `integrations/dave/st.patch` with `git diff --binary HEAD` when
updating the integration. New patch files must be in Git's index (intent-to-add
is sufficient). Dependencies, builds, configuration and runtime data are not
vendored into ST.

For an independent branch preview, supply an existing CalDAV account using a
private JSON file with `username` and `password` fields:

```sh
python3 scripts/preview-dave.py start \
  --checkout /path/to/dedicated/dave-checkout \
  --source-archive /path/to/private/dave-source.tar.gz \
  --credentials /path/to/private/login.json \
  --dav-url http://127.0.0.1:18644
python3 scripts/preview-dave.py status
python3 scripts/preview-dave.py restart
python3 scripts/preview-dave.py stop
```

The preview prints a private Tailscale URL, uses distinct ports (override
`--port` and `--dave-port` if needed), and owns two separate user services. Its
configuration and data live in `~/.config/st-dave-preview` and
`~/.local/share/st-dave-preview`. Stop it before removing its source worktree.
The installed system console and its updater are unaffected.

The gateway is covered by the component's Python tests. To exercise a running
preview in a fresh browser (Playwright and Chromium required), run:

```sh
DAVE_CHECKOUT=/path/to/dedicated/dave-checkout \
ST_PREVIEW_URL=https://your-private-preview \
node tests/test_dave_browser.mjs
```

This creates and removes uniquely named test tasks/events and checks desktop and
mobile navigation, automatic access, editing, reload, history, draft preservation
and a round trip to ST without document/script downloads.

For production, `scripts/install-dave.py --credentials /path/to/login.json
--dav-url http://127.0.0.1:RADICALE_PORT` builds a pinned release outside all
worktrees and installs `sm-manager-dave.service` on loopback (default port 18647).
It enables the three `dave_*` console settings and restarts the console. Use
`--prepare-only` to start the backend before switching the console. Re-run the
installer after changing the pinned DAVe version/patch. Runtime releases, source
archives, cache and session databases live below the console data directory's
`dave/` folder; the private environment lives next to its configuration. Use
`systemctl --user status|restart|stop sm-manager-dave.service` for its lifecycle.
An unconfigured console hides the Planner section.

The faceplate can use **this same DAVe backend and Radicale collection** through
STapp's shared planner adapter. Its task edits, completions and calendar changes
then use DAVe's API and recurrence rules. Standard CalDAV fields are authoritative;
there is no second task store or synchronization copy. Task-list collections map
to faceplate projects; screen visibility remains a local faceplate preference.
See [the shared planner switch](../stapp/docs/planner.md#shared-dave-planner) for
backup, migration, verification and rollback instructions. Do not expose the
legacy metadata-based collection to DAVe until that switch is complete.

## Workmode

The **Workmode** switch below the logical-core count at the bottom of the sidebar focuses Projects, Containers,
Codex, Storage, Zed, and DBs on Ydistri. Bookmark `/?workmode=1#projects` (or any
other page) to open directly in Workmode. The URL is the source of truth, including
browser Back/Forward; turning it off removes the parameter.

Workmode uses an orange theme and a small Ydistri mark beneath ST in place of
“System console”, and hides Devices.
Opening a device bookmark with Workmode enabled returns to Overview. **Overview
keeps all projects, machine totals, history, cleanup candidates, and checkout
actions**, even in Workmode. The sidebar counts still describe the work pages.

Work membership comes from Ydistri catalog groups, a `ydistri` directory segment,
or the `ydistri` / `ydistri-customers` GitHub organization. Linked worktrees inherit
their project's membership. External DB groups such as **Ydistri DEV** and
**Ydistri PROD** are included; unassigned containers and databases are excluded.
Codex shows metadata and processes attributable to work checkouts, excluding
shared host processes. This is a display filter; collection and history are unchanged.
The bundled Ydistri SVG uses the existing app wordmark with light lettering.

## Run

```bash
git clone https://github.com/the-medo/st.git
cd st/sm-manager
python3 -m sm_manager serve
```

Open **http://127.0.0.1:8790**. The first sample usually arrives within a few
seconds. CPU needs two samples. History starts when the collector starts; it
isn't reconstructed or backfilled. The collector runs even when the browser is
closed.

Optional installation as a command: `pip install .`, then `sm-manager serve`.
Running directly from the checkout needs no package installation.

### Faceplate night mode and `st`

Open **Devices → Faceplate → Night mode** to put the faceplate to sleep or wake
it. The switch reports confirmed screen power, including changes made from the
CLI. `on` means night mode on (screen off):

```bash
st night on
st night off
st night toggle
st night status
st night status --json
st status
```

Install the shared `st` executable with the [STapp host installer](../stapp/README.md).
`st status` reads the system monitor; `st status REQUEST_ID` reads an assistant
request. `st monitor ...` exposes the full monitor CLI, including cleanup plans.
The shared command uses the existing monitor launcher and its configuration.
`pip install .` still provides both `sm` and `sm-manager`. The service installer also
writes `~/.local/bin/sm`, pointing at the installed runtime and its configuration;
keep `~/.local/bin` on your shell's PATH. Existing installs need one reinstall
from the updated source (`install --auto-update` when using the updater).

Pair the **faceplate's** connected DRM entry once, then install/restart:

```bash
ls /sys/class/drm/
python3 scripts/manage.py pair-faceplate --connector card0-HDMI-A-1
python3 scripts/manage.py install --auto-update
```

Pairing saves an EDID SHA-256 in the local `faceplate_edid_sha256` setting. It
identifies the screen even if connector numbering changes, and refuses an
unplugged, replaced, or ambiguous screen. Do not pair the TV accidentally.

The helper discovers the active seat0 Wayland session for every action. Plasma
Desktop uses `kscreen-doctor` DPMS with other outputs excluded (requires working
`--dpms-excluded`, as in libkscreen 6.7.3). Gaming Mode uses `gamescopectl` and the
current Gamescope socket. **Gamescope cannot independently sleep two external
screens**: with another external display connected, the control is unavailable
and explains why. While the helper runs, it releases its own global sleep flag
within a few seconds if a TV is connected afterward. This is not support for a
second independent Gaming Mode output. Desktop DPMS can wake on local input;
there is no persistent night schedule, input suppression, or automatic reapply
after changing desktop/gaming sessions.

The web service retains `NoNewPrivileges=true`. A separate user service,
`sm-manager-faceplate.service`, accepts only status/on/off/toggle through a private
mode-0600 Unix socket. It needs existing noninteractive permission to run the
fixed display commands as the graphical session user when that user differs
from the monitor's account (`sudo -n -u`). Installation does not grant sudo
permissions. API writes require the same Host/Origin checks as reads, JSON, and
a process-specific request token. No username, command, or connector comes from
the browser. The helper restarts with SM Manager and its independent runtime
updates; `manage.py uninstall` removes the helper and the owned CLI launcher.

### Air quality

Set `air_quality_device` to the device's 12-character MAC address in the local
configuration (`~/.config/sm-manager/config.json`) and restart. Keep the device
identifier and collected readings out of Git. **Devices → Air quality** opens
the dashboard; the separate arrow opens M5Stack's original page. The dashboard
also links to the raw feed and the RPiShop product.

An independent worker makes a bounded HTTPS GET to M5Stack once a minute, even
when the page is closed. It stores unique publication timestamps in
`<data_dir>/air-quality.sqlite` for 30 days. The feed only supplies its latest
reading, so earlier history cannot be backfilled. Repeated timestamps are not
new samples, outages remain gaps, and readings older than five minutes are
marked stale. Unknown or invalid values, including zero gas indexes, are shown
as unavailable. Nine compact measurement cards stay in a single row, grouped by
color. Two charts show the seven air measurements (including PM4.0) and
temperature/humidity together,
side by side at a 7:2 width ratio on wide screens, with separate labeled scales
for each unit. Both charts start at six hours and have independent 1h / 6h / 12h /
24h / week / month controls and a fullscreen view (Escape exits). Each chart also
has an independent bucket selector: Auto / 1m / 5m / 15m / 30m / 1h / 6h / 1d.
Auto suits the selected range; unavailable combinations are disabled to keep
charts within 1,440 intervals and avoid buckets longer than the range. Changing
the range resets an incompatible bucket to Auto. Range and bucket controls share
a compact toolbar, using inline dropdowns in narrow panels. Reference details
are available in the collapsed chart guide. Charts show
bucket means and peaks across 1h–30d; hover/touch or arrow keys inspect all
series in a section. Clicking a card focuses its section’s chart.
Inspection shows compact green OK or orange Warning labels, the applicable
reference, and any excess in the measurement's units below each measurement.
A third row shows the reading as a percentage of that same reference (60 against
15 is 400%); percentages above 100% are bold red. Higher peaks take priority
and are explicitly labeled. Particle comparisons name the WHO 24-hour reference;
they do not assess daily exposure from a bucket. Humidity uses EPA's below-60%
ceiling and 30% ideal minimum, with differences in percentage points. Temperature,
PM1, and PM4.0 stay neutral; unavailable measurements never receive an OK label.

CO₂ bands indicate ventilation reminders, not toxic exposure. PM2.5 and PM10
card indicators compare time-weighted 24-hour averages with WHO daily references
only after 90% coverage (our display completeness rule). Each reading covers at
most two minutes, so missing time never counts as clean air. VOC/NOₓ use
Sensirion's relative purifier response bands, not concentration or toxicity
limits. Sources and sensor limitations are explained on the page.

## Keep it running

On a Linux host with systemd user services:

```bash
python3 scripts/manage.py install
python3 scripts/manage.py status
python3 scripts/manage.py logs
python3 scripts/manage.py restart
python3 scripts/manage.py stop
python3 scripts/manage.py start
```

The service is enabled at login and restarts after a failure. For automatic
startup before login, enable user lingering with `loginctl enable-linger "$USER"`
if that matches how you manage your machine. Availability depends on the host and
its user service manager being up.

### Follow main automatically

To run the remote `main` branch at boot, before login, and check for updates
every five minutes:

```bash
python3 scripts/manage.py install --auto-update
```

This enables user lingering and installs `sm-manager-update.timer`. It creates
an independent clone of this repository's `origin` in
`<deployment_dir>/checkout/sm-manager`, and runs the service there. Development
branches, uncommitted edits, and disposable worktrees do not affect the running
app. The installer retains the saved private URL, HTTPS proxy configuration,
and history. Git access must work without interactive prompts or a login-session
SSH agent; the updater uses SSH batch mode with a connection timeout.

Before each start, the installed updater fetches `main` and accepts only
fast-forward changes that pass the test suite in a temporary checkout. If the
network, credentials, or tests fail, startup uses the installed version and the
timer retries later. While running, validation happens before stopping the app;
the updater then advances the runtime checkout and starts it again. If that
live update fails its health check, it restores the previous code and starts it.
History is preserved, but database migrations are not rolled back. A manually
stopped app stays stopped during timer checks. Dirty runtime checkouts and
rewritten remote history are rejected for manual review.

After merging a branch, an agent can deploy immediately before cleaning up its
development worktree:

```bash
python3 scripts/manage.py update
python3 scripts/manage.py status
```

The same operation is available independently of any development checkout:

```bash
systemctl --user start sm-manager-update.service
journalctl --user -u sm-manager-update.service -n 70 --no-pager
```

`status` shows the deployed revision and timer. `logs` includes both the app and
updater. The updater is installed outside the development tree so cleanup cannot
remove it. After changing updater or unit-generation code, rerun
`install --auto-update` from the updated source to refresh those installed files.
To pause polling, run `systemctl --user disable --now sm-manager-update.timer`;
the startup check remains enabled. Uninstall removes both updater units and
retains the runtime clone, history, and account's lingering setting.

For a stable **private** browser URL on another computer in your tailnet:

```bash
python3 scripts/manage.py install --tailscale
```

The installer discovers the host's Tailscale DNS name and prints
`https://<host-dns>:8790`. The app still listens only on `127.0.0.1`. Tailscale
handles private network access; there is no separate app login. Any tailnet user
allowed by your ACLs to reach this host/port can read the dashboard. The helper
refuses to replace another app's Serve route and never enables Funnel.

To remove this monitor's service and its unchanged, owned Serve route:

```bash
python3 scripts/manage.py uninstall
```

Configuration and collected history are retained. Other applications and their
containers are unaffected.

## Configuration

Create `~/.config/sm-manager/config.json` (or under `$XDG_CONFIG_HOME`):

```json
{
  "port": 8790,
  "cloudbeaver_host": "db.example.com",
  "printer_url": "https://printer.example.com/",
  "roots": ["~/dev", "~/.codex/worktrees"],
  "interval": 10,
  "discovery_interval": 60,
  "scan_depth": 4,
  "zed_catalog_path": "~/zed-projects/projects.json",
  "db_catalog_path": "~/db-projects/connections.json",
  "docker_socket": "/var/run/docker.sock",
  "allowed_hosts": ["localhost", "127.0.0.1"],
  "container_overrides": {
    "my-unlabelled-db": "~/dev/my-project"
  }
}
```

Set `cloudbeaver_host` to the trusted database launcher hostname and `printer_url` to your printer dashboard HTTPS URL. Each link is optional. Restart the service after changes. `--config /path/to/config.json` before a CLI
subcommand selects another file. `codex_home` defaults to `$CODEX_HOME` or
`~/.codex`. `data_dir` defaults to `~/.local/share/sm-manager` (honoring
`$XDG_DATA_HOME`). Runtime data and machine configuration never belong in Git.

Discovery searches the configured roots, existing Codex thread/worktree paths,
and directories used by running processes and containers. It skips dependency
and build directories, then asks Git for linked worktrees. Nested repositories
are treated as separate projects when discovered through their own root/path.

### Open a checkout in Zed

Choose **Zed** in the sidebar to browse all published checkouts, including idle
ones, by project family and repository. The main checkout appears first. Each
**Open in Zed** link hands the published SSH URL to your browser's Zed handler. From
Windows, the link opens the Steam Machine directory in your local Zed client.
The icon is the white SVG logomark from [Zed's brand assets](https://zed.dev/brand#logomark).

The dashboard rereads the version 1 catalog every minute. Set `zed_catalog_path`
to use a different file. Monitor rows match catalog entries by absolute path.
For an existing checkout known only to the monitor, SM Manager uses the
catalog's `ssh_base_url` and percent-encodes the directory path. If the catalog
is unavailable, resource monitoring continues and the Zed page retries.

### Open a database in CloudBeaver

Choose **DBs** to browse the published connections by group, repository, and
worktree. External entries can supply a top-level `group` with a null `owner`.
Each group lists the published connection name and database. Entries without
an owner or group appear under **Unassigned**. The database
icon beside a checkout opens its available connection in a new tab. If several
connections match, choose the worktree and database. Project actions cover all
worktrees belonging to the same primary checkout.

SM Manager reads `db_catalog_path` every minute. The external publisher handles
discovery and CloudBeaver registration. **Configured** means a worktree declares
the database and the publisher could not verify it. After three minutes without
a new check, the DBs page shows the last reported statuses and suspends launch
actions until the catalog is fresh.

### Docker ownership

The collector uses the local Docker Engine Unix socket. The user running the
monitor must already have access. It uses only GET requests; access to the Docker
socket itself still carries the privileges of your Docker installation.

Ownership is resolved in this order:

1. An exact container name or full ID in `container_overrides`.
2. `sm-manager.worktree`, Docker Compose working-directory labels, and custom
   `.dev.path` / `.worktree-path` labels.
3. A `.worktree-path-hash` label matching the first 16 characters of the
   worktree path's SHA-256 hash.
4. Bind mounts belonging to exactly one worktree.

Conflicting or absent ownership remains visible as **unassigned**. Container
names alone are not used to guess ownership. For new containers, prefer an
explicit label:

```bash
docker run --label "sm-manager.worktree=$PWD" ...
```

Docker outages and unavailable container statistics produce a visible warning;
host and project-process monitoring continue. Remote Docker engines and Windows
or macOS collectors are not supported in this first version.

## Reading the numbers

- **CPU:** percentage of the whole host across all logical cores. One saturated
  core on an eight-core machine is about 12.5%. Process samples use `/proc` tick
  deltas with PID start times to avoid PID-reuse spikes.
- **Host memory:** `MemTotal - MemAvailable`. Project memory is summed process
  RSS plus container working set. Shared pages may be counted more than once,
  so attribution is an estimate and won't exactly reconcile to host usage.
- **Containers:** memory excludes inactive file cache using Docker's documented
  accounting. Container processes are excluded from host-process attribution by
  their cgroup identity. See [Docker's memory accounting](https://docs.docker.com/reference/cli/docker/container/stats/).
- **Running worktree:** at least one detected process or running container. A
  database-only checkout still counts as running; “idle” means neither was found.
- **Codex:** local metadata reports thread update times, not whether an agent is
  actively working. It does not estimate token costs or read conversation text.
  The local database is an optional, version-dependent integration and failures
  don't prevent resource collection.
- **History:** samples every 10 seconds by default; chart points average into at
  most about 180 time buckets (the API also includes peaks). Samples older than
  30 days are pruned each minute. A month means a rolling 30-day window, not a
  calendar month. Existing samples are preserved on upgrade; previously pruned
  samples cannot be recovered, so the longer history fills as collection continues.
  Gaps indicate the monitor was not collecting.
  SQLite reuses freed pages; the database file need not shrink after pruning.
- **Chart scale:** Zoom to usage is the default and scales to the visible series
  with headroom. Full capacity shows all installed RAM (or 100% machine CPU).
  Memory capacity remains labelled in both modes. The 15m, 1h, 6h, 24h, 7d, and
  30d ranges are available; 24h remains the default. Multi-day views show dates
  on the time axis.

## Machine health, cleanup candidates, and storage

Machine health checks refresh once a minute. Always-on protection is confirmed
when all four systemd suspend/hibernation services are masked; an unverified
state asks you to check the machine's settings. The panel never changes them.
Memory pressure measures time tasks spend stalled on memory, rather than how
much RAM is allocated. OS version/build baselines are stored locally; an observed
change is highlighted for 24 hours. No earlier OS history is reconstructed.

Cleanup candidates must currently use at least 64 MiB and have at least 15
minutes of observation in the last 30 minutes, with at least 80% sample coverage.
Average CPU must be at most 0.5% of the whole machine, with no sampled CPU peak
above 1%. Recent Codex metadata updates, unavailable container stats, and the
monitor's own worktree exclude an app. Low CPU does not establish that a service
is unused or safe to stop. Selecting candidates only copies a combined brief;
each worktree's current resources and lifecycle instructions must be revalidated.

Open **Storage** and choose **Scan project**. A single background scan runs at a
time. Scans count allocated filesystem blocks, never follow symlinks, skip mounted
filesystems, and count hard links once per project. Nested discovered worktrees
are counted separately. The filesystem phase is limited to 30 seconds per
worktree and 120 seconds / 500,000 entries per project; partial results are marked as lower bounds. Results
are cached locally across monitor restarts and include their scan time.

Docker storage uses GET requests for all containers and disk usage. Ownership is
resolved using the same labels, explicit mappings, and mounts as the resource
monitor. Associated image and named-volume sizes may overlap between projects;
shared use is labelled, and these sizes are not added to worktree disk totals.
Docker size accounting runs only for projects with owned containers, with a
separate 45-second timeout; an unavailable result does not discard filesystem totals.
Neither scanning nor copying a cleanup brief deletes anything.

Some process working directories may be unreadable due to OS permissions. Those
processes appear outside projects. CPU/RSS collection does not require root.

## Agent interface and future cleanup

```bash
python3 -m sm_manager status
python3 -m sm_manager status --json
python3 -m sm_manager cleanup-plan <worktree-id>
```

Same-origin, read-only HTTP endpoints:

| Endpoint | Result |
| --- | --- |
| `GET /api/faceplate` | Latest read-only STapp panel capture and timestamp, or null while awaiting the panel |
| `GET /api/health` | Collector readiness and sample freshness |
| `GET /api/snapshot` | Projects, worktrees, processes, containers, Codex, host |
| `GET /api/zed` | Published checkout groups with revisions and Zed URLs, plus links for monitor-only directories |
| `GET /api/dbs` | Database connections, ownership, last check time, freshness, and validated CloudBeaver links |
| `GET /api/github` | Cached GitHub sprint, backlog and open PRs; `?refresh=1` requests a background refresh |
| `GET /api/history?hours=24&entity=host` | Time-bucketed CPU and memory |
| `GET /api/air-quality?hours=6&bucket=300` | AirQ readings, per-bucket means and peaks, and daily particle averages; bucket is seconds or `auto` |
| `GET /api/cleanup-plan/<worktree-id>` | Resource identities and a cleanup brief |
| `GET /api/disk-usage` | Cached per-project scan results and current scan status |
| `GET /api/disk-usage?scan=1&project=<project-id>` | Start a bounded read-only background scan; returns 202, or 409 if another project is scanning |

History accepts `hours=0.25..720` (30 days), defaulting to 24 hours. For example,
`GET /api/history?hours=720&entity=host` returns the full month. Snapshot fields
`machine_health` and `cleanup_candidates` contain health checks and the current
review shortlist.

History entities are `host`, `projects`, `project:<id>`, or `worktree:<id>`.
IDs are stable hashes of the local Git common directory or worktree path.

An agent can use a brief to revalidate ownership, read the target repository's
instructions, and use its documented lifecycle command. PID start ticks and full
container IDs are included so a stale brief is never treated as a kill list.
The suggested cleanup preserves volumes, databases, source files, and worktrees.

## GitHub

The React console’s **GitHub** page replaces the former Codex resource page.
It shows issues assigned to the signed-in GitHub user in the current **Sprint**
iteration, including **Done** and **Delivered**. Open pull requests authored by
that user are listed across the organization, with draft state, checks,
conflicts and links. The expandable **Backlog** shows only issues assigned to
that user. It excludes Done and Delivered and includes current and older sprint
issues. Search and repository filters apply
to all three tables. Archived and inaccessible project items are omitted.

The defaults are organization `ydistri`, project `6`, sprint view `2` and backlog
view `5`. Install `gh` on the monitor host and authenticate as its service user:

```sh
gh auth login -h github.com
gh auth refresh -h github.com -s read:project
```

Private repositories also require repository access (`repo` for a classic OAuth
token); authorize organization SSO if required. Credentials remain in GitHub
CLI’s private login store or its supported environment variables, never in the
browser, repository or API response. The integration only sends GraphQL queries.
The CLI must be on the service PATH, or specify an absolute `gh_binary` below.

Optional settings in the private monitor configuration:

```json
{
  "github": {
    "organization": "ydistri",
    "project_number": 6,
    "sprint_field": "Sprint",
    "status_field": "Status"
  }
}
```

Set `github.username` to override the authenticated user. The active sprint is
determined by the iteration’s date range using the server’s local date, with an
exclusive end boundary. The sprint and backlog selection follows the rules above;
other custom GitHub view filters are not interpreted.

`GET /api/github` returns a shared, in-memory cache and starts a background fetch
on first access or after one hour. The page checks for updates while visible;
there is no scheduled fetch when nobody uses it and no issue data saved to disk.
`GET /api/github?refresh=1` requests an earlier refresh, coalescing concurrent
requests and allowing at most one refresh every 30 seconds. Failed fetches retry
after five minutes on access. Each section keeps its last successful data and
reports its timestamp/error independently. Cache resets when the monitor restarts.
Project items and PR search results are paginated; oversized or incomplete results
produce an error rather than silently replacing a good cache with partial data.

## Privacy and access

No telemetry, external fonts or CDNs. The GitHub page contacts GitHub through
the server’s authenticated CLI when requested. The UI, API, and SQLite history
stay on your machine. No command-line arguments, environment
variables, Codex prompts, authentication files, or container environment are
stored or exposed. Metadata includes local paths, branch names, container image
names, process names, and resource identities; keep dashboard access private.

The server binds to loopback, validates the Host header, rejects cross-site
requests, and sends no CORS permissions. The static server exposes only its
bundled assets. It has no mutation or shell-execution endpoint.

## Development

```bash
python3 -m unittest discover -s tests -v
python3 -m compileall -q sm_manager scripts
node --test tests/test_*_ui.js
```

The monitor backend is Python's standard library. The console and embedded Agents
use React 19, TypeScript and Vite in the pinned Bun workspace. Run `bun install
--frozen-lockfile`, `bun run typecheck`, `bun run test:unit` and `bun run build`.
The legacy HTML/CSS/JavaScript interface remains available for rollback.
See `AGENTS.md` for operating and extending the application.

The integrated preview is enabled after the console preview exists:

```sh
python3 scripts/preview-ovis.py --env-file /absolute/private/ovis-service.env --bun /absolute/path/to/bun
python3 scripts/preview-v2.py status
python3 scripts/preview-v2.py restart
python3 scripts/preview-v2.py stop
```

The environment file supplies the existing Herdr runtime, binary paths and private
sidebar catalog. It stays outside Git. The preview overrides ports, cookie names,
base path and Ovis state; it owns only its gateway, monitor and Ovis web services.
The existing Herdr terminals and managed Codex daemon remain external services.
Use `start` to restore the preview's owned Serve mapping after `stop`.
An unsuccessful initial Ovis activation restores the previous console service.

Ovis is mounted natively at `/ovis`, with its own conversation sidebar beside ST.
The frontend retains chat drafts while navigating to console pages. Its packaged
server entry omits the upstream self updater and runtime installer; deploy this
fork through ST. Native mobile-app relay hosting and Ovis's standalone root PWA
are not enabled by this preview.

Browser verification uses synthetic fixtures, including Ovis's upstream demo:

```sh
bun run test:browser
bun run test:ovis-browser
```

Install a Playwright Chromium first or set `BROWSER_EXECUTABLE` explicitly.

The updated installer/updater stages frozen Bun dependencies, type checking,
unit checks and the React build before stopping an installed service. It moves
validated assets and dependencies together with source, restores both after a
failed startup, and retains the preceding generated artifacts in its owned
`previous-artifacts` folder. `release.json` records the source revision and Bun
version. Set `SM_MANAGER_BUN` if Bun is outside the updater's PATH.

An installed updater copy and its units must be explicitly upgraded from the
updated source. Follow [Production v2 deployment](PRODUCTION_V2.md) to activate
the three production web services, preserve existing history and private ingress,
or roll back their configuration. Preview services remain independent.

For the opt-in transport check, point `ST_OVIS_HC_BIN` at an installed `hc` and run
`bun run test:terminal`. The check creates its own HOME, state, daemon socket and
terminal, exercises the real Ovis/Herdr PTY through the gateway, verifies that
stopping the web services leaves the terminal alive, then removes its own test
session. It never uses the normal Herdr session or a live Codex conversation.
