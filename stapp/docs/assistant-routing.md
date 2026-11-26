# Voice routing and agent context contract

This contract is implemented by `runtime/worker.py` and backed by the retained
classifier experiment. See [the plan](../IMPLEMENTATION.md) and
[five-model comparison](../experiments/laya/COMPARISON.md). The owner selected
hosted **Cloudflare Clef Flash**; the active catalog now records that selection.
Local decision models and their service have been removed. Frozen experiment
catalogs retain the original model metadata. Production dispatch uses this catalog; see the [native guide](assistant-native.md).

## Input to Clef Flash

Send the complete final transcript as `state`, model `clef-flash`, and a
single `choice` question whose criteria come from
[`assistant/routing/catalog.json`](../assistant/routing/catalog.json).
Send short descriptions, not manuals, credentials, file contents or tool outputs.
The experiment intentionally does not supply expected labels or evaluation tags.

```json
{
  "model": "clef-flash",
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
The expected intent is planner; Clef Flash classified this example correctly in
the 12-option evaluation. Other examples were misrouted, including two confidently
wrong decisions, so its decision remains a hint rather than a hard restriction.

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
| agents | Registered project/host list, `stapp/README.md`, target project's AGENTS instructions, Herdr session reference | Project dispatch exists; dedicated native project and Herdr sidebar visibility verified |
| system | `sm-manager/README.md`, command help, bounded fresh resource snapshot | `system_status` reads CPU/RAM and freshness; mutations still require an appropriate interface |
| databases | Database inventory contract, ownership/freshness and selected DB/schema metadata | `database_status` reads `GET /api/dbs` for connections; SQL/backup capabilities require an appropriate connector and separate permission |
| air_quality | AirQ fields/units/freshness from `sm-manager/README.md`, requested time window | `air_quality` reads `GET /api/air-quality`; no implied ventilation actuator or medical interpretation |
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
These thresholds still accept wrong decisions; see the report. Do not use
them to restrict the agent irreversibly or to announce the specific action as done.

Unknown labels, invalid probabilities, HTTP errors, timeout,
or truncation must also produce `other`. Validate against the server-owned catalog.
Record the raw answer and fallback reason separately. Do not copy a model-supplied
path, shell command, device identity or permission into an executable instruction.

Clef Flash has a documented 24,576-token context window and can silently truncate
long text to fit, so enforce an input budget before
sending; do not rely solely on a response flag. Keep provider credentials on the
coordinator. This provider choice must be explicit, including whether transcripts
may leave the machine. On a routing deadline or failure, continue through general
agent discovery rather than chaining additional classifiers.

## Cloudflare authentication and maintenance

The coordinator makes an HTTPS POST to
`https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/cloudflare/clef-flash`
with `Authorization: Bearer <token>` and the JSON above. Read the decision from
`result.answers.route`; validate the response envelope and catalog labels.
No separate Worker deployment is required.
[Model/API documentation](https://developers.cloudflare.com/workers-ai/models/clef-flash/).

The measured run used the existing **Wrangler OAuth login**, with an expiring
access token and a refresh token. `wrangler whoami` refreshed it before testing;
the benchmark itself does not refresh OAuth. This is developer authentication,
not an unattended-service credential. The connected Cloudflare tool also uses
its own authorization; that connection is not the assistant's runtime credential.

For the assistant, provision an **account-owned API token**, named
`ST assistant Clef Flash`, scoped to this account's Workers AI permissions. Follow
Cloudflare's documented Workers AI Read/Edit permission setup; do not grant DNS,
token-management or unrelated service permissions. Leave expiration unset to
avoid scheduled renewals. Account-owned tokens support Workers AI and are
independent of a user's login session. A token remains usable until revoked or
otherwise invalidated; no-expiry does not guarantee perpetual service or quota.
[Account token lifecycle](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/),
[Workers AI token setup](https://developers.cloudflare.com/workers-ai/get-started/rest-api/).

**Current setup, verified 2026-11-26:** the owner created and saved the dedicated
account token. Its account-token verification endpoint returned HTTP 200,
`status: active`, and no expiration field. Three real Clef Flash requests using
this token returned HTTP 200 and the expected `planner`, `air_quality` (Czech),
and `other` decisions in 155–156 ms. No Wrangler credentials or agents were used.
The token file is mode 0600. See [the verification record](../experiments/laya/account-token-check.json).

For a replacement token, use the Cloudflare dashboard under **Manage account →
Account API tokens**. The developer connection previously lacked permission to
create account tokens; runtime inference does not need that permission.

Private configuration has been prepared at
`~/.config/st-assistant/cloudflare.json` (outside Git, mode 0600):

```json
{
  "account_id": "YOUR_ACCOUNT_ID",
  "api_token_file": "cloudflare-ai.token"
}
```

For a fresh installation, save the dashboard's one-time secret into the adjacent `cloudflare-ai.token`
file with mode 0600. This command prompts without echoing or storing it in shell
history; run it on the coordinator after creating the token. It deliberately
refuses to overwrite an existing token; the current installation is already set up:

```sh
python3 - <<'PY'
import getpass
import os
from pathlib import Path
p = Path.home() / ".config/st-assistant/cloudflare-ai.token"
token = getpass.getpass("Cloudflare Workers AI token: ").strip()
if not token or any(c.isspace() for c in token):
    raise SystemExit("Token is empty or contains whitespace")
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as stream:
    stream.write(token + "\n")
PY
```

The classifier-only benchmark accepts this configuration; see
[the reproduction command](../experiments/laya/MEASUREMENT.md#reproduction).
The new assistant worker must use its own token file, not read Wrangler state.
Windows/Android clients authenticate to ST and never receive this credential.

Implement a two-second total routing deadline and generic-agent fallback on
missing credentials, 401/403, quota/rate limit, network failure or invalid output.
Expose router health without speaking repeated errors; stop retrying bad
credentials until replaced, honor Retry-After, and reload a replacement token.
Cloudflare routing failure must not discard the transcript or block the action
agent. These behaviors are implemented in the live worker and covered by isolated checks.

## Input to the agent

Load trusted common instructions and relevant manual excerpts separately from
the quoted user transcript. Resolve files through the catalog and registered
project paths. Keep fixed instructions stable for caching and include only the
small schemas/context needed to start. Manuals are not sent to Clef Flash.

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
    "provider": "cloudflare",
    "model": "clef-flash",
    "catalog_version": "2026-11-25-v3-clef-selected",
    "raw_choice": "planner",
    "role": "advisory"
  },
  "conversation": {"thread_id": null, "parent_request_id": null},
  "context": {
    "common_instructions": ["stapp/assistant/AGENTS.md"],
    "initial_manuals": ["stapp/docs/planner.md"],
    "capability_discovery": true,
    "available_capabilities": ["planner", "air_quality", "other"]
  },
  "reply_preferences": {"speech_max_words": 45, "full_result_in_conversation": true}
}
```

The agent verifies the requested action against the transcript and supported
reminder/task semantics, then acts or asks a necessary question. If a route is
wrong, it can obtain the correct context through capability discovery.

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
