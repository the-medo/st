# Assistant implementation validation — 2026-11-26

The feature branch was rebased onto main `5680bd8` before implementation continued.
The installed host coordinator now runs Clef Flash and Luna. The desktop clients
are implemented and packaged; household microphone acceptance is still pending.

## Verified behavior

- 24 assistant/router/protocol checks pass, including the existing daemon tests,
  bad/replaced credentials, provider backoff, bounded timeout, oversized input,
  context confinement, durable event payloads, device separation, cancellation,
  spoken-answer retries, wake-claim release and dynamic-tool binding.
- 11 CLI tests and six photo integration tests pass. Linux CI also runs the
  planner and DAVe regression suites. Rust resampling and wake-prefix tests pass.
- Real isolated Luna requests created distinct conversations, saved a note through
  the dynamic tool, and changed that note through a same-thread follow-up. Effects
  were checked directly in the temporary database. Household records were unchanged.
- The dedicated assistant project maps correctly in Herdr's sidebar; saved threads
  are available. Completion unsubscribes the worker's thread writer.
- The deployed account token classified a synthetic system request in 234 ms.
  A live read-only system request completed through the installed worker in 5.01 s,
  with an actual `system_status` tool receipt. These are individual observations,
  not end-to-end p50/p95 estimates.
- Windows CI built and linked the real x64 executable, packaged the pinned eSpeak
  library, generated speech, then recognized and transcribed its wake fixture.
  [Successful Windows run](https://github.com/the-medo/st/actions/runs/45731719739).
  This is stronger than the earlier Linux-to-Windows source check; it still does
  not validate a physical microphone, popup focus, login or suspend.
- The native audio suite passes Hey ST, Okay ST, a phrase without a wake word,
  the confusable “Hey Steve,” sixty seconds of silence, and the final “cobalt”
  marker after more than thirty seconds of continuous dictation through wake/VAD/ASR.

## CPU and memory measurements

[Raw synthetic results](../experiments/voice/native-audio-20261126.json) were produced
by `python3 tests/audio.py --report ...`. Linux `wait4` measures each child process's
CPU time and peak RSS. Input WAV buffers, model initialization and process startup
are included. No microphone, network submission or audible playback is involved.
The fixture synthesizer uses fixed near-zero noise for repeatable regression inputs;
normal speech output keeps Piper's normal noise settings.

| Synthetic workload | Wall time | CPU time | Peak RSS |
| --- | ---: | ---: | ---: |
| 60 seconds of silence through the audio pipeline | 1.71 s | 1.71 s | 97 MiB |
| Hey ST + short request, wake/VAD/ASR | 1.19 s | 1.56 s | 381 MiB |
| Okay ST + short request, wake/VAD/ASR | 1.11 s | 1.44 s | 377 MiB |
| Short speech generation | 0.52–0.60 s | 0.60–0.75 s | 137.40–154.30 MiB |
| 47-second transcription, including final marker | 3.89 s | 6.84 s | 693 MiB |
| Continuous long request through wake/VAD/ASR | 7.05 s | 12.51 s | 732 MiB |

These are accelerated fixture-processing times, not time the user waits while
speaking. For the silence run, CPU seconds divided by sixty gives an approximate
single-core duty cost including initialization; it is not a measured real-time
microphone idle percentage. No gaming load was applied. Separate process peaks
must not be presented as the combined endpoint peak while ASR and TTS are warm.

After a real request, the host worker's resident set was about 31 MiB, its warm
app-server about 254 MiB, and its code-mode helper about 25 MiB. After five idle
minutes, no agent child remained and the worker service cgroup used about 47 MiB
(including accounting/cache overhead). The worker can use two warm slots under
concurrency. Native ASR and TTS also unload after five idle minutes.

## Deployment and remaining acceptance

The host had no queued/running/waiting jobs before installation. A private SQLite
backup and copies of runtime/configuration were made before migrating schema 3
through main's schema 4 and the assistant's schema 5. The services are healthy;
installed manuals are present; old jobs and household records were retained.

The available PipeWire session exposes **Dummy Output and no physical sources**.
The room service is therefore not enabled. Windows has been tested on CI rather
than the owner's microphone-equipped desktop. Still required:

- Seat/distance/Czech/name accuracy and TV/game false-wake tests with real audio.
- Linux Desktop/Gaming Mode, login, suspend and real device unplug/reconnect.
- Windows popup focus, microphone permission, sign-in and suspend/device changes.
- Simultaneous PC/room arbitration and origin-specific speech with real speakers.

Early randomized TTS clips sometimes failed keyword detection, and “Hey Steve”
can provisionally trigger the small keyword model. Full transcription now verifies
the wake phrase before dispatch, so that confusable phrase is rejected. This does
not establish production wake recall or eliminate brief false recording popups.
Tune with independent real recordings before enabling household use; do not weaken
that confirmation merely to improve the synthetic fixture score.

Android remains future work. No local decision-model service or model cache has
been restored. The speech models are separate from those retired decision models.
