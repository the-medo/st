# Decision-model comparison methodology

Compare Laya multilingual, Kev 0.8B, Kev 4B, LiquidAI d1 2B, and hosted Cloudflare
Clef Flash. The user explicitly selected these five, rather than the full Unsloth
catalog, and authorized synthetic transcript requests to Cloudflare.

## Comparable inputs

Use the same frozen 100-transcript corpus and action-wording catalog for every
model. Change only the model/provider selector and serving backend. Do not tune
criteria for individual models. Each output directory retains the catalog,
response for every case, corpus/catalog fingerprints, timings and resource
samples. Expected labels and evaluation metadata are never sent to the model.

The existing corpus has already influenced the Laya descriptions. This comparison
is a development benchmark, not an independent production accuracy estimate.
Raw accuracy is the primary routing score. Also report the same provisional
0.65-probability / 0.20-margin fallback rule, without treating confidence scores
from different models as equally calibrated.

## Local serving configuration

- Use the installed Unsloth API on loopback, with its existing inference key.
- Laya uses PyTorch; the alternatives use Unsloth's bundled llama.cpp and pinned
  Q8_0 GGUF files. Model downloads and checksum verification finish first.
- Restart the dedicated `st-laya.service` before each model. Other ST services
  and live agent workers are not restarted or invoked.
- Select that model as the service's default using an owner-controlled temporary
  environment override. Inference-only keys cannot select a different default;
  keep the key's permissions restricted rather than replacing it with an owner key.
- Set two PyTorch/OpenMP/MKL threads and `LLAMA_ARG_THREADS=2`; llama.cpp batch
  threads default to that value. Use one HTTP worker thread and one model slot.
- Apply a temporary aggregate `CPUQuota=200%`, `MemoryHigh=10G`, `MemoryMax=12G`.
  These are test ceilings, not the model's measured requirement.
- Use CPU inference throughout. No GPU results are implied. Set native context
  and physical batch to 1,024 tokens for these short inputs; Laya retains its
  checkpoint's own 1,024-token limit. This is not a long-transcript benchmark.
- Preserve the original service/settings and remove the temporary limits when
  testing finishes. The report records the resulting service state.

## Measurement sequence

1. Observe the service before loading the model for 15 seconds.
2. Send one separately recorded first request. Model files are already present
   and may be in the OS page cache. This measures model initialization plus the
   request, not a reboot-cold disk read or download. Studio is already accepting
   HTTP; its own process startup time is excluded.
3. Send all 100 transcripts sequentially and synchronously.
4. Observe the loaded service for 30 idle seconds after the final request.

The HTTP client runs on the Steam Machine for both local and Cloudflare models.
It does not pool connections, use environment proxies, follow redirects or retry
scored requests. Cloud latency therefore includes a fresh HTTPS connection and
the network round trip. Model-load HTTP 503 responses get bounded retries before
scoring begins. A quota/authentication error stops the run.

## RAM and CPU definitions

`resources.py` samples every 0.5 seconds. Linux `/proc/PID/smaps_rollup` supplies
the sum of proportional set size (PSS) for all service descendants. **PSS is the
primary resident-memory metric:** shared pages are apportioned rather than counted
once per process. RSS and private pages are also retained. GGUF weights mapped
from disk can be resident and reclaimable; they still matter for warm latency.

The report uses loaded-idle median PSS, sampled peak PSS while scoring, and the
separate startup peak. A sampled peak is a lower bound on brief spikes.
Cgroup `memory.current`, anonymous
memory, file cache, swap, and pressure/OOM events are saved separately. Cgroup
file-cache accounting depends on which process first charged a page; it is not
interchangeable with PSS. The model download size is not runtime RAM.

CPU time comes from the service cgroup's `cpu.stat`, including descendants, so
other applications' CPU use is excluded. Per-request CPU seconds capture the
actual amount of CPU work. CPU percentage is CPU seconds divided by elapsed wall
time: 100% means one logical core; 200% means two. A separate machine percentage
divides that value by the host's logical CPU count. Idle CPU is measured over the
30-second loaded interval. No power-meter or energy measurement is implied.
These figures cover routing only. They do not include a microphone listener,
speech recognition, text-to-speech, the action agent or the rest of ST.

The sampler/client runs outside the local service cgroup, so its CPU is excluded
from local model CPU totals. Sampling can still introduce small scheduling
overhead. Host load and available memory are recorded because unrelated activity
can affect latency even though it is excluded from the service CPU counter.

## Cloudflare-specific limits

The hosted endpoint is the documented Workers AI model `@cf/cloudflare/clef-flash`.
Reuse the owner's existing Wrangler OAuth login, refreshed by `wrangler whoami`.
The private configuration names the account and Wrangler credential file; neither
credentials nor account identifiers belong in versioned results. No Worker
deployment, new account, new token permissions or paid plan is required by the
benchmark itself.

Cloudflare does not expose inference-worker CPU/RAM here. Report those as
**unavailable**, never zero. The measured PSS/CPU for the Cloudflare row belongs
only to the small local benchmark HTTP client, including its sampling thread.
It is not directly equivalent to the local rows' complete Unsloth service.
The first hosted request does not establish whether Cloudflare's model was cold.

Record returned input-token usage. Estimate cost at the published rate, before
any free allowance; it is an estimate rather than an account invoice. Full
transcripts leave the machine in this explicitly authorized cloud test. No agents
or household integrations receive the classification outputs.

Reference: [Cloudflare Clef Flash model and pricing](https://developers.cloudflare.com/workers-ai/models/clef-flash/).

## Reproduction

Run from `stapp`, with the appropriate local model/backend configured and an
existing service cgroup. Each output directory must be new:

```sh
python3 experiments/laya/benchmark.py \
  --model kev-0.8b \
  --api-key-file "$HOME/.config/st-laya/api-key" \
  --cgroup /sys/fs/cgroup/USER_SERVICE_CGROUP \
  --output /tmp/st-kev-new-run
```

Obtain the cgroup using `systemctl --user show st-laya.service -p ControlGroup
--value`, prefixed with `/sys/fs/cgroup`. A fresh service restart and the settings
above are necessary to reproduce the unloaded baseline and initial request.

For the explicitly enabled Cloudflare comparison:

```sh
wrangler whoami
python3 experiments/laya/benchmark.py \
  --provider cloudflare --model clef-flash \
  --cloudflare-config "$HOME/.config/st-laya/cloudflare-account.json" \
  --output /tmp/st-clef-flash-new-run
```

The private JSON file has `account_id` and `wrangler_auth_file` properties. The
runner reads the latter TOML's OAuth token in memory, checks expiration and never
writes the token to logs or results. It only permits the selected Cloudflare
model; the original `evaluate.py` continues to accept local endpoints only.
