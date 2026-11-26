# Native S.T. assistant

The coordinator uses Cloudflare Clef Flash for advisory routing and Codex's
subscription-authenticated app-server for `gpt-6-luna` with low reasoning. No
OpenAI API key is needed for this agent path. Cloudflare inference uses the
separate account token described in [routing maintenance](assistant-routing.md).
There is no local decision model. Wake detection, transcription and speech run
locally in the Rust endpoint.

## Installed pieces and behavior

- `stappd`: durable jobs, origin-device inboxes, clarification, cancellation and
  idempotent tool receipts. Migration 004 is main's note operations; 005 adds
  structured assistant events. Existing requests and notes survive migration.
- `worker.py`: Clef/context/discovery, up to two active agent turns, independent
  conversations, same-thread follow-ups, compact speech. App-server processes are
  reused and retired after five minutes with no active jobs.
- `st-voice`: CPAL capture, sherpa keyword spotting/Silero VAD/Whisper base,
  native Piper output using eSpeak NG phonemes, local controls and durable outbox.
- Windows uses the same Rust core and a small topmost popup with `NOACTIVATE`.
  Linux uses a user service and a local status file. There is no Python runtime
  in either native client. Python remains the host coordinator and Linux installer.

The twelve routes and actual interfaces are in
[the catalog](../assistant/routing/catalog.json). Planner, notes, photos, panel
views and registered project delegation use existing ST tools. System status,
database connection status and air readings have read-only monitor adapters.
Rohlik requires the existing `STAPP_ROHLIK=1` authenticated integration.
Printer execution and Paperless search are not implemented by a category label.
`other` can answer questions, use web search and discover any available capability.

Routing receives the complete transcript plus category criteria. The agent gets
the original transcript as its user message; trusted manuals and routing metadata
are separate developer context. Its action tools are bound to the originating
job/claim/device. A routing error never grants extra action permissions.
The final structured result is retained in the conversation; the device receives
full `display_text` and short `speech_text`. The latter is limited to 45 words.

## Speech use

Say **Hey ST** or **Okay ST**, then dictate. Silence ends recording. The current
recording limit is 120 seconds; a short cue marks recording start/end. Whisper
uses overlapping 25-second windows so longer dictation is not silently reduced
to its first window. Empty captures are discarded. A two-second pre-roll preserves
the command opening and lets transcription remove the full wake phrase.

A pending question on that device consumes the next spoken response, including
bare answers such as “blue” or “yes.” Multiple pending questions require an
explicit `st --device room answer REQUEST_ID "answer"`. A new request otherwise
creates a new conversation. Say **“Follow up …”** after a result to continue the
last completed conversation, or use `st ask --parent REQUEST_ID "..."`.

Output is half-duplex: the microphone is suspended while S.T. speaks. This avoids
self-triggering; natural spoken interruption is not implemented. Use the deliberate
stop control. Stop cancels pending work and speech; it cannot undo confirmed edits.
The client preserves request UUIDs through transport retries and keeps unsent text
in its private outbox. Cancellation markers prevent stopped outbox entries from
being submitted later. Speech cursors are persisted before playback: after a crash,
a spoken line can be skipped, but it is not spoken twice and its text is retained.

ASR and TTS are loaded on demand and released after five idle minutes. KWS/VAD
remain resident. The default voice is English Lessac. Multilingual Whisper input
is enabled; set `STAPP_LANGUAGE=cs` or `en` if language detection is unreliable.
For another compatible Piper voice, set `STAPP_TTS_MODEL_DIRECTORY` to a directory
with its ONNX model, `.onnx.json`, `tokens.txt` and matching `espeak-ng-data`; the
phonemizer language is read from that voice's metadata. Czech microphone/output
quality still needs real recordings and an appropriate Czech voice.

## Build and Linux setup

Run from `stapp`:

```sh
scripts/cargo build --locked --release
python3 scripts/models.py "$HOME/.cache/stapp/models"
target/release/st-voice --list
```

Models and downloads stay outside Git, with SHA-256 pins in
`assistant/audio/models.json`. The official sherpa Rust/native release is pinned
to 2.0.3. Linux also needs `libespeak-ng.so.1` (eSpeak NG).

Pair the device using the existing forced-command SSH setup, then install as
the logged-in user who owns PipeWire:

```sh
scripts/install-room --ssh st-room --mic pipewire --speaker pipewire
systemctl --user status stapp-room.service
```

Choose actual available CPAL devices. `pipewire` uses the user's current default
source/sink; configure the physical defaults in PipeWire. The user service has
lower scheduling priority and a memory pressure preference. A machine exposing
only Dummy Output has no microphone to validate or enable.

The config is `~/.config/stapp/room.json`; default client state is
`~/.local/share/stapp-room`. Useful local diagnostics are `status.json`,
`last-result.json`, `*-error.txt`, `cursor` and `outbox/`. They may contain dictated
text and must remain private. There is no raw-audio archive.

```sh
st-voice --config "$HOME/.config/stapp/room.json" --control mute
st-voice --config "$HOME/.config/stapp/room.json" --control unmute
st-voice --config "$HOME/.config/stapp/room.json" --control stop
st-voice --config "$HOME/.config/stapp/room.json" --control quit
# Explicit one-shot capture, without a wake phrase:
st-voice --config "$HOME/.config/stapp/room.json" --record-once
```

Only one listener may use a state directory. Stop the background service before
one-shot capture. `STAPP_EARCONS=0` disables recording cues. A configured input or
output disappearing produces a local error; capture reopens the device on retry.
A dropped capture buffer discards that incomplete utterance.

## Windows setup

The **Windows client** GitHub Actions workflow builds native x64 executables,
packages a pinned official 64-bit eSpeak DLL and checks native speech generation,
wake detection and transcription on a Windows runner. Download the
`stapp-windows-x64` artifact, extract it, then run:

```powershell
.\install.ps1 -SshAlias st-pc
```

Initial SSH pairing and microphone permission are required. Optional `-Microphone`
and `-Speaker` select exact CPAL names; otherwise Windows defaults are used.
The installer downloads and verifies models, creates a sign-in scheduled task
and puts mute/unmute/stop/quit shortcuts in the Start menu. Settings and private
state live under `%LOCALAPPDATA%\STapp`. The released client runs without a console.

The build smoke test does not establish real microphone accuracy, focus behavior,
suspend recovery, default-device switching or interaction with game audio. Those
remain device acceptance checks.

## Host operation and rollback

`STAPP_CF_CONFIG` defaults to `~/.config/st-assistant/cloudflare.json`; its
`api_token_file` points to a separate mode-600 file. No cloud token goes to an
endpoint. The router reloads a changed token without restarting the service.
401/403 suppress retries until the token changes; 429 honors Retry-After. Other
errors, missing credentials, oversized input or the two-second deadline use
`other` with the full transcript. Check `~/.local/share/stapp/router-health.json`
and the per-request routing event for the reason; do not log the token.

`STAPP_ROUTER=disabled` bypasses classification. `STAPP_ASSISTANT_PROFILE=legacy`
selects the original coordinator for rollback; retain the matching legacy client
when using that profile. Do not run both clients on the same microphone.
`STAPP_AGENT_MODEL`, `STAPP_AGENT_EFFORT`, `STAPP_MONITOR_PORT` and
`STAPP_AGENT_PROJECT_NAME` are coordinator settings. The default monitor port is
8790. Installed manuals are copied from reviewed repository files only.

Before deployment, back up the SQLite database with SQLite's backup API and
preserve runtime binaries/configuration. `scripts/install-host` preserves existing
host settings, installs the additive migrations and restarts only STapp services.
Rollback to an older binary requires its corresponding database backup; never
silently downgrade a database with new jobs.

The assistant workspace is `~/.local/share/stapp/assistant`. Its native Codex
project is also registered in the existing Herdr sidebar project configuration.
Threads are unsubscribed after completion so Herdr can resume them without a
second writer. Do not edit Codex history databases to register conversations.

## Verification and remaining acceptance

Automated checks cover routing outages/auth rotation/deadlines/bad responses,
manual path confinement, device isolation, durable acknowledgements/results,
cancellation, spoken-answer retries, and dynamic tool job binding. Real isolated
Luna runs created a note, verified it in SQLite, and changed it through a follow-up
in the same thread. The household database was not touched by these test actions.
Herdr's sidebar mapping recognizes the dedicated project and saved conversations.

Synthetic native audio exercises both wake phrases, VAD, transcription and TTS.
Resource figures are recorded in [the validation report](assistant-validation.md).
They do not establish Czech recognition, false-wake rates with TV/game sound, or
gaming impact. Final household acceptance requires physical Linux and Windows
microphones, dual-device overlap arbitration, suspend/login and focus checks.
Android's microphone widget remains in [future work](assistant-future.md).
