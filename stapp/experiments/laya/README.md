# Local Laya routing experiment

For the later five-model comparison, including RAM, CPU and hosted Cloudflare
Clef Flash, see [the comparison report](COMPARISON.md) and
[measurement methodology](MEASUREMENT.md). The original two runs below remain
unchanged.

Run on the Steam Machine on 2026-11-25. **Historical experiment: Clef Flash is now
selected, all local decision models have been deleted, and their service removed.**
Laya's measured routes were not reliable enough to restrict an agent's
capabilities. Use the result as
an initial context hint, preserve the complete transcript, and allow discovery.

The [implementation plan](../../IMPLEMENTATION.md) replaces the earlier assistant
plan. The [routing contract](../../docs/assistant-routing.md) maps capabilities to
agent input. No agent jobs, purchases, database changes or physical actions were
submitted by this experiment. Requests mentioning those actions are synthetic text.

## Results

The corpus contains **100 different transcripts**, frozen before the first run:
76 English and 24 Czech. Eleven specific routes have eight cases each; `other`
has twelve. Cases include direct requests, topic/action conflicts, follow-ups,
unsupported capabilities and instructions embedded in the transcript.

| Measurement | Baseline descriptions | Short action descriptions |
| --- | ---: | ---: |
| Successful HTTP responses | 100/100 | 100/100 |
| Raw correct routes | 61/100 | 64/100 |
| Correct after uncertain → other | 57/100 | 61/100 |
| Uncertain fallbacks | 35 | 32 |
| Accepted specific routes correct | 48/65 (73.8%) | 51/67 (76.1%) |
| Confidently wrong routes | 17 | 16 |
| Median warm request | 358 ms | 296 ms |
| p95 warm request | 408 ms | 334 ms |
| Maximum warm request | 423 ms | 380 ms |

“Confident” here means only the experiment's provisional rule: top probability
at least 0.65 and margin over the runner-up at least 0.20. These are uncalibrated
cutoffs. Uncertain → `other` is an operational fallback, so a supported request
sent to discovery still counts as a label error in the effective score.

The second run uses the **same** 100 transcripts after inspecting the baseline;
it is a development comparison, not held-out validation. There were 200 scored
inference calls, plus four warmup attempts. Subsequent restart/context-limit
checks are separate from the scored runs. Agent invocations: **zero**.

The second run's English score was 52/76 (68.4%); Czech was 12/24 (50%).
Topic/action-conflict cases scored 2/8. Increasing the probability cutoff does
not fix the problem: at 0.99 with margin 0.20, only 28 specific routes remain,
and five of those are still wrong (23/28 correct).

| Expected route | Cases | Baseline correct | Action wording correct |
| --- | ---: | ---: | ---: |
| planner | 8 | 1 | 2 |
| notes | 8 | 4 | 6 |
| agents | 8 | 4 | 4 |
| system | 8 | 8 | 8 |
| databases | 8 | 5 | 5 |
| air_quality | 8 | 7 | 7 |
| display | 8 | 5 | 5 |
| photos | 8 | 8 | 5 |
| shopping | 8 | 6 | 6 |
| printing | 8 | 8 | 7 |
| documents | 8 | 4 | 3 |
| other | 12 | 1 | 6 |

Examples from the action-wording run:

| Transcript | Expected | Actual | Top probability |
| --- | --- | --- | ---: |
| Add a task to buy milk tomorrow. | planner | shopping | 0.9701 |
| Remind me tomorrow to check the air quality. | planner | air_quality | 1.0000 |
| Implement a better air quality chart in the ST dashboard. | agents | air_quality | 0.9996 |
| The planner save button is broken. Fix the application code. | agents | planner | 0.9909 |
| Show the air quality dashboard on the faceplate. | display | air_quality | 0.9992 |
| Vysvětli mi, proč je nebe modré. | other | air_quality | 0.8740 |

The action descriptions improved `other` and notes while hurting photos,
printing and documents. Keep them as the next development starting point, not
as a proven production improvement. Do not add brittle keyword overrides just
to improve this corpus. Future comparisons can try fewer coarse domains,
alternative criteria, or a direct-agent baseline on fresh examples.

## Evidence and limitations

- [Frozen transcripts](transcripts.jsonl): hand-labeled synthetic examples.
- [Baseline summary](results/baseline/summary.json) and [all responses](results/baseline/results.jsonl).
- [Action-wording summary](results/action-wording/summary.json) and [all responses](results/action-wording/results.jsonl).
- Each result directory contains the exact catalog used. The active
  [catalog](../../assistant/routing/catalog.json) retains the action-wording
  criteria but now selects Clef Flash; use the frozen copy for exact reproduction.
- [Environment and model checksums](environment.json) record installed revisions.

The corpus SHA-256 is
`212c509f4434eb4068bb061a713982e4005c9be55eecb665db1f28a0935544f7`.
The model receives only the transcript, question and route criteria; expected
labels, tags, manuals and tools are never in the inference payload.

Latency is sequential wall-clock HTTP request time with a resident CPU model,
including JSON/network overhead. The first baseline warmup took 54.4 seconds
across three attempts while the model became ready; it includes initialization
and model acquisition and is not a pure cold-inference benchmark. The second
warmup took 350 ms. These measurements do not include wake detection, recording,
ASR, an agent, tool execution or TTS, and are not a controlled game-load benchmark.
After restarting with the model already cached and downloads disabled, the first
synthetic decision took 6.33 seconds, including lazy initialization.

The installation uses two CPU threads on the 6-core/12-thread AMD Custom CPU 1772
with about 62 GiB system memory. GPU inference was not benchmarked. The loaded
service cgroup used about 2.73 GiB during the experiment; that includes child
processes and charged cache, not just model weights. Downloaded model artifacts
occupy about 678 MB. Unsloth Studio installs a broader Python environment than a
standalone classifier, so this is not a minimal runtime footprint.

Recorded versions: Unsloth/Unsloth Zoo 2026.11.12, Python 3.13.17,
PyTorch 2.11.0+cpu, Transformers 5.5.4, vendored Laya 0.3.5. Unsloth source is
`f38ba996940fa17a2a0b6173a00c23e729003c98`; model
`convaiinnovations/laya`, subfolder `multilingual`, revision
`246177e5cb70334c9831c0730864a93c836aac8f`.

This checkpoint has `max_len=1024` and `head_max_len=256`. The installed endpoint
refuses oversized question/options heads and returns HTTP 422 when state would
be truncated. A separate overlong synthetic request checks that behavior after
restart. Future coordinators must fall back to general handling with the full
transcript on that error; trimming a spoken command can discard its real intent.

## Historical service setup

The following describes the original installation, independent of the disposable
Git worktree. **The model cache and user service were subsequently removed.**
Unsloth software and private experimental configuration remain. Commands below
require recreating the unit and downloading the pinned models; they do not
describe a currently available endpoint. See [retirement details](COMPARISON.md).

| Item | Location |
| --- | --- |
| Studio and decisions | `http://127.0.0.1:18888`, `POST /v1/systemone` |
| Source | `~/.local/share/st-laya/unsloth` |
| Studio home | `~/.local/share/st-laya/studio` |
| Launcher | `~/.local/share/st-laya/studio/bin/unsloth` |
| Python | `~/.local/share/st-laya/studio/unsloth_studio/bin/python` |
| Model cache | `~/.local/share/st-laya/huggingface` |
| User service | `~/.config/systemd/user/st-laya.service` |
| Owner password | `~/.config/st-laya/owner-password` |
| Inference API key | `~/.config/st-laya/api-key` |
| Bootstrap environment | `~/.config/st-laya/service.env` |

The Studio username is `unsloth`. Read the password file locally when logging in;
do not copy it into a chat, Git or a client bundle. The API key has inference
access rather than owner/admin access. Private files are mode 0600 in a 0700
directory. The bootstrap password was removed from `service.env` after the owner
account was initialized; the service was then restarted to discard that inherited
environment variable.

Only loopback is exposed. Cloudflare tunneling and Studio inference tools are
disabled. Laya is fixed to multilingual/CPU. After downloading the checkpoint,
Hugging Face and Transformers offline mode were enabled; the cached model works
after restart. No OpenAI subscription or API key is needed for these decisions.

From the Steam Machine:

```sh
systemctl --user status st-laya.service
systemctl --user restart st-laya.service
journalctl --user -u st-laya.service -n 60 --no-pager
```

From another computer, forward the loopback port over the existing SSH access:

```sh
ssh -N -L 18888:127.0.0.1:18888 YOUR_STEAM_MACHINE_SSH_HOST
```

Then open `http://127.0.0.1:18888` on that computer. Do not embed this API key in
Windows/Android clients; a local experiment coordinator would call it on their behalf.
The original service ran in the user's service manager. Hosted Clef Flash is
now selected; there is no automatic local model fallback.

To stop the experiment service persistently:

```sh
systemctl --user disable --now st-laya.service
```

## Reproduce the evaluation

From the `stapp` directory, with the installed service running:

```sh
python3 experiments/laya/evaluate.py \
  --api-key-file "$HOME/.config/st-laya/api-key" \
  --output /tmp/st-laya-new-run
```

The output path must not already exist. Pass `--catalog
experiments/laya/results/baseline/catalog.json` to replay the baseline criteria.
Keep result files immutable. The evaluator accepts only an HTTP loopback address,
disables environment proxies and redirects, validates probabilities, and contains
no agent-dispatch code. Failures yield a nonzero exit status and remain visible
in the output. This is an evaluation harness, not a production router.

## Recreate the installation

Use the official [Unsloth installation source](https://github.com/unslothai/unsloth)
and [Laya integration documentation](https://unsloth.ai/docs/models/decision-laya).
The command used here, from the pinned Unsloth source directory, was:

```sh
env UNSLOTH_STUDIO_HOME="$HOME/.local/share/st-laya/studio" \
  UNSLOTH_SKIP_AUTOSTART=1 UNSLOTH_TORCH_INDEX_FAMILY=cpu \
  TMPDIR="$HOME/.cache/st-laya/tmp" \
  sh ./install.sh --local --python 3.13
```

Create the temporary directory first. The installer resolves some transitive
dependencies from moving upstream revisions; the recorded environment describes
this installation rather than guaranteeing a byte-identical future install.

Use the [service example](../../deploy/laya/st-laya.service.example). On a new
machine, temporarily omit its two offline variables until the exact checkpoint
has been downloaded. Initialize Studio's owner login with a random local password
using `UNSLOTH_STUDIO_PASSWORD` in its private `service.env`, then remove that
bootstrap entry. Through the authenticated UI/API, enable decisions with the
PyTorch backend and mint an inference-only key. The environment fixes model and
device. Warm the model, verify the recorded revision, enable offline mode, and
restart. Keep credentials and downloaded weights outside the repository.

This task installed the model, evaluated routing, and prepared the implementation
contract. The next phase is a shadow coordinator and a text-first agent path;
microphones and live actions require their own integration acceptance work.
