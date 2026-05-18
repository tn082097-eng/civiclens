# Predictor — Agent Contract

Single source of truth for what the Predictor does. `pipeline.ts` and any
Hermes-invoked runs must follow this file. If code or SKILL.md contradicts,
this document wins.

## Purpose

Produce backtestable base-rate predictions for a politician's future voting
behavior, grounded entirely in the historical vote records the Researcher has
already collected. Every prediction is logged with its basis, resolution
date, and the calibration score of the model that produced it.

The Predictor does NOT claim to forecast specific outcomes. It reports base
rates and the calibration of several baseline models against the politician's
own historical record.

## INPUTS

1. `pipeline/<current-task-id>/researcher.json` — the subject.
2. Every other `pipeline/*/researcher.json` on disk — the corpus used for
   cross-member base rates (same chamber + party cohort).
3. No other sources. No LLM calls. No web fetches.

## OUTPUTS

Write `pipeline/<task-id>/predictor.json`:

```json
{
  "source":        "civiclens/predictor",
  "generatedAt":   "ISO-8601",
  "subject":       { "id": "slug", "name": "Full Name",
                     "chamber": "senate|house", "party": "..." },
  "sampleSize":    { "memberVotes": 500, "corpusMembers": 20 },
  "calibration":   [
    { "model": "historical-rate",
      "sampleSize": 150,
      "brierScore": 0.12,
      "logLoss":    0.41,
      "accuracy":   0.86,
      "buckets": [
        { "predictedLow": 0.0, "predictedHigh": 0.1, "actualRate": 0.04, "count": 22 }
      ]
    }
  ],
  "bestModel":     "historical-rate",
  "warnings":      ["..."]
}
```

`bestModel` is the model with the lowest Brier score among those that met the
minimum-sample threshold. `null` when no model qualifies.

## MUST DO

1. **Backtest before predicting.** Split the subject's votes temporally (older =
   train, newer = test). Report scores on the held-out set only.
2. **Binary votes only.** Filter out `abstain` / `absent` from both train and
   test. They're a different prediction class.
3. **Minimum sample size.** If the subject has fewer than 20 binary votes,
   emit empty calibration + a warning. Do not fabricate signal from small N.
4. **Publish misses.** Every prediction carries its resolution slot. When a
   prediction is wrong, it stays in the record — never edit history.
5. **Report multiple models.** At minimum: naive-half, historical-rate,
   laplace-smoothed, party-class-rate. The reader should see the baselines.
6. **Run deterministically.** Same inputs → same outputs. No randomness.

## MUST NOT

1. Do NOT write prose that predicts specific outcomes ("will vote yes").
   Probabilities and base rates only. The `noEditorializing` rule applies.
2. Do NOT call any LLM. The Predictor is deterministic code.
3. Do NOT use the Researcher's corpus as a "training set" in any ML sense —
   the corpus informs base rates only. No fitting of learned parameters
   across politicians.
4. Do NOT silently overwrite a prior predictor.json with resolutions edited.
   Resolution goes in a separate pass that appends.
5. Do NOT predict classes not covered by this contract (bill passage,
   revolving-door, etc.) until they have their own CONTRACT entries and
   backtests.

## Models (current)

| Model | Formula | Purpose |
|---|---|---|
| `naive-half` | P(yes) = 0.5 | Zero-information baseline. Any model beating this is doing something. |
| `always-yes` | P(yes) = 1.0 | Lower-bound diagnostic — if this beats other models, yes rate is so high that sophistication is noise. |
| `historical-rate` | yeas / (yeas + nays) on train | Member's own base rate. Strongest single-member signal. |
| `laplace-smoothed` | (yeas + 1) / (total + 2) | Same as above but handles small samples without overconfidence at 0 or 1. |
| `party-class-rate` | Weighted blend of member's own rate and same-chamber + same-party cohort rate. Own-weight scales with sample size. | Borrows strength from peers for sparse members. |

Adding a new model requires extending this table AND backtesting it against
at least two years of historical data before it appears in calibration output.

## INHERITS

- **no-stubs** — applies in full. No synthesized data, ever.
- **neutral-voice** — no prose output; the metrics ARE the output.
- **provenance** — each prediction carries the model name, the training
  window, and the sample size that produced it.

## Failure modes

| Symptom | Cause | Required response |
|---|---|---|
| Subject has 0 votes | Researcher returned empty votes array | Emit `{ calibration: [], bestModel: null, warnings: ["no votes available"] }`. Not an error. |
| Subject has <20 binary votes | Insufficient sample for calibration | Same as above with specific N-warning. |
| Party-class-rate has no peers | No corpus members share chamber + party | Drop `party-class-rate` from output with warning; other models still run. |
| All test predictions collapse to 0 or 1 | Member voted the same way every time in train | Still emit scores — the Brier will reflect it honestly. |
