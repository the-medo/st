---
name: st-voice-capability
description: Add or change a capability in the S.T. voice assistant, including Clef Flash routing criteria, agent context, callable tools and spoken results. Use for extending the assistant, not for carrying out an ordinary spoken task.
---

Work from the S.T. repository root. Read its AGENTS.md/local preferences and the
instructions for the component being changed. Locate the root with Git rather
than assuming a particular checkout path. If the routing documents below are
absent, inspect `git worktree list` for the current assistant feature checkout;
do not silently recreate them from the older implementation.

Read `stapp/IMPLEMENTATION.md`, `stapp/docs/assistant-routing.md` and
`stapp/assistant/routing/catalog.json`. They distinguish working tools from
planned adapters. Clef Flash is the selected provider; local decision models and
their service were removed. The benchmark performs classification only; the new
catalog is not yet wired into the production worker. Consult the routing guide
for dedicated token setup; do not depend on a developer's Wrangler login.

For a requested capability:

1. Identify the real service/API, its configured availability, and the requested
   actions. A dashboard link or a category name does not provide a callable tool.
   Reuse an existing route when the action fits; preserve the general `other` path.
2. Add/update a short action-oriented criterion, route readiness, trusted manual
   paths and actual tool interface. Keep model input short; the agent receives
   manuals and schemas after routing. Never put credentials or household records
   in the catalog. Check the provider's complete input budget before sending;
   Clef Flash can silently truncate long inputs. Preserve the full agent transcript.
3. Specify the agent context: original full transcript, authenticated device,
   timezone, current entity IDs/versions, availability, fresh data and source links.
   Add discovery for other domains. A wrong route must remain correctable.
4. Implement through the integration's business rules. Preserve request IDs on
   retry, origin-specific replies and planner version/recurrence behavior. Route
   probabilities do not authorize a purchase, physical print or destructive change.
5. Add synthetic positive cases, confusing neighboring intents, multilingual
   phrases where supported, and out-of-scope requests. Keep existing baseline
   files immutable. Re-evaluate with the Clef Flash classifier-only harness and report
   raw accuracy, fallback/accepted errors, p50/p95 and language breakdown. Label
   tuning on previously inspected examples as development evaluation.
6. Provide a short non-completion acknowledgement and confirmed success/failure/
   clarification speech. Preserve the full answer in the conversation. Validate
   integration effects separately from routing; classifier-only tests never call
   agents or mutate household services.

Run from `stapp`:

```sh
python3 experiments/laya/benchmark.py \
  --provider cloudflare --model clef-flash \
  --cloudflare-config "$HOME/.config/st-assistant/cloudflare.json" \
  --output /path/to/new-evaluation-directory
```

Use only synthetic transcripts in versioned results. Do not overwrite a previous
run, present model confidence as measured correctness, or promote a route to
strict tool restriction based on the current small development corpus.
Keep credentials on the coordinator. Missing/invalid credentials or a routing
failure must use general discovery with the full transcript, without retry storms.
