# Voice routing and agent context contract

This is a design contract backed by a classifier-only experiment. It is not yet
wired into `runtime/worker.py`. See [the plan](../IMPLEMENTATION.md) and
[five-model comparison](../experiments/laya/COMPARISON.md). The proposed next
default is hosted Cloudflare Clef Flash; local Unsloth remains an explicit option.
The catalog's `model` field retains the original local evaluator default; the
comparison runner selects providers/models separately. No production provider
configuration has been wired up yet.

## Input to Laya

Send the complete final transcript as `state`, model `laya-multilingual`, and a
single `choice` question whose criteria come from
[`assistant/routing/catalog.json`](../assistant/routing/catalog.json).
Send short descriptions, not manuals, credentials, file contents or tool outputs.
The experiment intentionally does not supply expected labels or evaluation tags.

```json
{
  "model": "laya-multilingual",
  "state": "Remind me tomorrow to check the air quality.",
  "questions": {
    "route": {
      "type": "choice",
      "instructions": "What action does the user want? Select the best assistant capability, or other if none fits.",
      "criteria": {
        "planner": "Create, edit or list tasks, reminders and calendar appointments.",
        "air_quality": "Read or compare indoor air sensor measurements.",
        "other": "General questions or none of the available capabilities."
      }
    }
  }
}
```

The three-option snippet illustrates the shape; the experiment uses all 12.
The expected intent is planner, but the measured model misroutes this example.
Its decision must therefore remain a hint, not a hard restriction.

Future optional questions include `is_followup`, `has_multiple_requests`, and
`needs_live_data` (`noul` probabilities). These have not been benchmarked here.
Prefer the server's pending-conversation state over guessing continuation from
text. Never let a classifier decide whether a destructive action is authorized.

## Capability map

All file paths below are relative to the repository root. Catalog `tools` entries
describe existing or proposed interfaces; they are not executable commands or an
automatically granted allowlist. Inspect actual runtime capability availability.

| Route | Context to load for the agent | Current boundary |
| --- | --- | --- |
| planner | `stapp/docs/planner.md`, planner schemas in `stapp/runtime/mcp.py`, current date/timezone, selected list/calendar IDs | Tasks/events through DAVe/Radicale business API; versioned edits and idempotent recurrence; reminders are not fully implemented |
| notes | Note schema from `stapp/runtime/mcp.py`, note storage behavior, relevant search results | Existing local notes; do not confuse personal notes with scanned documents |
| agents | Registered project/host list, `stapp/README.md`, target project's AGENTS instructions, Herdr session reference | Project dispatch exists; Herdr-native creation/resume needs integration verification |
| system | `sm-manager/README.md`, command help, bounded fresh resource snapshot | `st status`, `st monitor cleanup-plan` exist; assistant adapter and mutations need deliberate implementation |
| databases | Database inventory contract, ownership/freshness and selected DB/schema metadata | `GET /api/dbs` lists connections; SQL/backup capabilities require an appropriate connector and separate permission |
| air_quality | AirQ fields/units/freshness from `sm-manager/README.md`, requested time window | `GET /api/air-quality`; no implied ventilation actuator or medical interpretation |
| display | `stapp/README.md`, view schemas, selected physical panel identity | `show_view`, `save_view`, `publish_app`, `st night`; arbitrary brightness is not implemented |
| photos | `stapp/docs/immich.md`, album/search tool schemas, configured account scope | Existing list/search/show; cannot delete/upload photos or alter sharing |
| shopping | `stapp/assistant/.agents/skills/shopping/SKILL.md`, configured Rohlík tool schemas and cart context | Search/cart when authorized; checkout remains a distinct operation |
| printing | Owner's `3d-print-stuff/AGENTS.md` and linked printer/material notes, selected job/model references | External setup: resolve registered project path; status/upload adapter still needed; physical print requires explicit request |
| documents | Configured Paperless connector/manual, search terms and selected document references | External setup: homepage link/source alone supplies no document actions |
| other | Common assistant instructions, small capability summaries and available discovery tools | General reasoning, research, unavailable capabilities, ambiguous or compound requests |

Domain selection follows the requested action. “Create a task to buy milk” is
planner; “buy milk on Rohlík” is shopping. “Fix the planner save button” is agents.
“Show a holiday photo on the panel” starts with photos and can add display context.
Mixed independent requests should use the general coordinator with several
capabilities, not silently drop all but the most likely route.

## Effective routing policy

The experimental threshold is top probability >= 0.65 and top-two margin >= 0.20.
Below either, choose `other` for context discovery. Explicit `other` is always valid.
These thresholds still accept many wrong decisions; see the report. Do not use
them to restrict the agent irreversibly or to announce the specific action as done.

Unknown labels, invalid probabilities, HTTP errors, timeout, model-loading failure,
or truncation must also produce `other`. Validate against the server-owned catalog.
Record the raw answer and fallback reason separately. Do not copy a model-supplied
path, shell command, device identity or permission into an executable instruction.

The multilingual checkpoint has 1,024 total tokens and a smaller question/options
budget. The installed Unsloth version refuses oversized option/instruction heads;
its public endpoint returns HTTP 422 when long state would be truncated. The
coordinator must count tokens or conservatively bypass, and handle that error
without losing the full agent transcript. Check truncation flags too if a future
provider includes them in successful responses.

For hosted Clef Flash, use the same question/criteria with model `clef-flash`
through the coordinator's configured Workers AI account. Its documented behavior
can truncate long text to its context window, so enforce an input budget before
sending; do not rely solely on a response flag. Keep provider credentials on the
coordinator. This provider choice must be explicit, including whether transcripts
may leave the machine. On a routing deadline or failure, continue through general
agent discovery rather than chaining additional classifiers.

## Input to the agent

Load trusted common instructions and relevant manual excerpts separately from
the quoted user transcript. Resolve files through the catalog and registered
project paths. Keep fixed instructions stable for caching and include only the
small schemas/context needed to start. Manuals are not sent to Laya.

Conceptual envelope (not an already implemented endpoint):

```json
{
  "request_id": "client-generated-idempotency-uuid",
  "origin": {"device_id": "authenticated-room-id", "reply_channel": "room"},
  "received_at": "2026-11-25T20:00:00+01:00",
  "timezone": "Europe/Paris",
  "language": "en",
  "transcript": "Remind me tomorrow to check the air quality.",
  "routing": {
    "provider": "local-unsloth",
    "model": "laya-multilingual",
    "catalog_version": "2026-11-25-v2-experiment",
    "raw_choice": "air_quality",
    "role": "advisory"
  },
  "conversation": {"thread_id": null, "parent_request_id": null},
  "context": {
    "common_instructions": ["stapp/assistant/AGENTS.md"],
    "initial_manuals": ["sm-manager/README.md#air-quality"],
    "capability_discovery": true,
    "available_capabilities": ["planner", "air_quality", "other"]
  },
  "reply_preferences": {"speech_max_words": 45, "full_result_in_conversation": true}
}
```

The agent sees that this is actually a planner request, obtains planner context
and the supported reminder/task semantics, then acts or asks a necessary question.
The initial hint must not lose the transcript or force an air sensor query.

Carry entity IDs/current versions only from trusted context or confirmed reads.
Use a dedicated context budget (initial target: <= 2,000 tokens excluding the
transcript), with discovery for expansion. Include source timestamps for live
data and report stale/unavailable readings rather than inventing current values.

## Result and acknowledgement

After durable enqueue, issue exactly one cached acknowledgement. Keep wording
generic until routing earns sufficient accuracy on independent real utterances.
Completion and clarification are separate events tied to the request/device.

```json
{
  "request_id": "same-idempotency-uuid",
  "status": "completed",
  "display_text": "The confirmed task details and a link to the planner.",
  "speech_text": "I added the task for tomorrow.",
  "confirmed_effects": [{"tool": "save_record", "record_id": "backend-id"}]
}
```

Only a confirmed task creation justifies that example speech. A due task is not
automatically a scheduled notification; the assistant must preserve that distinction.
