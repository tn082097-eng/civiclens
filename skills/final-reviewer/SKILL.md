---
name: final-reviewer
description: Deterministic QC gate (no LLM). Reads prior agent outputs, runs a fixed checklist, and sets readyToApply. Called by the pipeline as the last step before sync-task loads the run into DuckDB.
tools: Read, Write, Bash
---

# Final Reviewer Agent

Deterministic QC gate — **no model call**. The decision derives purely from the
upstream validators (Data Checker), the neutrality gate (Code Checker), and the
completeness of the rendered narrative fields. Implemented in
`agents/final-reviewer.ts` (`runFinalReviewer`). Do not generate data or fix issues.

> History: an earlier version ran an LLM narrative review. It could only ever
> downgrade `approved`→`approved_with_warnings`, never reject, so it added a
> nondeterministic call with no gate-changing power. Removed in Phase 1.

## Step 1: Read upstream outputs

Reads (via `readPipe`) from `pipeline/<task-id>/`:
`researcher`, `data-checker`, `summarizer`, `code-checker`.
(No `coder` read — the Coder agent was deleted in Phase 1.)

## Step 2: Checklist

| Check | Gate |
|---|---|
| `data-checker.passed` = true | critical |
| `data-checker.score` ≥ 0.70 | warning |
| `summarizer.bio.length` ≥ 60 | warning |
| `summarizer.neutralNarrative.length` ≥ 100 | warning |
| `summarizer.keyFacts.length` ≥ 2 | warning |
| `summarizer.neutralityViolations` empty | warning |
| `code-checker.passed` = true | critical |
| `code-checker.score` ≥ 0.70 | warning |
| `code-checker.neutralityCheck` = "pass" | critical |

## Step 3: Decision

- **rejected** — any critical check fails (`dataCheckerPassed`, `codeCheckerPassed`, `neutralityCheckPass`)
- **approved_with_warnings** — no critical failures, but 3+ warning checks fail
- **approved** — otherwise

`readyToApply = decision !== 'rejected'`.

## Step 4: Output

Writes `pipeline/<task-id>/final-review.json` (`taskId`, `reviewedAt`, `decision`,
`politicianId`, `politicianName`, `checklist`, `issues`, `summary`, `readyToApply`)
and updates pipeline state via `setStatus`/`markAgent` (state lives in
`agents/shared.ts` / `pipeline_runs`, not the deleted `lib/state.ts`).
On approval the run is loaded into DuckDB by `sync-task` — there is no separate
`--apply`/`seed.ts` step.
