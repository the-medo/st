# S.T. voice assistant implementation plan

Status: coordinator implemented and deployed; native desktop clients implemented,
with hardware acceptance still pending (2026-11-26). Rebased onto main `5680bd8`,
including the CLI and conversation-feedback changes. See the
[native guide](docs/assistant-native.md) and [validation report](docs/assistant-validation.md).

This replaces the earlier six-step plan. The assistant introduced in commit
`bc065262bb9470951de31b07d6696670b3906aa4` remains the starting point. Preserve
working transport, planner rules, device ownership and durable job history.

## Product scope

1. A capability catalog and reproducible 100-transcript evaluation across local
   Unsloth models and hosted Clef Flash. See [the comparison](experiments/laya/COMPARISON.md).
2. A coordinator that uses routing as a context hint, runs Luna in a dedicated
   assistant project, and returns compact, confirmed results.
3. A background Rust Steam Machine client activated by **Hey ST** or **Okay ST**.
4. A minimal background Rust Windows client using the same phrases, showing a
   small recording popup and requiring no interaction during normal operation.
5. Later: an Android home-screen microphone widget, without a wake phrase.
   See [future work](docs/assistant-future.md).
6. A skill explaining how agents extend the assistant's capabilities.

The catalog now drives live dispatch, context selection and discovery. Desktop
client binaries, installers and automated audio checks are implemented; physical
Linux/Windows microphones and dual-device acceptance remain required.

The [five-model comparison](experiments/laya/COMPARISON.md) supports the selected
**Cloudflare Clef Flash**: 97/100, 190 ms median, 448 ms p95, and no resident local
decision model. Keep routing advisory, generic acknowledgements and capability
discovery: even Clef Flash produced confidently wrong routes. All four local
model caches and their service have been removed; benchmark evidence is retained.
The live worker now uses this provider. The owner supplied a dedicated account API token;
verification and three real Clef Flash requests passed on 2026-11-26. The token
is active and the verification response reports no expiration. The original
100-case benchmark used Wrangler OAuth. See the
[authentication setup](docs/assistant-routing.md#cloudflare-authentication-and-maintenance).

## Existing implementation: retain or replace

| Component | Existing behavior | Decision |
| --- | --- | --- |
| `apps/stappd/src/store.rs` | SQLite jobs/events, device isolation, idempotency, worker leases, follow-ups | Retain; add routing and output events with migrations |
| `crates/st-core`, `runtime/transport.py` | Paired forced-command SSH bridge and device inbox | Retain protocol semantics; move endpoint supervision into Rust |
| `apps/st-voice` | Rust CPAL capture, mono/16 kHz conversion, wake claim and submission | Extend shared native core; improve streaming resampling |
| `runtime/speech.py` | Python sherpa keyword spotting and Whisper-base; Hey ST variants; RMS endpointing; ~11-second cap | Replace endpoint runtime with Rust bindings; add Okay ST, VAD and longer dictation |
| `runtime/client.py` | Python supervision, Windows tray notifications, room-only Piper output; subprocess per reply | Replace with native lifecycle/UI/playback; keep voice models warm |
| `runtime/worker.py` | Keyword shortcut, optional Cloudflare Granite router, general fallback; app-server launched per job | Replace routing with the selected decision provider/general fallback; warm app-server; explicitly select Luna/low |
| `runtime/mcp.py`, planner adapters | Authenticated tools and recurrence/version rules | Retain; select capability tools and provide discovery/clarification |
| Herdr dictation | Browser recording; optional OpenAI transcription/polishing; browser recognition fallback | Reuse browser UX/contract where useful; native clients own their audio |
| Herdr integration | Project/conversation visibility and native session bridging | Reuse backend APIs; do not automate terminal keystrokes |
| `assistant/AGENTS.md` | Brief replies and domain rules | Retain common rules; progressively load detailed manuals |

The legacy worker remains available through an explicit rollback profile. The
current worker uses the 12-route catalog, selected dynamic tools and discovery.
The CLI has now landed on main; use `stapp/docs/cli.md` alongside the business API
schemas. A Prusa/Paperless dashboard link remains distinct from a callable tool.

## Request flow

`local wake → capture/VAD → transcription → durable submission → decision hint →
context selection → Luna/tools → confirmed result → local speech`

Endpoint states: `idle → listening → transcribing → submitted → acknowledged →
working → speaking → idle`. Also handle `waiting_for_answer`, `cancelled`,
`offline` and `error`. The server is authoritative after submission.

1. Keep a short in-memory pre-roll. Local keyword detection opens an utterance;
   push-to-talk can enter the same flow. Give immediate local recording feedback.
2. Finalize transcription after VAD silence with a configurable maximum such as
   120 seconds. Reject empty/silent takes and preserve the full transcript/language.
3. Submit an idempotency UUID, capture times, locale, IANA timezone and optional
   pending-request reference. The authenticated bridge owns device identity.
4. Resolve pending clarification and continuation before classification. A bare
   “yes” is not a new command; identify the request if several are pending.
5. Call Cloudflare Clef Flash with transcript and short criteria. Persist
   raw result, effective route, provider/model/catalog revision and timings.
6. Select trusted context, durably enqueue the agent turn, then issue one routing
   acknowledgement. Routing selects context; it does not grant permissions.
7. Execute through the integration's business API. Persist results before claiming
   success; deliver full text and a compact spoken answer to the origin device.

Retain existing overlap/wake-claim arbitration when both microphones hear the
same command. Test physical overlap before changing PC/room priority. Deduplicate
acknowledgements and speech by event ID. Lost replies or retries must not create
another action. Cancellation stops pending work and speech, without pretending
already confirmed mutations have been undone.

## Routing and context

The 12 options are `planner`, `notes`, `agents`, `system`, `databases`,
`air_quality`, `display`, `photos`, `shopping`, `printing`, `documents`, and
**`other`**. Their readiness, manuals and interfaces are in
[the catalog](assistant/routing/catalog.json). The
[routing contract](docs/assistant-routing.md) specifies the agent envelope.

`other` is a first-class general assistant: it discovers capabilities, researches
questions, asks for missing information, and handles requests beyond ST's current
integrations. An unavailable adapter produces a concrete limitation, not a false
success or a rejection merely because there is no dedicated route.

Start with one choice question. Evaluate boolean questions for multiple intents
or continuation independently before adding them to every request. Probabilities
are model estimates, not authorization or calibrated correctness guarantees.
Uncertain answers fall back to discovery; Luna always sees the original transcript
and can request more context or correct the route.

Long transcripts need an explicit token budget. Never silently discard the tail
to fit the classifier. If the request cannot fit intact, bypass to `other` and
give the agent the full transcript. Do not add a summarization model just to fit
the decision model. Hosted Clef Flash can truncate long text to fit,
so enforce its input budget before sending rather than relying on an error.
Also reject truncation flags if a provider returns them in a successful response.

## Shared Rust audio core

Keep CPAL device enumeration/capture and use a shared Rust state-machine crate
with thin Linux and Windows shells. Prototype sherpa-onnx's Rust API or a small
C ABI wrapper for keyword spotting, VAD and ASR; verify exact binding coverage.

- Support Hey ST and Okay ST with phonetic variants. Persist tokenized keyword
  assets rather than rewriting them on every launch.
- Start with the existing small keyword model and multilingual Whisper-base.
  Benchmark stronger recognition if Czech, names or technical words fail.
- Keep ASR resident or preload on wake. A later provider interface can reuse
  `gpt-transcribe` when explicitly configured. Endpoint clients call the
  coordinator; only the coordinator holds the Cloudflare credential.
- Replace RMS-only endpointing with VAD, pre-roll and hangover. Test quiet speech,
  pauses, fans, TV and game sound. Never execute on interim transcription.
- Package pinned native libraries/model checksums. Released desktop clients
  should not require Python; a temporary compatibility backend is acceptable
  during migration.
- Bound queues, detect dropped audio, and reopen devices after disconnect/resume.

Linux runs as a user service in the account owning PipeWire. Select a stable
microphone and speaker sink. Test login, Desktop/Gaming Mode, suspend, HDMI changes
and concurrent game sound. Deploy independently of the web updater/classifier.

Windows starts in the interactive user session at sign-in, without a console.
A small native popup shows recording/transcribing state and microphone activity
without taking keyboard focus. Keep errors short and diagnostics local. Normal
operation requires no tray interaction; retain deliberate mute/exit/stop controls
for maintenance. Initial onboarding still needs microphone permission and pairing.
Use a native Windows shell around the shared core, not a full browser interface.

## Acknowledgements and output

Play a short earcon at capture start/end. After routing and enqueue, use cached
speech such as “I’ll check your planner” or “I’ll take a look.” Avoid completion
claims until tools confirm them. Given the measured routing errors, initially use
generic wording for all routes; enable domain-specific wording only after fresh
evaluation earns it. Replace today's immediate “Got it” event instead of speaking
two acks.

Ask the agent for these outputs in the same turn:

- `display_text`: the complete useful result with links and technical detail.
- `speech_text`: one or two sentences, normally at most 45 words, in the user's
  language; retain dates, amounts, failures and required choices.
- `status`: completed, waiting, failed or cancelled, verified against execution.

Avoid another model call for routine summarization. Validate output before TTS;
for complex results announce the outcome and refer to the complete conversation.
Do not read reasoning, shell logs, code blocks or repeated progress messages.

Retain Piper initially, with resident voices, including a Windows implementation.
Evaluate a native sherpa-compatible TTS runtime during packaging. Cache common
acknowledgements per language/voice. Queue speech per device and use its chosen
output; multiple jobs must not speak over one another.

First release is half-duplex: suppress normal capture during assistant speech to
avoid self-triggering, with an explicit stop control. Natural spoken interruption
requires echo cancellation and separate acceptance work.

## Agent execution and Herdr

When dispatch implementation begins, create one assistant workspace/project and
keep a long-lived app-server connection. Start with `gpt-6-luna`, low reasoning,
after checking installed-client availability. Escalate complex work explicitly.

Each independent request starts a conversation; clarification/follow-up resumes
its thread. Persist `request_id → thread_id → origin_device`; do not make one
global household chat. Coding work can create a child in the actual checkout.

Use Herdr's supported backend/session integration so conversations are visible
and resumable. Verify registration as an integration spike; starting a Codex
thread in the old worker alone does not prove it appears correctly in Herdr.

Initially load common instructions plus selected manual excerpts/tool schemas.
Provide a small capability-discovery tool for additional context. Preserve planner
recurrence and concurrent-edit rules. Purchases, printing and destructive actions
follow actual tool permissions and user intent, never classifier risk estimates.

## Implementation phases and acceptance

| Phase | Work | Gate |
| --- | --- | --- |
| 0: experiment | Four local models plus hosted Clef Flash, frozen corpus/catalog, 100 cases each | Real HTTP answers, revisions, CPU/RAM and separate initialization, zero agent calls |
| 1: coordinator (deployed) | Clef Flash with dedicated account token, context builder, fallback, additive job events | Missing/revoked token, timeout/outage/quota/bad response/long input use general routing; retries deduplicate |
| 2: text agent path (verified) | Dedicated project, warm app-server, Luna/low, selected tools, compact output | Isolated planner/store tests; Herdr visibility; origin-thread follow-ups |
| 3: Steam Machine (software ready) | Native wake/VAD/ASR/TTS and both phrases | Seat/mic recordings, false wakes, game noise, reconnect, Gaming Mode |
| 4: Windows (software ready) | Packaged native core, popup, startup and speech | Native test machine; no focus stealing; suspend/mic removal/server disconnect |
| 5: household rollout (hardware pending) | Dual-mic arbitration, real tasks, speech queue and failure handling | One action/reply per intended request; each device independently usable |
| Later: Android | Widget/app/pairing | Separate lifecycle and permissions acceptance |

Measure end-of-speech to transcript, classification, context preparation, agent
startup/first useful tool/result, and speech first-sample separately. Initial
product goals: wake feedback under 150 ms and routing acknowledgement within two
seconds of final transcription in the common case. These are targets, not measured
end-to-end results. Track p50/p95 and resource usage while a game runs.

Written transcripts do not validate microphones, ASR or wake words. Add an
independent recorded-audio set. Do not call tuning on the development corpus
held-out accuracy; obtain fresh examples before route-dependent tool restriction.

## Resource policy for occasional use

Clef Flash was selected using [the resource benchmark](experiments/laya/COMPARISON.md).
Measure microphone wake detection,
ASR and TTS separately; routing measurements do not describe the full assistant.

- Keep only the wake listener continuously active on endpoints. Measure its idle
  CPU and RAM as part of desktop acceptance.
- Use hosted Clef Flash without a local decision-model daemon. Speech recognition,
  wake detection and speech output have separate resource budgets.
- Give routing an initial two-second total deadline, then pass the full transcript
  to general-agent discovery. Tune the deadline against end-to-end measurements.
- On 401/403, stop repeated classifier calls and expose an actionable credential
  status. On 429, honor Retry-After without delaying the current agent request;
  back off on outages. Reload a replaced token without losing queued requests.
- Check credential availability at startup; never depend on a developer's
  Wrangler login or silently switch to that login when the dedicated token fails.
- Report resource use while a game runs before household rollout. CPU-only
  benchmarks do not establish GPU latency, gaming impact or power consumption.

## Migration and rollback

Add a router/profile switch; keep existing behavior until acceptance passes. Keep
request IDs, thread history and jobs; database migrations are additive/versioned.
The new profile replaces the old Granite/keyword routing with an explicit
provider setting and general-agent fallback. A provider failure or deadline
uses general discovery with the full transcript and ordinary action permissions.
Retire each Python client only after
its native replacement passes testing; never run two wake listeners on one mic.

Disabling Clef Flash bypasses classification only; the eventual assistant
continues through general discovery. Keep credentials outside Git and off client
devices. The retired local experiment can only be reproduced after reinstalling
its service and model files; it is not an automatic fallback.

## Adding capabilities

Use [st-voice-capability](../.agents/skills/st-voice-capability/SKILL.md). Every
addition defines intent, the real interface, concise manual/context, outcome
speech, and routing cases including confusing neighbors. Keep `other`; avoid
outgrowing the option-text budget by using discovery or hierarchical routing.

## Sources checked

- [Unsloth Laya](https://unsloth.ai/docs/models/decision-laya)
- [Cloudflare Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/)
- [sherpa-onnx platforms/functions](https://k2-fsa.github.io/sherpa/intro.html)
- [Custom keyword spotting](https://k2-fsa.github.io/sherpa/onnx/kws/index.html)
- [Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Android microphone services](https://developer.android.com/develop/background-work/services/fgs/service-types)

## Implementation journal (in progress)

2026-11-26: implementation authorized. A checkpoint preserves the coordinator,
structured result events/cancellation migration, dynamic ST tools over a reusable
app-server connection, and a shared Rust audio crate before rebasing onto main.
These changes are not deployed or complete yet. The installed Codex 0.172.0
catalog advertises `gpt-6-luna` with low reasoning. Actual inference still needs
verification. The Rust speech crate (`sherpa-onnx` 2.0.3) and daemon compiled;
integration tests initially could not start because this checkout's kiosk assets
had not been built. This host uses Docker for Cargo and Node builds.

Decisions to report at completion:

- Use dynamic app-server tools scoped to each job instead of changing a shared
  MCP process's job credentials. Reuse the process, preserve separate threads.
- Keep original transcripts intact; conservatively bypass the classifier when
  the complete UTF-8 request exceeds 20,000 bytes, leaving framing headroom.
- Use a two-second routing deadline, one outstanding classifier HTTP task, auth
  failure suppression and rate-limit backoff. Missing routing never blocks agents.
- Use the official Rust sherpa-onnx bindings; keep ASR lazy and unload after five
  idle minutes. Long dictation requires overlapping chunks within Whisper's window.
- Retain the original worker behind an explicit legacy profile for rollback.
- Physical microphone, simultaneous room/PC wake and Windows acceptance require
  suitable hardware; synthetic audio tests cannot establish those results.

2026-11-26 follow-up: the additive schema migration is 005 because rebased main
already owns 004. Live deployment backed up the prior schema-3 database and runtime;
no jobs were active. A real read-only system request completed through Clef and
Luna, confirmed by the system-status adapter. Isolated tests verified note creation
and same-thread editing. Herdr recognizes the dedicated assistant project and its
saved conversations. The native audio suite verifies both phrases, rejects a
confusable phrase before submission, retains the end of a long dictation and
reports CPU/RSS. Physical input/output are absent from this host's PipeWire session
(only Dummy Output), so the room microphone service is deliberately not enabled.

Further decisions:

- Confirm the wake phrase again with full ASR before dispatch. A provisional
  keyword hit may open capture but does not authorize executing “Hey Steve.”
- Keep native Piper and English Lessac as the packaged default. Other matching
  Piper voice directories can be selected; real Czech output acceptance is pending.
- Use half-duplex output with explicit stop/mute controls, not untested echo cancellation.
- Preserve speech text at most once across crashes; a skipped spoken line remains
  available as durable text. Durable cancellation markers cover offline submissions.
- Package actual native Windows binaries with a pinned eSpeak DLL and model checksums;
  compile on Windows CI in addition to Linux cross-checks.
- Warm app-server slots retire after five idle minutes; release thread ownership
  after each result so Herdr can resume it. ASR and TTS have the same idle policy.

The Herdr project/history integration is verified, including coordinator resumption
after an app-server restart. The generic Herdr chat view does not dispatch ST's
per-job dynamic tools. Action follow-ups currently use voice or `st ask --parent`;
interactive Herdr-to-coordinator action handoff remains a documented integration
limitation, rather than bypassing the job/device bindings to make it appear to work.
