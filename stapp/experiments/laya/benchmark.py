#!/usr/bin/env python3
"""Compare synthetic decisions with latency and resource measurements; no agent dispatch."""

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import statistics
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request

from evaluate import CATALOG, HERE, NoRedirect, percentile
from resources import Sampler


def evaluate_answer(response, criteria, policy, expected):
    if response.get("truncated"):
        raise ValueError("Truncated input")
    answer = response["answers"]["route"]
    probabilities = answer["probabilities"]
    if set(probabilities) != set(criteria):
        raise ValueError("Unexpected labels")
    if any(isinstance(p, bool) or not isinstance(p, (int, float)) or not math.isfinite(p)
           or not 0 <= p <= 1 for p in probabilities.values()):
        raise ValueError("Invalid probability")
    if abs(sum(probabilities.values()) - 1) > .02:
        raise ValueError("Invalid probability sum")
    ranked = sorted(probabilities.items(), key=lambda item: item[1], reverse=True)
    choice = answer["choice"]
    if choice not in criteria or probabilities[choice] < ranked[0][1]:
        raise ValueError("Invalid choice")
    p = probabilities[choice]
    margin = ranked[0][1] - ranked[1][1]
    uncertain = p < policy["minimum_probability"] or margin < policy["minimum_margin"]
    effective = "other" if uncertain else choice
    return dict(raw_choice=choice, effective_route=effective, uncertain=uncertain,
                top_probability=p, margin=margin, correct=choice == expected,
                effective_correct=effective == expected)


def summarize(rows):
    good = [r for r in rows if "error" not in r]
    accepted = [r for r in good if not r["uncertain"] and r["raw_choice"] != "other"]
    times = [r["elapsed_ms"] for r in good]
    cpu = [r["cpu_seconds"] for r in good]
    confusion = defaultdict(Counter)
    for row in rows:
        confusion[row["expected_route"]][row.get("raw_choice", "ERROR")] += 1
    groups = {}
    for field in ("language", "tag", "expected_route"):
        groups[field] = {}
        for key in sorted({r[field] for r in rows}):
            subset = [r for r in rows if r[field] == key]
            groups[field][key] = {"count": len(subset), "correct": sum(r["correct"] for r in subset)}
    return dict(request_count=len(rows), successful_responses=len(good),
                raw_correct=sum(r["correct"] for r in rows),
                effective_correct=sum(r["effective_correct"] for r in rows),
                uncertain_fallbacks=sum(r.get("uncertain", False) for r in rows),
                accepted_specific_routes=len(accepted),
                accepted_specific_correct=sum(r["correct"] for r in accepted),
                confident_errors=[r["id"] for r in good if not r["uncertain"] and not r["correct"]],
                latency_ms={"median": statistics.median(times) if times else None,
                            "p95": percentile(times, .95), "max": max(times) if times else None},
                cpu_seconds_per_request={"mean": statistics.mean(cpu) if cpu else None,
                                         "median": statistics.median(cpu) if cpu else None,
                                         "total": sum(cpu)},
                by_group=groups, confusion=dict(confusion))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=["local", "cloudflare"], default="local")
    parser.add_argument("--model", required=True)
    parser.add_argument("--api-key-file", type=Path)
    parser.add_argument("--cloudflare-config", type=Path)
    parser.add_argument("--base-url", default="http://127.0.0.1:18888")
    parser.add_argument("--cgroup", type=Path)
    parser.add_argument("--catalog", type=Path, default=CATALOG)
    parser.add_argument("--corpus", type=Path, default=HERE / "transcripts.jsonl")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--idle-seconds", type=float, default=30)
    parser.add_argument("--baseline-seconds", type=float, default=15)
    parser.add_argument("--timeout", type=float, default=90)
    args = parser.parse_args()
    if args.idle_seconds < 0 or args.baseline_seconds < 0:
        parser.error("Measurement durations must be nonnegative")
    catalog_bytes = args.catalog.read_bytes()
    corpus_bytes = args.corpus.read_bytes()
    catalog = json.loads(catalog_bytes)
    cases = [json.loads(line) for line in corpus_bytes.decode().splitlines() if line.strip()]
    criteria = {r["id"]: r["description"] for r in catalog["routes"]}
    if (not cases or len(cases) != len({r["id"] for r in cases})
            or len(cases) != len({r["transcript"] for r in cases})
            or "other" not in criteria or any(r["expected_route"] not in criteria for r in cases)):
        parser.error("Invalid corpus or catalog")
    if args.provider == "local":
        url = urllib.parse.urlsplit(args.base_url)
        if (url.scheme != "http" or url.hostname not in {"127.0.0.1", "::1"}
                or url.username or url.password or url.path not in {"", "/"} or url.query or url.fragment):
            parser.error("Local inference requires an HTTP loopback URL")
        if not args.api_key_file or not args.cgroup:
            parser.error("Local runs require --api-key-file and --cgroup")
        endpoint = args.base_url.rstrip("/") + "/v1/systemone"
        token = args.api_key_file.read_text().strip()
    else:
        if args.model != "clef-flash" or not args.cloudflare_config or args.cgroup:
            parser.error("Cloud runs require clef-flash and --cloudflare-config, without --cgroup")
        config = json.loads(args.cloudflare_config.read_text())
        account = config["account_id"]
        if not re.fullmatch(r"[a-f0-9]{32}", account):
            parser.error("Invalid Cloudflare account ID")
        auth = tomllib.loads(Path(config["wrangler_auth_file"]).read_text())
        token = auth["oauth_token"]
        expiry = datetime.fromisoformat(auth["expiration_time"].replace("Z", "+00:00"))
        if expiry <= datetime.now(timezone.utc):
            parser.error("Wrangler login expired; run wrangler whoami to refresh it")
        endpoint = f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/clef-flash"
    if not token:
        parser.error("Credential is empty")
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / "catalog.json").write_bytes(catalog_bytes)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    questions = {"route": {"type": "choice", "instructions": catalog["instructions"], "criteria": criteria}}

    def decide(transcript):
        req = urllib.request.Request(endpoint,
            data=json.dumps({"model": args.model, "state": transcript, "questions": questions}).encode(),
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        with opener.open(req, timeout=args.timeout) as response:
            body = json.load(response)
        if args.provider == "cloudflare":
            if body.get("success") is not True:
                raise ValueError("Cloudflare request failed")
            body = body["result"]
        return body

    sampler = Sampler(args.cgroup)
    started = datetime.now(timezone.utc).isoformat()
    records = []
    cold = {}
    fatal = None
    sampler.start()
    try:
        sampler.phase = "unloaded_idle"
        time.sleep(args.baseline_seconds)
        sampler.phase = "first_request"
        cpu_start = sampler.cpu()
        t = time.perf_counter()
        attempts = 0
        while True:
            attempts += 1
            try:
                response = decide("Check the system memory usage.")
                evaluate_answer(response, criteria, catalog["provisional_policy"], "system")
                break
            except urllib.error.HTTPError as error:
                if error.code != 503 or time.perf_counter() - t > 240:
                    raise
                time.sleep(2)
        cold = {"elapsed_ms": round((time.perf_counter() - t) * 1000, 2),
                "cpu_seconds": sampler.cpu() - cpu_start, "attempts": attempts,
                "response": response, "note": "First request after local service restart with files cached; cloud coldness unknown."}
        sampler.phase = "warm_requests"
        with (args.output / "results.jsonl").open("w") as stream:
            for case in cases:
                row = dict(case)
                cpu_start = sampler.cpu()
                t = time.perf_counter()
                try:
                    response = decide(case["transcript"])
                    row.update(evaluate_answer(response, criteria, catalog["provisional_policy"], case["expected_route"]),
                               response=response)
                except Exception as error:
                    row.update(error=type(error).__name__, http_status=getattr(error, "code", None),
                               correct=False, effective_correct=False)
                row["elapsed_ms"] = round((time.perf_counter() - t) * 1000, 2)
                row["cpu_seconds"] = max(0, sampler.cpu() - cpu_start)
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
                stream.flush()
                records.append(row)
                print(f"{args.model} {case['id']}: {row.get('raw_choice', 'ERROR')} "
                      f"{row['elapsed_ms']:.0f}ms cpu={row['cpu_seconds']:.3f}s", flush=True)
                # A quota/auth error is not a reason to hammer the endpoint for the remaining cases.
                if row.get("http_status") in {401, 403, 429}:
                    raise RuntimeError("Authentication or rate-limit response; run stopped")
        sampler.phase = "loaded_idle"
        time.sleep(args.idle_seconds)
    except Exception as error:
        fatal = {"type": type(error).__name__, "http_status": getattr(error, "code", None)}
    finally:
        sampler.stop()
        (args.output / "resources.jsonl").write_text("".join(json.dumps(s) + "\n" for s in sampler.samples))
        result = {"started_at": started, "finished_at": datetime.now(timezone.utc).isoformat(),
                  "provider": args.provider, "model": args.model,
                  "catalog_version": catalog["catalog_version"],
                  "catalog_sha256": hashlib.sha256(catalog_bytes).hexdigest(),
                  "corpus_sha256": hashlib.sha256(corpus_bytes).hexdigest(),
                  "policy": catalog["provisional_policy"], "first_request": cold,
                  **summarize(records), "resources": sampler.summarize(),
                  "fatal_error": fatal, "agent_invocations": 0,
                  "measurement": "Sequential synchronous HTTP from Steam Machine; no connection pooling, proxies or redirects. Downloads completed before local measurement."}
        if args.provider == "cloudflare":
            tokens = sum(r.get("response", {}).get("usage", {}).get("input_tokens", 0) for r in records)
            result["cloudflare_cost"] = {"input_tokens_scored": tokens, "usd_per_million_input_tokens": .038,
                                         "estimated_usd_scored": tokens / 1_000_000 * .038,
                                         "pricing_source": "https://developers.cloudflare.com/workers-ai/models/clef-flash/",
                                         "note": "Published rate estimate before any free allowance; no remote CPU/RAM telemetry."}
        (args.output / "summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({k: result[k] for k in ["model", "raw_correct", "successful_responses", "latency_ms", "fatal_error"]}), flush=True)
    return 0 if fatal is None and len(records) == len(cases) and all("error" not in r for r in records) else 1


if __name__ == "__main__":
    raise SystemExit(main())
