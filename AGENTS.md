# AGENTS.md — execution rules for humans and AI agents

Repo-level operating contract. The durable project brain lives in the
`civiclens-core` skill; this file records the rules that must be enforced **in
the repo, at execution time** — chiefly the confirmatory-analysis governance
that protects the project's statistical integrity.

## Preregistered confirmatory analyses (ADR 0003 — never violate)

CivicLens validates statistical detectors with *preregistered confirmatory
analyses*. Policy: `docs/adr/0003-preregistered-confirmatory-analysis-policy.md`.

1. **One confirmatory run per detector.** Once executed, the result is FINAL.
2. **FAIL is archived, not optimized.** No retuning, re-seeding, re-permuting, or
   re-running to chase a passing outcome. A negative result is a real result.
3. **New hypothesis ⇒ new preregistration.** A materially different hypothesis,
   feature set, statistical procedure, dataset, or decision rule is a NEW
   experiment with its own spec + detector ID — never a "rerun."
4. **Exceptions require documented invalidation** of the original run (defect,
   corrupted data, reproducibility failure), written down *before* any
   replacement run.

### Confirmatory guard — two layers

**In-path (automatic).** Each confirmatory runner (`pipeline/patterns/*-baseline.ts`)
calls `assertConfirmatoryAllowed()` at the top of `main()`, before it opens the
DB or computes anything. A consumed, non-invalidated detector aborts the runner
non-zero **before any outcome-bearing computation**. This protects the supported
command path automatically — you do not have to remember to chain the preflight.

**Preflight (manual, for reporting).** Before beginning a confirmatory workflow
you can also run the machine-checkable preflight to see the verdict up front:

```bash
npm run guard:confirmatory -- <detector-id>   # exit 0 = clear, exit 1 = STOP
```

- **Exit 1 (STOP):** the detector already consumed its confirmatory run and is
  not invalidated. Report the archived result.
- **Exit 0:** clear to proceed (registered-and-unconsumed, or invalidated with a
  repair permitted).

The preflight and the in-path guard share one implementation
(`pipeline/patterns/_confirmatory-guard.ts`). Running the preflight is good
practice, but it is the **in-path** call that blocks the supported runners.

**Scope (be honest about it).** This blocks execution *when a confirmatory
analysis is invoked through the supported `*-baseline.ts` runners*. It does NOT
make reruns mechanically impossible in general — a new unguarded script that
imports the scoring internals directly, or a hand-edited registry, is outside the
guarded workflow (ADR 0003, Phase 2 limitations). The routine recompute paths
(`run-patterns.ts`, `score-anomaly.ts`) deliberately warn rather than block, so
data-refresh recomputation still works.

The guard reads `docs/confirmatory-runs.md` (the registry). When a confirmatory
run completes, updating that row — `status`, `run_commit`, `outcome` — is part of
the run's own record-keeping, alongside appending the result to the spec. **A run
not recorded there is not protected by the guard.**

### New detector? Preregister first

Copy `docs/_detector-spec-template.md` → `docs/<date>-<detector>.md`, fill every
section before running, and add a `status: registered` row to
`docs/confirmatory-runs.md`.

## Confirmatory-run review checklist

Before approving any change that touches a scored detector or runs a
confirmatory analysis, verify:

- [ ] The detector has a preregistration spec, and it was written before the run.
- [ ] `npm run guard:confirmatory -- <id>` passes (or a documented invalidation
      is on record).
- [ ] No constant (window, threshold, permutation count), seed string, statistic,
      null model, or decision rule was changed in response to a result.
- [ ] Negative control ran and was evaluated BEFORE the formal run (Step-0 rule).
- [ ] The confirmatory result is recorded in both the spec and
      `docs/confirmatory-runs.md`.
- [ ] A FAIL is archived as a negative result — not rescued with extra analyses.
- [ ] Any "rerun" is either a data-refresh recomputation (design unchanged) or a
      documented-invalidation repair — not a disguised second attempt.

## General

- No stub data — fail loudly, never fall back to LLM-generated placeholders.
- Primary sources only; freeze samples to `SOURCES.md` before building.
- Never claim success without running the actual verification step.
- Full project rules + checklists: the `civiclens-core` skill (`STATUS.md` for
  live state).
