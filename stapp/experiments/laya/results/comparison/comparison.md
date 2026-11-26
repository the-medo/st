# Measured comparison

500 scored requests; 100 identical synthetic transcripts per model; no agent calls.

| Model | Correct /100 | English /76 | Czech /24 | Median | p95 | Idle local PSS | Sampled peak local PSS¹ | CPU seconds/request² |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [Laya multilingual](laya-multilingual/summary.json) | 64 | 52 | 12 | 0.296 s | 0.331 s | 2.11 GiB | 2.63 GiB | 0.597 |
| [Kev 0.8B](kev-0.8b/summary.json) | 69 | 56 | 13 | 1.498 s | 1.608 s | 1.75 GiB | 1.76 GiB | 2.993 |
| [Kev 4B](kev-4b/summary.json) | 91 | 68 | 23 | 7.512 s | 7.747 s | 5.23 GiB | 5.23 GiB | 14.794 |
| [LiquidAI d1 2B](d1-2b/summary.json) | 88 | 69 | 19 | 2.302 s | 2.420 s | 2.47 GiB | 2.47 GiB | 4.552 |
| [Cloudflare Clef Flash](cloudflare-clef-flash/summary.json) | 97 | 73 | 24 | 0.190 s | 0.448 s | 16 MiB | 16 MiB | 0.004 |

¹ Peak includes model initialization. PSS is sampled every 0.5 seconds; brief spikes can be missed.
² Local rows cover the complete Unsloth service and descendants. Cloudflare RAM/CPU here cover only the local HTTP benchmark client; remote inference RAM/CPU are unavailable.

| Model | First request³ | Loaded idle CPU⁴ | Active CPU⁴ | Confidently wrong | Accepted specific routes correct | Uncertain fallbacks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Laya multilingual | 6.141 s | 0.44% | 199.0% | 16 | 51/67 | 32 |
| Kev 0.8B | 2.373 s | 0.44% | 197.9% | 2 | 27/29 | 64 |
| Kev 4B | 8.343 s | 0.42% | 197.2% | 0 | 32/32 | 60 |
| LiquidAI d1 2B | 2.930 s | 0.44% | 197.7% | 2 | 70/71 | 19 |
| Cloudflare Clef Flash | 0.506 s | 0.17% | 1.6% | 2 | 85/87 | 4 |

³ Local: first request after a service restart, model files already cached. Cloudflare: first observed request, remote coldness unknown.
⁴ 100% is one logical core; divide by 12 for whole-machine percentage. Cloudflare's idle client percentage includes the benchmark sampling thread.

The acceptance rule is the same uncalibrated top probability ≥0.65 and margin ≥0.20 for every model. Few confident errors can reflect low acceptance coverage, not high general accuracy.

See [measurement methodology](../../MEASUREMENT.md) for limits and reproduction.
