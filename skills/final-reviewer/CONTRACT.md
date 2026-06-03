# Final Reviewer — Agent Contract

Single source of truth for the Final Reviewer. `pipeline.ts` and Hermes-invoked
runs both follow this file. If SKILL.md contradicts, this document wins; the
implementation is `agents/final-reviewer.ts`.

## Purpose

Decide whether the full pipeline output is fit to load into DuckDB. The last gate
before `sync-task` publishes the run. **Deterministic — no model call.** Outputs
one of three decisions: `approved`, `approved_with_warnings`, `rejected`.

> History: this was once a two-stage gate with a stage-2 narrative LLM read. That
> call could only ever escalate `approved`→`approved_with_warnings`, never reject,
> so it was nondeterministic with no gate-changing power. Removed in Phase 1, along
> with the Coder/Publisher/`seed.ts` topology this contract used to reference.

## Architecture — single deterministic stage

Walks the relevant prior agents' outputs and verifies invariants (pass flags,
scores, min-length thresholds, violation counts). Produces a boolean per check;
the decision is a pure function of those booleans.

## INPUTS

1. Prior agents' outputs in `pipeline/<task-id>/`:
   `researcher.json`, `data-checker.json`, `summarizer.json`, `code-checker.json`.
   (No `coder.json` — the Coder agent was deleted in Phase 1.)
2. No model calls. No external inputs.

## OUTPUTS

Write `pipeline/<task-id>/final-review.json`:

```json
{
  "taskId":        "task-...",
  "reviewedAt":    "ISO-8601",
  "decision":      "approved|approved_with_warnings|rejected",
  "politicianId":  "slug",
  "politicianName":"Full Name",
  "checklist":     { "checkName": true/false },
  "issues":        [{ "category": "checklist", "severity": "critical|warning", "message": "..." }],
  "summary":       "...",
  "readyToApply":  true
}
```

## MUST DO

1. **Verify Data Checker passed** (`passed` = true; `score` ≥ 0.70).
2. **Verify Code Checker passed** (`passed` = true; `score` ≥ 0.70; `neutralityCheck` = `pass`).
3. **Verify Summarizer output:** bio ≥ 60 chars, `neutralNarrative` ≥ 100 chars,
   ≥ 2 `keyFacts`, 0 `neutralityViolations`.
4. **Classify failed checks as critical vs warning.** Critical set:
   `dataCheckerPassed`, `codeCheckerPassed`, `neutralityCheckPass`.
5. **Set `readyToApply = decision !== 'rejected'`.**

## Decision matrix

| Critical failures | Warning fails | Decision |
|---|---|---|
| Any | — | rejected |
| 0 | 0–2 | approved |
| 0 | ≥3 | approved_with_warnings |

## MUST NOT

1. Do not call a model. The checklist is authoritative for all three decisions.
2. Do not run if a required prior output file is missing — fail instead.
3. Do not invent check names outside the canonical checklist.

## INHERITS

- **no-stubs** — applies via dependency (all inputs must themselves be
  contract-compliant).
- **provenance** — not directly applicable (no new factual claims).

## Failure modes

| Symptom | Cause | Required response |
|---|---|---|
| Any critical check fails | upstream agent produced bad data | `rejected`, pipeline stops |
| ≥3 warning checks fail | quality drift | `approved_with_warnings` |
| Missing prior output file | earlier agent failed without being caught | fail the Final Reviewer |
