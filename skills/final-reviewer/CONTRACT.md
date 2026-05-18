# Final Reviewer — Agent Contract

Single source of truth for the Final Reviewer. `pipeline.ts` and Hermes-invoked
runs both follow this file. If code or SKILL.md contradicts, this document wins.

## Purpose

Decide whether the full pipeline output is fit to ship. The last gate before
Publisher. Combines a deterministic QC checklist (most of the work) with a
single model-based narrative-quality read. Outputs one of three decisions:
`approved`, `approved_with_warnings`, `rejected`.

## Architecture — two stages

- **Stage 1 — deterministic QC checklist (code only):** Walks every prior
  agent's output and verifies invariants (pass flags, scores, min-length
  thresholds, violation counts). Produces a boolean per check.
- **Stage 2 — narrative quality review (model):** A single bounded call
  asking a neutral-reviewer persona whether the narrative is publication-
  ready. Advisory — not authoritative.

## INPUTS

1. All prior agents' outputs in `pipeline/<task-id>/`:
   `researcher.json`, `data-checker.json`, `summarizer.json`, `coder.json`,
   `code-checker.json` (plus optional `connection-mapper.json`, `visualizer.json`).
2. No external inputs.

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
  "narrativeReview": { "model": "...", "passed": true, "notes": "..." },
  "issues":        [{ "check": "name", "severity": "critical|warning" }]
}
```

## MUST DO (stage 1, code)

1. **Verify Data Checker passed** with score ≥ 0.70.
2. **Verify Code Checker passed** with score ≥ 0.70 and neutralityCheck = `pass`.
3. **Verify Summarizer output:** bio ≥60 chars, narrative ≥100 chars,
   ≥2 keyFacts, 0 neutrality violations.
4. **Verify Coder classified the run:** `action` and `politicianId` present.
5. **Classify failed checks as critical vs non-critical.** Critical set:
   `dataCheckerPassed`, `codeCheckerPassed`, `neutralityCheckPass`. Any
   critical failure → decision = `rejected`.

## MUST DO (stage 2, model)

1. **Call the narrative model** with a QC-reviewer persona prompt including
   headline, bio, keyFacts, narrative. Ask 3 YES/NO questions: neutral tone,
   any bias, suitable for publication.
2. **Treat model "not publication-ready" as a warning,** not critical.
   The decision becomes `approved_with_warnings`, not `rejected`.

## Decision matrix

| Critical failures | Non-critical fails | Narrative review | Decision |
|---|---|---|---|
| Any | — | — | rejected |
| 0 | 0 | pass | approved |
| 0 | 1-2 | pass | approved |
| 0 | ≥3 | any | approved_with_warnings |
| 0 | any | fail | approved_with_warnings |

## MUST NOT

1. Do not let the model override the checklist. Deterministic checks are
   authoritative for `rejected`; the model can only escalate from
   `approved` → `approved_with_warnings`.
2. Do not run if any prior agent's output file is missing — fail instead.
3. Do not invent check names outside the canonical checklist.

## INHERITS

- **no-stubs** — applies via dependency (all inputs must themselves be
  contract-compliant).
- **neutral-voice** — applies to the narrative review's own notes.
- **provenance** — not directly applicable (no new factual claims).

## Failure modes

| Symptom | Cause | Required response |
|---|---|---|
| Any critical check fails | upstream agent produced bad data | `rejected`, pipeline stops |
| ≥3 non-critical warnings | quality drift | `approved_with_warnings` |
| Narrative model call errors | timeout or bad parse | skip the narrative flag; decision based on checklist alone |
| Missing prior output file | earlier agent failed without being caught | fail the Final Reviewer |
