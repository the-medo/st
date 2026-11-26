# Decision models: accuracy, latency and machine resources

Measured on the Steam Machine on 2026-11-25. **The owner selected Cloudflare Clef
Flash for the next assistant implementation phase.** It scored 97/100 and was fastest at
the median while requiring no resident local decision model. If local routing is
preferred, LiquidAI d1 2B is the best practical compromise from these tests.

The user selected three alternatives plus Laya and Cloudflare, not the entire
Unsloth catalog. All five received the same 100 synthetic transcripts and the
same 12 route descriptions, including `other`. There were **500 scored requests
and zero agent invocations**. No real spoken commands or household data were used.

## Main results

| Model | Correct /100 | Median | p95 | Loaded idle local RAM¹ | Sampled peak local RAM¹ | CPU seconds/request² |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Laya multilingual | 64 | 296 ms | 331 ms | 2.11 GiB | 2.63 GiB | 0.597 |
| Kev 0.8B | 69 | 1,498 ms | 1,608 ms | 1.75 GiB | 1.76 GiB | 2.993 |
| Kev 4B | 91 | 7,512 ms | 7,747 ms | 5.23 GiB | 5.23 GiB | 14.794 |
| LiquidAI d1 2B | 88 | 2,302 ms | 2,420 ms | 2.47 GiB | 2.47 GiB | 4.552 |
| **Cloudflare Clef Flash** | **97** | **190 ms** | **448 ms** | **16 MiB client only** | **16 MiB client only** | **0.004 client only** |

¹ RAM is proportional resident memory (PSS), including Unsloth and its child
processes for local models. Peak includes model loading and is sampled every
0.5 seconds, so brief spikes can be missed. Cloudflare's row measures the local
Python HTTP benchmark client, not the remote inference worker. Remote RAM/CPU
are unavailable. The eventual coordinator's incremental overhead will differ.

² A CPU-second is one logical core occupied for one second. Local models used
two inference threads and a two-core aggregate CPU limit: approximately
197–199% of one logical core while continuously processing requests, or
16.4–16.6% on this 12-thread machine. These are CPU-only results; GPU performance
and gaming impact were not tested. Cloudflare timings include HTTPS and the
network round trip from the same Steam Machine.

Local idle CPU was approximately 0.42–0.44% of one logical core (about 0.035–0.037%
of the machine). The persistent RAM allocation is the more noticeable idle cost.
No local run used swap or recorded an OOM event. The temporary 12 GiB cgroup
ceiling was a benchmark safeguard, not a measured requirement.

## What the results mean

- **Cloudflare Clef Flash:** strongest score, fast network-inclusive latency and
  negligible local client work. Its p95 was slower than Laya's, so it did not win
  every latency statistic; the slowest hosted request was 815 ms. It still needs
  network access and sends the transcript to the selected provider.
- **LiquidAI d1 2B:** 88 correct at 2.30 seconds and 2.47 GiB. It used about one
  third of Kev 4B's CPU time per request and less than half its resident RAM.
  This is the local option to investigate further if keeping routing local matters.
- **Kev 4B:** 91 correct, but 7.51 seconds and 5.23 GiB make it a poor fit for the
  desired quick, low-resource voice router under this CPU budget. Its three-answer
  advantage over d1 on this small corpus does not establish a general ranking.
- **Kev 0.8B:** saved about 0.35 GiB versus Laya but gained only five correct
  answers while taking five times as long and doing five times the CPU work.
- **Laya:** fast once loaded, but the 64/100 result and frequent confident
  action-versus-topic mistakes remain a problem for choosing context reliably.

| Model | English correct /76 | Czech correct /24 |
| --- | ---: | ---: |
| Laya multilingual | 52 | 12 |
| Kev 0.8B | 56 | 13 |
| Kev 4B | 68 | 23 |
| LiquidAI d1 2B | 69 | 19 |
| Cloudflare Clef Flash | 73 | 24 |

These are development results. The corpus is synthetic and has already been
inspected while tuning Laya's descriptions. It is not an independent sample of
real microphone use. Keep the full transcript and capability discovery available
to the action agent, and validate the chosen provider on fresh examples.

## Confidence and remaining mistakes

The same provisional rule was applied to every model: probability at least 0.65
and top-two margin at least 0.20. It has not been calibrated for these models.

| Model | Accepted specific routes correct | Uncertain → other | Confidently wrong |
| --- | ---: | ---: | ---: |
| Laya multilingual | 51/67 | 32 | 16 |
| Kev 0.8B | 27/29 | 64 | 2 |
| Kev 4B | 32/32 | 60 | 0 |
| LiquidAI d1 2B | 70/71 | 19 | 2 |
| Cloudflare Clef Flash | 85/87 | 4 | 2 |

“Accepted specific” excludes confident `other` responses. A low confident-error
count can come from low acceptance coverage: Kev 4B accepted only 32 specific
routes. Do not copy the same threshold into production without checking it on
new examples for the selected model.

Cloudflare's three raw mistakes were:

1. “Implement a better air quality chart in the ST dashboard.” Expected `agents`,
   predicted `air_quality` (0.6262); the provisional policy falls back to `other`.
2. “Prepare a cleanup inventory for the old website worktree, keep its files.”
   Expected `system`, predicted `agents` (0.9196). The corpus labels the existing
   system cleanup interface as responsible; this is also a plausible project-work
   interpretation and should be correctable through capability discovery.
3. “Actually, make that Friday instead.” Expected standalone `other`, predicted
   `planner` (0.9167). In the assistant, pending conversation state should resolve
   this before ordinary new-request routing.

Routing remains a context hint. It does not authorize tools or establish that an
action has completed.

## Occasional-use startup and unloading

| Model | First request with files already cached | Warm median |
| --- | ---: | ---: |
| Laya multilingual | 6.14 s | 0.30 s |
| Kev 0.8B | 2.37 s | 1.50 s |
| Kev 4B | 8.34 s | 7.51 s |
| LiquidAI d1 2B | 2.93 s | 2.30 s |

Studio was already accepting HTTP requests for these measurements; its own
process startup time is excluded. Files may have been in the OS page cache.
These figures are not reboot-cold disk measurements. Cloudflare's first benchmark
request was 506 ms, but the provider's cold/warm state is unknown.

Unsloth's installed llama.cpp integration schedules model unloading after five
idle minutes. A separate explicit unload check with d1 released its model process
in 308 ms and reduced resident service RAM from 2.47 GiB to **411 MiB**. Studio
itself still needs memory after the model is unloaded.

**State immediately after measurement:** `st-laya.service` was stopped and disabled at login. The temporary
benchmark override was removed and original backend/context settings restored.
Model files and credentials initially remained on disk. Neither a local model
nor the Studio process was left running between experiments.
See [the cleanup measurement](results/comparison/cleanup.json).

**Current state after provider selection:** at the owner's request, all four
local decision-model caches (including Laya's shared blobs and d1's projector)
and the `st-laya.service` unit were removed. Reclaimed allocation: **8,023,908,352
bytes (8.02 GB / 7.47 GiB)**. Unsloth software remains installed but has no running
service or downloaded decision models. Benchmark evidence is unchanged; see
[the retirement record](retirement.json). Reproducing local runs now requires
restoring the service and downloading the pinned models. The live ST worker has
not been rewired by this selection.

## Cloudflare access and estimated cost

The existing Wrangler OAuth login, with Workers AI access, was refreshed and
reused. The benchmark called the documented REST endpoint directly from the
Steam Machine. The connected MCP rejected this Cloudflare-hosted model as a
third-party model before sending it; the direct authorized Workers AI request
worked. No new Worker, account or subscription was created.

The owner subsequently supplied a dedicated account API token. Verification on
2026-11-26 reported active status without an expiration field; three classifier
requests succeeded using that token alone. These checks are separate from the
100-case benchmark. The unattended assistant will use this credential instead
of the developer login; see [verification evidence](account-token-check.json) and
[authentication and maintenance](../../docs/assistant-routing.md#cloudflare-authentication-and-maintenance).

The 100 scored calls used 43,703 input tokens. At the published $0.038 per million
input tokens, their estimated cost is **$0.001660714**, before any free allowance.
That is about **$0.0166 per 1,000 similar requests**. Initialization/smoke requests
are separate from this scored-call total. The API does not charge output tokens
for this model. This is a rate-based estimate, not an account invoice.
[Cloudflare model and pricing](https://developers.cloudflare.com/workers-ai/models/clef-flash/).

## Reproducibility and verification

- [Generated comparison table](results/comparison/comparison.md),
  [CSV](results/comparison/comparison.csv), and [JSON](results/comparison/comparison.json).
- Per-model result folders contain every response, timing, CPU measurement,
  half-second memory samples, exact catalog and summaries.
- [Model/runtime revisions and checksums](comparison-environment.json).
- [Measurement definitions and reproduction](MEASUREMENT.md).
- [Benchmark runner](benchmark.py), [resource sampler](resources.py), and
  [independent result validation/aggregation](summarize_comparison.py).

The aggregator rechecks all 500 labels, probability validation, counts, summaries,
corpus/catalog fingerprints and resource-sampling success. It excludes the
preserved `kev-0.8b-setup-failure` directory: that attempt made zero scored calls
because an inference-only key cannot override the configured default model.
The model was then selected through owner-controlled configuration and rerun
successfully without widening the key's permissions.

The original Laya-only baseline and action-wording results remain unchanged.
No microphone, speech recognition, action agent or TTS performance is implied
by this text-routing comparison.
