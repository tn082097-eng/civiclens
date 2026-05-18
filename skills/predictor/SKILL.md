---
name: predictor
description: Produces backtestable base-rate predictions for a politician's voting behavior. Reads researcher.json + corpus, emits predictor.json with calibration scores (Brier, log-loss, accuracy) for several baseline models. Deterministic code — no LLM calls.
tools: Read, Write, Bash
---

# Predictor Agent

Given a politician's historical vote record (from the Researcher), fit several baseline predictive models, backtest them on a temporal hold-out split, and report calibration scores per model. Write results to `~/.hermes/civiclens/pipeline/<task-id>/predictor.json`.

## Mission alignment

The rest of the pipeline is retrospective by design. The Predictor is prospective — but the editorial rule still holds, because a probability grounded in a base rate is falsifiable, not an opinion. If we say 94% and it comes in 94%, we're calibrated. If we say 94% and it comes in 50%, that miss belongs on the page as loudly as the prediction did.

The full design rationale and scope is in `~/.hermes/civiclens/plans/prediction-agent.md`.

## Invocation

Standalone:

```bash
npx tsx skills/predictor/predict.ts <task-id>
```

From pipeline.ts (when wired in): `runPredictor(task)` after the Researcher succeeds.

## Output schema

See `CONTRACT.md` for the full schema. TL;DR:

```json
{
  "source": "civiclens/predictor",
  "generatedAt": "...",
  "subject": { "id": "...", "name": "...", "chamber": "...", "party": "..." },
  "sampleSize": { "memberVotes": 0, "corpusMembers": 0 },
  "calibration": [ { "model": "...", "brierScore": 0, "logLoss": 0, "accuracy": 0, "buckets": [...] } ],
  "bestModel": "model-name | null",
  "warnings": []
}
```

## Models included today

- **naive-half** — 0.5 for everything. Zero-information baseline.
- **always-yes** — 1.0 always. Upper-bound diagnostic.
- **historical-rate** — the member's own yes rate on train.
- **laplace-smoothed** — smoothed version, robust at small N.
- **party-class-rate** — blend of own rate with same-chamber + same-party cohort rate from the corpus, weight scaling with sample size.

Each model is scored on a held-out 30% of the member's most recent votes.

## Minimum data threshold

Fewer than **20 binary (yea/nay) votes** on the subject → no calibration, explicit warning. The Predictor will not report scores it cannot defend.
