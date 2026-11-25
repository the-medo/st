#!/usr/bin/env python3
"""Evaluate synthetic transcripts against local Unsloth. Never dispatch agent work."""

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request


HERE = Path(__file__).resolve().parent
CATALOG = HERE.parents[1] / "assistant/routing/catalog.json"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("The local decision endpoint must not redirect")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def percentile(values, p):
    return sorted(values)[max(0, math.ceil(len(values) * p) - 1)] if values else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:18888")
    parser.add_argument("--api-key-file", type=Path, required=True)
    # Historical local evaluator: the active catalog now selects hosted Clef Flash.
    parser.add_argument("--catalog", type=Path, default=HERE / "results/action-wording/catalog.json")
    parser.add_argument("--corpus", type=Path, default=HERE / "transcripts.jsonl")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=45)
    args = parser.parse_args()
    url = urllib.parse.urlsplit(args.base_url)
    if (url.scheme != "http" or url.hostname not in {"127.0.0.1", "::1"}
            or url.username or url.password or url.path not in {"", "/"}
            or url.query or url.fragment):
        parser.error("Use an HTTP loopback endpoint; this evaluator does not send transcripts remotely")
    catalog = json.loads(args.catalog.read_text())
    rows = [json.loads(line) for line in args.corpus.read_text().splitlines() if line.strip()]
    ids = [row["id"] for row in rows]
    if len(ids) != len(set(ids)) or len({r["transcript"] for r in rows}) != len(rows):
        parser.error("Corpus IDs and transcripts must be unique")
    criteria = {r["id"]: r["description"] for r in catalog["routes"]}
    if "other" not in criteria or any(r["expected_route"] not in criteria for r in rows):
        parser.error("All expected routes and the other fallback must exist")
    # Refuse overwrite so a rerun cannot silently replace the baseline evidence.
    args.output.mkdir(parents=True, exist_ok=False)
    token = args.api_key_file.read_text().strip()
    if not token:
        parser.error("API key file is empty")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    questions = {"route": {"type": "choice", "instructions": catalog["instructions"], "criteria": criteria}}
    policy = catalog["provisional_policy"]

    def decide(transcript):
        request = urllib.request.Request(
            args.base_url.rstrip("/") + "/v1/systemone",
            data=json.dumps({"model": catalog["model"], "state": transcript, "questions": questions}).encode(),
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
            method="POST",
        )
        with opener.open(request, timeout=args.timeout) as response:
            return json.load(response)

    started = datetime.now(timezone.utc).isoformat()
    # First model load is measured separately. Only 503 gets bounded warmup retries.
    warm_start = time.perf_counter()
    warm_attempts = 0
    while True:
        warm_attempts += 1
        try:
            decide("Check the system memory usage.")
            break
        except urllib.error.HTTPError as error:
            if error.code != 503 or time.perf_counter() - warm_start > 180:
                raise
            time.sleep(2)
    warmup_ms = round((time.perf_counter() - warm_start) * 1000, 2)
    results = []
    with (args.output / "results.jsonl").open("w") as stream:
        for row in rows:
            start = time.perf_counter()
            result = dict(row)
            try:
                response = decide(row["transcript"])
                answer = response["answers"]["route"]
                probabilities = answer["probabilities"]
                if set(probabilities) != set(criteria):
                    raise ValueError("Response probability labels differ from catalog")
                if any(not isinstance(p, (int, float)) or not math.isfinite(p) or not 0 <= p <= 1
                       for p in probabilities.values()):
                    raise ValueError("Invalid response probabilities")
                if abs(sum(probabilities.values()) - 1) > 0.02:
                    raise ValueError("Response probabilities do not sum to one")
                ranked = sorted(probabilities.items(), key=lambda item: item[1], reverse=True)
                choice = answer["choice"]
                if choice not in criteria or probabilities[choice] < ranked[0][1]:
                    raise ValueError("Invalid response choice")
                p = probabilities[choice]
                margin = ranked[0][1] - ranked[1][1]
                uncertain = p < policy["minimum_probability"] or margin < policy["minimum_margin"]
                effective = "other" if uncertain else choice
                result.update(raw_choice=choice, effective_route=effective, uncertain=uncertain,
                              top_probability=p, margin=margin,
                              correct=choice == row["expected_route"],
                              effective_correct=effective == row["expected_route"], response=response)
            except Exception as error:
                # Never persist the token or provider response body on failure.
                result.update(error=type(error).__name__, http_status=getattr(error, "code", None),
                              correct=False, effective_correct=False)
            result["elapsed_ms"] = round((time.perf_counter() - start) * 1000, 2)
            stream.write(json.dumps(result, ensure_ascii=False) + "\n")
            stream.flush()
            results.append(result)
            print(f"{row['id']}: expected={row['expected_route']} predicted={result.get('raw_choice', 'ERROR')} "
                  f"p={result.get('top_probability', 0):.3f} {result['elapsed_ms']:.0f}ms", flush=True)

    completed = [r for r in results if "error" not in r]
    accepted = [r for r in completed if not r["uncertain"] and r["raw_choice"] != "other"]
    timings = [r["elapsed_ms"] for r in completed]
    confusion = defaultdict(Counter)
    groups = {}
    for row in results:
        confusion[row["expected_route"]][row.get("raw_choice", "ERROR")] += 1
    for field in ("language", "tag", "expected_route"):
        groups[field] = {
            key: {"count": len(subset), "correct": sum(r["correct"] for r in subset)}
            for key in sorted({r[field] for r in results})
            for subset in [[r for r in results if r[field] == key]]
        }
    summary = {
        "started_at": started, "finished_at": datetime.now(timezone.utc).isoformat(),
        "catalog_sha256": digest(args.catalog), "corpus_sha256": digest(args.corpus),
        "catalog_version": catalog["catalog_version"], "model": catalog["model"],
        "request_count": len(results), "successful_responses": len(completed),
        "warmup_requests": warm_attempts, "warmup_ms": warmup_ms,
        "raw_correct": sum(r["correct"] for r in results),
        "effective_correct": sum(r["effective_correct"] for r in results),
        "uncertain_fallbacks": sum(r.get("uncertain", False) for r in results),
        "accepted_specific_routes": len(accepted),
        "accepted_specific_correct": sum(r["correct"] for r in accepted),
        "confident_errors": [r["id"] for r in completed if not r["uncertain"] and not r["correct"]],
        "latency_ms": {"median": statistics.median(timings) if timings else None,
                       "p95": percentile(timings, .95), "max": max(timings) if timings else None},
        "policy": policy, "by_group": groups, "confusion": dict(confusion),
        "agent_invocations": 0,
        "scope": "Synthetic text routing only; not microphone, ASR, agent execution or TTS validation.",
    }
    (args.output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    (args.output / "catalog.json").write_bytes(args.catalog.read_bytes())
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if len(completed) == len(rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
