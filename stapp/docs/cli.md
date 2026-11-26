# ST command line

`st` and `stctl` expose the same commands. Run `st --help` or add `--help` to a
command. Assistant and planner commands print JSON, including full IDs and
versions, so scripts can use `jq`. Agents and monitor listings print tables by
default and accept `--json` for complete records.

Install the updated STapp daemon and CLI together using the normal
[host installation](../README.md#install-or-update-the-host). The Agents,
worktree and container commands also require the updated SM Manager Python
package/launcher; Agents requires the ST v2 gateway. These commands use its
configured loopback port and existing authentication. They do not read agent
state databases or change service configuration.

## Planner tasks

```sh
st tasks list
st tasks list --project PROJECT_ID --label home --search printer
st tasks list --done
st tasks list --all
st tasks add "Replace printer filter" --due 2026-12-01 --zone Europe/Paris \
  --priority 2 --label home --body "Check both filters"
st tasks add "Clean printer" --due 2026-12-01 --repeat weekly \
  --interval 2 --weekdays TU,FR --count 8 --project PROJECT_ID
st tasks add "Remove cover" --parent TASK_ID --project PROJECT_ID
st tasks get TASK_ID
st tasks edit TASK_ID --title "Replace both filters" --priority 1
st tasks edit TASK_ID --clear-due --clear-repeat --clear-labels
st tasks edit TASK_ID --clear-project --clear-parent
st tasks complete TASK_ID
st tasks history TASK_ID
st tasks reopen TASK_ID
st tasks delete TASK_ID
```

Lists include hidden projects, default to open tasks, and sort by due date.
Project and parent arguments are exact planner IDs. Priority 1 is highest; 0 is
unset. Repeated `--label` flags replace the label set. Omitted fields remain
unchanged. `--clear-*` flags explicitly remove optional values.

Recurrence supports daily, weekly, monthly and yearly intervals; `--count` or
`--until` can end a series. `--repeat-mode due` follows the scheduled dates and is
the default. The legacy backend also accepts `--repeat-mode completion`, which
counts the interval from completion. The shared DAVe backend rejects completion
mode. The backend validates dates, IANA zones, subtasks and recurrence combinations.

`complete` records **one occurrence** and advances a recurring task. `reopen`
reopens the current record; it does not roll back recurrence history. `history`
reads the full task including the history available from the selected backend.

## Calendar

```sh
st calendar list --from 2026-12-01 --to 2026-12-07
st calendar list --search dentist
st calendar add "Dentist" --starts 2026-12-02T10:00 --ends 2026-12-02T11:00 \
  --zone Europe/Paris --body "Bring the appointment letter"
st calendar add "Away" --starts 2026-12-05 --ends 2026-12-08 --zone Europe/Paris
st calendar get EVENT_ID
st calendar edit EVENT_ID --starts 2026-12-02T11:00 --ends 2026-12-02T12:00
st calendar edit EVENT_ID --title "Dentist checkup"
st calendar delete EVENT_ID
```

Use dates for all-day events and ISO date/times for timed events. All-day end
dates are exclusive: the example covers December 5–7. A new event requires an
explicit IANA zone. Listing bounds are inclusive local dates in each event's
saved zone; events spanning the requested dates are included. Listings use the
planner's available occurrence window. Recurring calendar creation is not exposed.

## Notes and task projects

```sh
st notes list --search printer
st notes add "Printer setup" --body "Use the PETG profile"
st notes add "Meeting notes" --body-file ./meeting.txt
printf 'First line\nSecond line\n' | st notes add "Checklist" --body-file -
st notes get NOTE_ID
st notes edit NOTE_ID --title "Printer settings"
st notes edit NOTE_ID --body-file ./updated.txt
st notes delete NOTE_ID

st planner projects list
st planner projects add "House" --color '#4f9f80' --visible true
st planner projects get PROJECT_ID
st planner projects edit PROJECT_ID --title "Household"
st planner projects edit PROJECT_ID --visible false
st planner projects delete PROJECT_ID
```

These are the local STapp notes shown on the faceplate, with integer IDs. Notes
remain available when the planner service is offline. Titles and bodies are
searched without case sensitivity; an empty `--body ''` clears the body.
`--body-file` works for task, event and task-project descriptions too.

Task projects are separate from the coding workspaces listed by `st projects`.
Visibility changes apply to all faceplates. Renaming preserves color and
visibility. The backend refuses to delete projects that still contain tasks or,
with DAVe, other archived content.

`st planner tasks ...`, `st planner calendar ...`, and `st planner notes ...`
are equivalent to the top-level commands. `st planner list` returns the combined
task, event and local-note listing.

## Edits and retrying a lost reply

Edits, completions and deletions read the current record and send its version.
Concurrent edits fail instead of overwriting the other writer. Scripts that
already read a record can pin their edit with `--version VERSION`; the CLI still
checks the record kind and sends the supplied version unchanged. Notes use
integer versions; planner records use opaque version strings.

Each CLI write carries a unique operation key. If a reply is lost, the error
prints the exact JSON request, including its original key, arguments and version.
Save **that JSON object** to a private file and replay it through the same
connection and device:

```sh
st rpc @/private/path/retry.json
# Or supply the exact JSON on stdin:
st rpc @-
```

Do not rerun `tasks complete TASK_ID` after an uncertain result: that command
reads the next version and could complete another occurrence. The planner's
receipt rules determine whether a retry returns a saved result or requires
reconciliation. Notes also keep durable receipts, including across daemon
restarts. Writes are never automatically retried.

Planner commands require the configured planner service; they fail explicitly
if it is not configured instead of creating legacy SQLite tasks. Planner and
note commands require local owner access. Paired assistant bridges retain their
assigned identity and cannot issue unbound planner writes. From another machine,
use an ordinary owner SSH session, for example `ssh HOST st tasks list`.

## Agents

```sh
st agents                         # Agent panes on the local machine
st agents list --status working
st agents list --all --search st  # Include shell panes
st agents list --workspace WORKSPACE_ID --json
st agents machines
st agents --machine MACHINE_ID list
st agents kinds
st agents workspaces
st agents show PANE_ID
st agents read PANE_ID --lines 100
st agents read PANE_ID --source visible
st agents conversation PANE_ID --json
st agents conversation PANE_ID --before CURSOR --json
st agents conversation CONVERSATION_ID --json
st agents conversation 'https://your-st-host/agents?saved=CONVERSATION_ID' --json
st agents plan PANE_ID
st agents tasks PANE_ID
st agents prompt PANE_ID
st agents answer PANE_ID PROMPT_ID --option 0
st agents answer PANE_ID PROMPT_ID --text "Use the existing branch"
st agents rename PANE_ID "ST CLI implementation"
st agents start --cwd /absolute/project/path --agent codex --label "CLI work"
st agents input PANE_ID "Review the CLI changes"
st agents keys PANE_ID Enter
```

Use exact pane, workspace and machine IDs from the listings. `--machine` and
`--json` can appear before or after the Agents subcommand. `machines` always
lists the gateway's machine roster. Other commands default to `local`.

The Agents sidebar menu can copy a stable conversation link or ID. Pass either
to `st agents conversation` to read its saved history, including done or archived
conversations without a running terminal. Links resolve through the configured
local ST gateway; the CLI never fetches the supplied URL. This requires the
conversation to belong to that gateway. `--before` also pages saved history.

`start` creates a workspace and starts an agent in it. It accepts repeated
`--arg` values (use `--arg=--flag` for an argument starting with `-`) and an
optional agent `--name`. It returns the workspace and pane IDs, including when
the workspace was created but the agent failed to launch. Inspect that workspace
before repeating a failed start.

`input` types a single line without adding Enter; use `-` to read it from stdin.
It rejects embedded terminal control characters. `keys` is a separate explicit
action and accepts the terminal backend's key names, such as `Enter` and
`ctrl+c`. Answer interactive questions with `prompt` and `answer`: answers are
bound to the current prompt ID and option indexes start at zero. Terminal reads
do not attach, resize or focus a pane. Plain terminal output strips control
sequences; JSON preserves the server's data as escaped strings.

Agents commands run on the host through SM Manager, not through a paired
`--ssh` assistant bridge. Use `ssh HOST st agents ...` for remote owner access.
`st monitor --config /private/config.json agents ...` selects another local
console configuration for development.

## Assistant requests and resources

```sh
st requests --limit 30
st requests --project stapp --status waiting
st pending
st answer REQUEST_ID "Saturday"
st status REQUEST_ID
st inbox --after SEQUENCE
st projects
st ask --project stapp "Review the current changes"
st ask --parent REQUEST_ID "Explain the result"

st worktrees --running
st worktrees --project st --search feature --json
st containers --project st
st containers --json
st cleanup-plan WORKTREE_ID
st status
st night status
```

Requests, pending questions and inbox events stay scoped to `--device` (owner by
default). Request lists are newest first, capped at 200 per call, and include IDs,
prompts, status, coding workspace and thread IDs. Existing `ask --id UUID` retries
and device delivery behavior remain supported.

Resource listings use the latest monitor snapshot, keep ownership information,
and warn when the sample is stale. Container output includes unassigned
containers unless filtered by project. These listings and `cleanup-plan` do not
stop services, remove worktrees, or delete containers.

## Development checks

From `stapp`, build the kiosk and release binaries as documented in the README,
then run `python3 tests/cli.py`, `python3 tests/integration.py`, and the planner
venv's `python tests/planner.py`. CLI tests use isolated sockets and temporary
STapp/Radicale instances. From `sm-manager`, run
`python3 -m unittest discover -s tests -v`; Agents CLI tests use an isolated HTTP
fixture, with no live terminal input or service control.
