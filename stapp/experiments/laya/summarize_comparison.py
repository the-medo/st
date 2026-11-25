#!/usr/bin/env python3
"""Validate the five complete benchmark runs and emit a compact comparison."""

import argparse
import csv
import hashlib
import json
from pathlib import Path

from benchmark import evaluate_answer, summarize
from evaluate import HERE


MODELS = [
    ("laya-multilingual", "Laya multilingual"),
    ("kev-0.8b", "Kev 0.8B"),
    ("kev-4b", "Kev 4B"),
    ("d1-2b", "LiquidAI d1 2B"),
    ("cloudflare-clef-flash", "Cloudflare Clef Flash"),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=Path, default=HERE / "results/comparison")
    args = parser.parse_args()
    corpus_bytes = (HERE / "transcripts.jsonl").read_bytes()
    corpus = [json.loads(l) for l in corpus_bytes.decode().splitlines()]
    corpus_digest = hashlib.sha256(corpus_bytes).hexdigest()
    catalog_digests = set()
    records = []
    for directory, label in MODELS:
        folder = args.runs / directory
        run = json.loads((folder / "summary.json").read_text())
        rows = [json.loads(l) for l in (folder / "results.jsonl").read_text().splitlines()]
        catalog_bytes = (folder / "catalog.json").read_bytes()
        catalog = json.loads(catalog_bytes)
        criteria = {r["id"]: r["description"] for r in catalog["routes"]}
        assert len(rows) == len(corpus) == 100, directory
        assert run["successful_responses"] == 100 and run["fatal_error"] is None, directory
        assert run["agent_invocations"] == 0 and not run["resources"]["sampling_errors"], directory
        assert run["corpus_sha256"] == corpus_digest, directory
        assert run["catalog_sha256"] == hashlib.sha256(catalog_bytes).hexdigest(), directory
        catalog_digests.add(run["catalog_sha256"])
        for expected, row in zip(corpus, rows):
            assert all(row[k] == v for k, v in expected.items()), (directory, expected["id"])
            validated = evaluate_answer(row["response"], criteria, catalog["provisional_policy"], expected["expected_route"])
            assert all(row[k] == v for k, v in validated.items()), (directory, expected["id"])
        recalculated = summarize(rows)
        assert all(run[k] == v for k, v in recalculated.items()), directory
        phases = run["resources"]["phases"]
        idle, warm, startup = (phases[k] for k in ["loaded_idle", "warm_requests", "first_request"])
        samples = [json.loads(l) for l in (folder / "resources.jsonl").read_text().splitlines()]
        assert samples and all(s["process_count"] > 0 and s["pss_bytes"] > 0 for s in samples), directory
        record = dict(
            id=directory, label=label, provider=run["provider"], correct=run["raw_correct"],
            english_correct=run["by_group"]["language"]["en"]["correct"],
            czech_correct=run["by_group"]["language"]["cs"]["correct"],
            median_ms=run["latency_ms"]["median"], p95_ms=run["latency_ms"]["p95"],
            first_request_ms=run["first_request"]["elapsed_ms"],
            mean_cpu_seconds=run["cpu_seconds_per_request"]["mean"],
            idle_cpu_percent_one_core=idle["cpu_percent_one_core"],
            active_cpu_percent_one_core=warm["cpu_percent_one_core"],
            loaded_idle_pss_mib=idle["pss_bytes"]["median"] / 1024**2,
            inference_peak_pss_mib=warm["pss_bytes"]["max"] / 1024**2,
            startup_peak_pss_mib=startup["pss_bytes"]["max"] / 1024**2,
            overall_peak_pss_mib=max(s["pss_bytes"] for s in samples) / 1024**2,
            unloaded_baseline_pss_mib=phases["unloaded_idle"]["pss_bytes"]["median"] / 1024**2,
            accepted_specific_routes=run["accepted_specific_routes"],
            accepted_specific_correct=run["accepted_specific_correct"],
            uncertain_fallbacks=run["uncertain_fallbacks"],
            confident_errors=len(run["confident_errors"]),
            effective_correct=run["effective_correct"],
            first_request_attempts=run["first_request"]["attempts"],
            host_load_1m_min=min(s["host_load_1m"] for s in samples),
            host_load_1m_max=max(s["host_load_1m"] for s in samples),
            minimum_host_available_gib=min(s["host_available_bytes"] for s in samples) / 1024**3,
            resource_scope=run["resources"]["scope"],
        )
        if run["provider"] == "local":
            assert not any(s["memory_events"].get("oom", 0) or s["memory_events"].get("oom_kill", 0) for s in samples), directory
            record.update(peak_cgroup_mib=max(s["cgroup_current_bytes"] for s in samples) / 1024**2,
                          peak_swap_mib=max(s["cgroup_swap_bytes"] for s in samples) / 1024**2)
        else:
            record["estimated_cloud_cost_usd"] = run["cloudflare_cost"]["estimated_usd_scored"]
            record["input_tokens"] = run["cloudflare_cost"]["input_tokens_scored"]
        records.append(record)
    assert len(catalog_digests) == 1, "Criteria differ between models"
    result = {"corpus_sha256": corpus_digest, "catalog_sha256": catalog_digests.pop(),
              "cases_per_model": 100, "scored_requests": 500, "agent_invocations": 0,
              "rows": records}
    (args.runs / "comparison.json").write_text(json.dumps(result, indent=2) + "\n")
    keys = list(dict.fromkeys(k for row in records for k in row))
    with (args.runs / "comparison.csv").open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=keys)
        writer.writeheader()
        writer.writerows(records)
    lines = ["# Measured comparison", "", "500 scored requests; 100 identical synthetic transcripts per model; no agent calls.", "",
             "| Model | Correct /100 | English /76 | Czech /24 | Median | p95 | Idle local PSS | Sampled peak local PSS¹ | CPU seconds/request² |",
             "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for r in records:
        memory = lambda k: f"{r[k] / 1024:.2f} GiB" if r[k] >= 1024 else f"{r[k]:.0f} MiB"
        lines.append(f"| [{r['label']}]({r['id']}/summary.json) | {r['correct']} | {r['english_correct']} | {r['czech_correct']} | "
                     f"{r['median_ms'] / 1000:.3f} s | {r['p95_ms'] / 1000:.3f} s | {memory('loaded_idle_pss_mib')} | "
                     f"{memory('overall_peak_pss_mib')} | {r['mean_cpu_seconds']:.3f} |")
    lines += ["", "¹ Peak includes model initialization. PSS is sampled every 0.5 seconds; brief spikes can be missed.",
              "² Local rows cover the complete Unsloth service and descendants. Cloudflare RAM/CPU here cover only the local HTTP benchmark client; remote inference RAM/CPU are unavailable.", "",
              "| Model | First request³ | Loaded idle CPU⁴ | Active CPU⁴ | Confidently wrong | Accepted specific routes correct | Uncertain fallbacks |",
              "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for r in records:
        lines.append(f"| {r['label']} | {r['first_request_ms'] / 1000:.3f} s | {r['idle_cpu_percent_one_core']:.2f}% | "
                     f"{r['active_cpu_percent_one_core']:.1f}% | {r['confident_errors']} | "
                     f"{r['accepted_specific_correct']}/{r['accepted_specific_routes']} | {r['uncertain_fallbacks']} |")
    lines += ["", "³ Local: first request after a service restart, model files already cached. Cloudflare: first observed request, remote coldness unknown.",
              "⁴ 100% is one logical core; divide by 12 for whole-machine percentage. Cloudflare's idle client percentage includes the benchmark sampling thread.", "",
              "The acceptance rule is the same uncalibrated top probability ≥0.65 and margin ≥0.20 for every model. Few confident errors can reflect low acceptance coverage, not high general accuracy.", "",
              "See [measurement methodology](../../MEASUREMENT.md) for limits and reproduction.", ""]
    (args.runs / "comparison.md").write_text("\n".join(lines))
    print(json.dumps(records, indent=2))


if __name__ == "__main__":
    main()
