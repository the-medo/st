# S.T. voice assistant implementation plan

Status: design and local routing experiment, 2026-11-25. The experiment sends
synthetic text to decision models only; it does not submit jobs to agents or
integrations. The later comparison includes explicitly authorized Cloudflare
inference as well as local Unsloth models.

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

The local classifier, experiment, skill and plan are the current deliverables.
Live dispatch and native client rollout are subsequent implementation phases.

Measured on 100 synthetic transcripts: the revised catalog scored 64/100, with
296 ms median / 334 ms p95 warm HTTP latency and 16 confidently wrong routes.
Use Laya only as an advisory context hint. Start with generic acknowledgements
and keep capability discovery available even when its probability is high.

The [five-model comparison](experiments/laya/COMPARISON.md) now recommends
**Cloudflare Clef Flash** for the next implementation phase: 97/100, 190 ms median,
448 ms p95, and no resident local decision model. LiquidAI d1 2B is the preferred
local alternative from these tests: 88/100, 2.30 s median, 2.47 GiB idle RAM.
These are proposed provider choices; the live worker is unchanged. The local
experiment service is stopped and disabled at login to avoid idle resource use.

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

The current worker advertises five routes, but only shopping changes its prompt
meaningfully; all assistant tools remain registered. The catalog must drive
context/tool selection as well as the label to reduce agent latency.

This base does not have a complete planner CLI. Use existing planner MCP/API
until the independent CLI work lands. A Prusa/Paperless dashboard link is not
itself a voice tool. Mark integration availability explicitly in the catalog.

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
5. Call the explicitly configured decision provider with transcript and short
   criteria: proposed default Cloudflare Clef Flash, or local Unsloth. Persist
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
the decision model. Local Unsloth returns HTTP 422 when state would be truncated;
treat that as general routing. Hosted Clef Flash can truncate long text to fit,
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
  `gpt-transcribe` when explicitly configured. Any local decision model stays on
  the Steam Machine; endpoint clients call the coordinator, not the model API.
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
| 1: shadow coordinator | Catalog/context builder, router fallback, additive job events | Timeout/outage/bad response/long input use general routing; retries deduplicate |
| 2: text agent path | Dedicated project, warm app-server, Luna/low, selected tools, compact output | Isolated planner/store tests; Herdr visibility; origin-thread follow-ups |
| 3: Steam Machine | Native wake/VAD/ASR/TTS and both phrases | Seat/mic recordings, false wakes, game noise, reconnect, Gaming Mode |
| 4: Windows | Packaged native core, popup, startup and speech | Native test machine; no focus stealing; suspend/mic removal/server disconnect |
| 5: household rollout | Dual-mic arbitration, real tasks, speech queue and failure handling | One action/reply per intended request; each device independently usable |
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

Compare decision providers using [the resource benchmark](experiments/laya/COMPARISON.md)
before choosing the implementation default. Measure microphone wake detection,
ASR and TTS separately; routing measurements do not describe the full assistant.

- Keep only the wake listener continuously active on endpoints. Measure its idle
  CPU and RAM as part of desktop acceptance.
- Make the decision provider an explicit configuration choice. A hosted provider
  needs no resident local decision model; local mode keeps transcripts local at
  this stage and uses bounded CPU/memory settings.
- In local mode, warm on wake when useful so loading can overlap dictation, then
  unload after inactivity. The current llama.cpp integration has a five-minute
  idle unload, but Studio itself still consumes memory; stopping the entire
  experiment service releases its remaining process memory.
- Preserve a bounded routing deadline and general-agent fallback. Do not leave
  users waiting indefinitely for model startup, and do not silently switch an
  explicitly local configuration to a cloud provider.
- Report resource use while a game runs before household rollout. CPU-only
  benchmarks do not establish GPU latency, gaming impact or power consumption.

## Migration and rollback

Add a router/profile switch; keep existing behavior until acceptance passes. Keep
request IDs, thread history and jobs; database migrations are additive/versioned.
The new profile replaces the old Granite/keyword routing with an explicit
provider setting and general-agent fallback. A provider failure or deadline
uses general discovery; local mode never silently calls a cloud classifier.
Retire each Python client only after
its native replacement passes testing; never run two wake listeners on one mic.

Stopping `st-laya.service` disables classification only. The eventual assistant
continues through general discovery. Installation, model cache and credentials
remain outside Git. See the experiment runbook for restart and reproducibility.

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
