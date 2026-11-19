# Radicale-backed ST planner

The selected calendar/task backend is Radicale. ST supplies every user interface:
the faceplate, desktop views and a future Android app with widgets. No Vikunja,
Tasks.org, DAVx5 or other client is required. Radicale stays upstream; ST-specific
behavior lives in `runtime/planner.py`, shared by MCP and HTTP clients.

## Data and service boundaries

`stapp-radicale.service` listens only on `127.0.0.1:18642` with bcrypt password
authentication. Its private `stapp/planner/` collection contains standard VTODO
tasks, VEVENT events and VJOURNAL project metadata. Each resource also carries
versioned `X-STAPP-DATA` metadata for ST's project relationships, recurrence mode,
history and operation reconciliation. The metadata is authoritative for ST;
external clients must not edit this collection. UUIDs identify planner records.

`stapp-planner.service` owns the business rules and exposes an owner-only Unix
socket at `~/.local/share/stapp/planner.sock`. A single writer lock serializes
mutations; CalDAV ETags reject stale versions. Each operation changes one complete
resource, including its completion history. A private SQLite journal records
prepared writes and results so a repeated operation does not create another
task or advance another occurrence. It is an operation log, not a second content
store. Do not run multiple planner processes against one collection.

`stappd` calls that socket asynchronously, outside its main SQLite lock. Existing
MCP operations retain the originating device/job checks. The faceplate receives
the same records and uses the same completion rules. Notes, coding workspaces and
assistant jobs stay in STapp's existing SQLite database. Personal task projects
are independent of coding workspaces.

## Current capabilities

- Create, read, update and delete tasks, events and flat named task projects.
- Task descriptions, labels, priorities (1 highest, 0 unset), due dates and
  subtasks within the same project. Cycles and deletion of referenced parents or
  projects are rejected. Completing a parent does not complete its subtasks.
- All-day or zoned events with optional end time; all-day ends are exclusive.
- Daily, weekly, monthly and yearly task recurrence, intervals, weekly weekday
  selection, optional occurrence count or end date.
- Due-date recurrence advances **one scheduled occurrence** at a time, even when
  overdue. Monthly day 31 skips months without day 31. Zoned schedules retain
  wall time across DST; nonexistent scheduled local times are skipped.
- Completion-date recurrence measures an interval from the server-confirmed
  completion time. All-day tasks stay all-day. Monthly intervals clamp to month
  end, so January 31 plus one month becomes February 28/29.
- Completion history retains the last 256 entries and a total completion count.
  Deletion uses a tombstone, so interrupted deletes are also reconcilable.
- A completed task can be reopened. This does not undo earlier history. A
  recurring task that advances is already open at its next due date; completion
  is not a toggle that can silently undo the previous occurrence.

Recurring calendar events, reminders/notification scheduling, attachments,
comments, project nesting, bulk import from external accounts, mobile pairing,
mobile offline synchronization and the Android application are future work.
The current faceplate lists and edits task titles and completes occurrences;
project/recurrence editing is available through MCP/HTTP, not yet a screen form.

## HTTP and MCP contract

HTTP remains behind STapp's existing Tailscale owner identity or panel bearer
credential. Radicale credentials never reach the browser or MCP process.

- `GET /api/planner`: current `records`, `projects`, `status`.
- `POST /api/planner`: `{action, args, idempotency_key}`. Actions are `save`,
  `complete`, `delete`. Reuse the same key and exact arguments after a timeout.
  Use a new UUID per intentional action.
- Existing `GET /api/display` and SSE `/api/events` include planner records.
- Existing `POST /api/records/{id}` handles a title edit or completion from the
  faceplate. It derives a retry key from the record ID, expected version and edit.
- `version` is an opaque ETag string for planner objects; local notes retain
  integer IDs and versions. Existing-object writes must send the current version.
  Stale writes return 409. Do not automatically reload and replay a completion
  with a newer version: that would intentionally complete the next occurrence.
- `list_records`, `get_record`, `save_record`, `complete_task`, `delete_record`,
  `list_task_projects`, `save_task_project` expose the same backend through MCP.

Example HTTP save arguments:

```json
{
  "action": "save",
  "idempotency_key": "a-new-client-generated-uuid",
  "args": {
    "kind": "task",
    "title": "Check printer filter",
    "due": "2026-11-23",
    "zone": "Europe/Prague",
    "priority": 2,
    "labels": ["printer"],
    "recurrence": {"frequency": "weekly", "interval": 1, "mode": "completion"}
  }
}
```

Optional task `project_id` and `parent_id` refer to planner UUIDs. Use null to
clear these, `due`, or `recurrence`, and `[]` to clear labels. For due-mode weekly
recurrence, `weekdays` accepts MO through SU. `count` includes the initial
occurrence; `until` uses the same date/time type as `due`. Changing the schedule
starts a new recurrence sequence; renaming it preserves the schedule and count.

Listings omit full history; `get_record` returns it. Reads are cached for at most
three seconds. A successful mutation invalidates this cache. If the planner is
unavailable, the daemon's display retains its last in-memory records and marks
`planner_status=unavailable`; the faceplate disables edits. Agent reads/writes
fail explicitly. This display cache does not provide mobile offline writes.

## Installation and upgrade

Use a Python 3.11+ installation with venv/pip support. The installer pins dependencies in a separate venv,
keeps credentials outside the repository and enables both systemd user services.

```sh
scripts/cargo build --release --locked
(cd apps/kiosk && npm ci && npm run build)
/path/to/python3 scripts/install-radicale
```

Before the first switch, check that no assistant job is running, stop
`stapp-worker` and `stapp`, then run `python3 scripts/migrate-planner`. It copies
existing local tasks/events with deterministic operation keys, keeps their source
rows, and creates `~/.local/share/stapp/pre-planner.sqlite`. A second identical
run does not duplicate records. Notes are untouched. Migrate while the old store
is stopped; changes made to source records after migration are not synchronized.

Add `STAPP_PLANNER_SOCKET=/home/YOUR_USER/.local/share/stapp/planner.sock` to
`~/.config/stapp/integrations.env`, preserving other settings and mode 0600, then
run `scripts/install-host` to install and restart the built STapp. Services run
from `~/.local/lib/`, independently of this Git worktree. Future backend upgrades
run `scripts/install-radicale` again; STapp upgrades use `scripts/install-host`.

Verify `systemctl --user status stapp-radicale stapp-planner stapp stapp-worker`,
an authenticated `GET /api/planner`, and the private faceplate. Keep user
lingering enabled for startup before interactive login.

## Backups and rollback

Back up `~/.config/stapp/planner.json`, `~/.config/stapp/radicale/`,
`~/.local/share/stapp/radicale/`, the planner operation journal,
`planner-migration-id`, and the existing ST data. Stop the planner and Radicale
for a consistent filesystem copy. Treat these backups as private: they contain
credentials and personal data. Back up operation results together with content
so retries still reconcile after restoring.

To return to the former local-store behavior, stop the worker/daemon, remove
`STAPP_PLANNER_SOCKET` from their environment, and restart them (or reinstall a
previous STapp build). The preserved local rows reappear. This does **not** copy
new or changed Radicale records back into SQLite; retain the Radicale backup
until any newer records have been exported. No external account migration has
been performed by this installer.

## Verification

`python3 tests/integration.py` covers existing device routing, UI edits and MCP.
Run `python tests/planner.py` in a venv installed from
`runtime/planner-requirements.txt`. It starts real isolated Radicale and STapp
processes and checks authenticated CalDAV, task relationships, DST and recurrence,
concurrent completion, stale versions, lost-response recovery, migration,
HTTP/MCP access and an unavailable planner. All test stores are temporary.
