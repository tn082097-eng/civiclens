# ADR 0003 — Preregistered confirmatory-analysis policy

**Date:** 2026-07-20
**Status:** Proposed
**Deciders:** maintainer (acceptance not yet recorded)

> Provenance: CivicLens validates statistical detectors with *preregistered
> confirmatory analyses* (the rigor-pillar design,
> `docs/superpowers/specs/2026-05-27-rigor-pillar-design.md`; first applied to
> the district-contracts and recipient-trade detectors). Two detectors have
> already run their single confirmatory analysis and been archived as negative
> results. This ADR records the scientific-governance policy that made those
> outcomes final, so it is inherited rather than re-litigated — and so it is
> enforced by process, not by memory. Where this names files, verify against the
> live tree.

## Context

A detector that emits a statistical claim (a p-value, a null-model comparison)
is only credible if the analysis was specified *before* its outcome was known.
CivicLens does this with a preregistration spec (`docs/<date>-<detector>.md`)
that fixes — ahead of any roster-wide result — the statistic, the null model,
the permutation scheme, the constants (windows, thresholds, permutation count),
the seed strings, and the decision rule.

Preregistration is only worth anything if the run is treated as *confirmatory*:
one shot, evaluated against the pre-committed rule, result kept whichever way it
falls. The failure mode this policy exists to prevent is **outcome-driven
iteration** — rerunning a failed detector with a different seed, permutation
count, dataset, or threshold until it clears the gate, then presenting that as
"the" result. That is p-hacking with extra steps, and it silently converts a
confirmatory analysis into an exploratory one without disclosure.

Two detectors have already reached this boundary:

- **district-contracts** — both spines failed their pre-registered baselines
  (theme p=0.48, recipient-trade p=0.74; negative control clean). Archived; no
  v2 without a genuinely new mechanism.
- **recipient-trade** — one confirmatory baseline, GATE FAIL (S1 p=0.7445, S2
  p=0.3760, negative control 0/20), commit `a47ca81`. Detector not registered.
  Thread closed.

The recipient-trade closure was almost violated on 2026-07-20 when a workflow
was pointed at it for a "rerun." Nothing in the repo *mechanically* stopped a
second confirmatory computation — the halt depended on an executor remembering
the history. That is the gap this ADR closes.

## Decision

CivicLens adopts the following policy for every detector that makes a
statistical claim.

### 1. One preregistered confirmatory run per detector

Each detector gets exactly **one** confirmatory execution of its preregistered
protocol. "Confirmatory" means: run the pre-committed statistic and null under
the pre-committed constants and seeds, and evaluate against the pre-committed
decision rule. The result is **final** the moment it is recorded.

### 2. Failed confirmatory analyses are archived, not optimized

A FAIL under the preregistered decision rule is archived as a **negative
result**. The detector is not tuned, re-seeded, re-permuted, or re-run to chase
a passing outcome. A negative result is a real result — it is recorded in the
spec and kept.

### 3. New hypotheses require new preregistration

A failed experiment may motivate new work, but any **materially different**
hypothesis, feature set, statistical procedure, dataset, or decision rule
constitutes a **new experiment**. It requires its own preregistration spec and a
distinct detector ID, and must never be presented as a "rerun" of the original.
(Changing the permutation count, the seed strings, or the substrate query and
calling it the same run is precisely the disguised-exploratory move this
forbids.)

### 4. Exceptions require documented invalidation of the original run

The **only** path back to re-running a consumed confirmatory analysis is a
*documented invalidation* of the original run: evidence that the original
execution was not a valid instance of the preregistered protocol — e.g. an
implementation defect in the scoring code, corrupted or wrong input data, or a
reproducibility failure. The invalidation must be written down (a dated
amendment to the detector's spec, or a superseding ADR) **before** any
replacement run is executed. A replacement run after documented invalidation is
still one confirmatory run under the same registration; it is a *repair*, not a
second attempt.

**The evidence is required, not just the status.** In the registry
(`docs/confirmatory-runs.md`), a detector reopens only when the `invalidation`
column carries a non-empty documented reference. A bare `status: invalidated`
with an empty reference is an *unevidenced exception* and the guard fails closed
on it — enforcing that the documentation exists before the replacement run, not
after.

Distinguishing the two kinds of change:

- **Recomputation after a data refresh** (new PFD filings, new votes) is NOT a
  rerun of the confirmatory analysis — scores are a deterministic function of
  (data, seed), and the then-current honest number is expected. This is routine
  and needs no invalidation. What is fixed is the *design*, not the computation.
- **Re-running the same design on the same data to get a different answer** is
  forbidden without documented invalidation.

## Enforcement (this ADR is mirrored downward)

Policy at the ADR level is not self-enforcing. It is mirrored into the artifacts
people and agents actually execute, so the rule exists at several levels:

| Layer | Artifact | Role |
|---|---|---|
| Policy | this ADR (0003) | scientific-governance decision |
| Registry | `docs/confirmatory-runs.md` | the machine-readable ledger of consumed runs |
| Spec | detector preregistration `docs/<date>-<detector>.md` | applies the policy to one experiment; records its run outcome |
| AI/human instructions | `AGENTS.md`, `CLAUDE.md`, `civiclens-core` skill | tells executors to run the preflight and preregister |
| Machine-checkable preflight | `npm run guard:confirmatory -- <detector-id>` (`scripts/confirmatory-guard.ts`) | reports whether a run may proceed; exits non-zero on a consumed, non-invalidated detector |
| In-path guard | `assertConfirmatoryAllowed()` called inside each `*-baseline.ts` runner | blocks the supported confirmatory runners before any outcome-bearing computation |

**Pre-run invariant.** Each confirmatory *runner* (the dedicated
`pipeline/patterns/*-baseline.ts` scripts) calls `assertConfirmatoryAllowed()`
at the top of `main()`, before it opens the DB or computes anything. If the
detector's confirmatory run is already consumed and not invalidated, the runner
aborts non-zero **before any statistical computation** — this is enforced in the
execution path of the supported runners, not only by a chained preflight.

**Scope of the guarantee (be precise).** The in-path guard blocks execution
**when a confirmatory analysis is invoked through the supported command path**
(the `*-baseline.ts` runners). It does **not** make confirmatory reruns
mechanically impossible in general: a caller who writes a new, unguarded script
that imports the scoring internals directly, or who edits the registry, is
outside the guarded workflow. The routine recompute paths (`run-patterns.ts`,
`score-anomaly.ts`) intentionally do **not** hard-block — recomputation after a
data refresh is permitted (see the recompute/rerun distinction above) — they
emit a soft advisory when a scored detector's confirmatory run is not yet
consumed. This is a *guarded workflow*, not a sandbox.

## Phase 1 scope / known limitations

This ADR + implementation is **Phase 1: repository policy, registry,
machine-checkable preflight, and mandatory in-path protection of the existing
confirmatory runners.** It deliberately does NOT yet include:

- The registry is a **markdown file** (`docs/confirmatory-runs.md`), not a
  database or append-only log — it can be edited by hand.
- Detectors are keyed by **detector ID**, not an immutable registration ID /
  content hash — a spec can change under a fixed ID without the guard noticing.
- **No atomic `registered → running` reservation** — nothing claims a run before
  it starts.
- **No concurrency control** — two simultaneous runs are not prevented.
- **No protocol / code / data hash validation** — the guard does not verify that
  the code, constants, or DB match what was preregistered.
- **No formal invalidation workflow** — invalidation is a manual markdown edit
  (a link in the `invalidation` column), not a CLI with an audit trail.
- **No replacement-registration lineage** — a post-invalidation repair run is
  not linked to the original as a distinct tracked artifact.

These are Phase 2 candidates, out of scope for this pass.

## Consequences

- **Accepted:** some detectors will end as archived negatives, permanently. That
  is the point — a transparency project that only ships positive results is
  selecting on outcome.
- **Accepted:** the registry must be updated when a confirmatory run completes
  (part of the run's own record-keeping, alongside the spec append). A run that
  is not recorded is not protected by the guard.
- **Accepted:** protection covers the supported runners and the manual preflight;
  novel unguarded execution paths and manual registry edits are outside the
  guarantee (Phase 2).

## Related

- ADR 0002 §A — the descriptive detectors this policy's scoring layer upgrades.
- `docs/superpowers/specs/2026-05-27-rigor-pillar-design.md` — the null-model
  machinery.
- `docs/2026-07-15-district-contracts-detector.md`,
  `docs/2026-07-17-recipient-trade-detector.md` — the two archived negatives
  that motivated writing the policy down.
