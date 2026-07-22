# <detector-name> — pre-registration spec

**Date:** YYYY-MM-DD · **Status:** SPEC — confirmatory run NOT green-lit.
**Detector ID:** `<detector-id>` (must match the row in
`docs/confirmatory-runs.md` and the `guard:confirmatory` argument).

> This doc pre-registers the hypothesis, statistic, null model, constants, seed
> strings, and decision rule BEFORE any outcome is known (ADR 0003 —
> preregistered confirmatory-analysis policy). Fill every section before the run.
> The confirmatory run is ONE shot; its result is final and recorded below.

## Governance checklist (ADR 0003 — do not skip)

- [ ] A row for `<detector-id>` exists in `docs/confirmatory-runs.md` with
      `status: registered`.
- [ ] The pre-run guard passes: `npm run guard:confirmatory -- <detector-id>`
      (exit 0 = clear; exit 1 = STOP, run already consumed).
- [ ] All constants below were fixed before any roster-wide result existed; any
      known priors are disclosed in "Prior-exploration disclosure."

## Hypothesis

State H0 and the alternative in one paragraph each. What real-world mechanism
would produce a signal, and what does "no signal" look like?

## Scope — what this registers (and what it does not)

Name the detector file(s). State explicitly what is NOT being changed.

## Statistic(s) (per member / per unit)

Define each observed statistic precisely, pointing at the shared function that
computes it (the "one spine" — the same rule for observation, tests, and every
null draw).

## Null model

- Model + dispatch rule, with every constant (window, thresholds, permutation
  count) named and justified as pre-committed.
- Exchangeability argument: under H0, what is exchangeable and why.
- Stated limitations / accepted approximations.

## Constants (frozen)

List them explicitly (e.g. `WINDOW_DAYS`, `N_PERM`, dispatch thresholds). No
constant may be adjusted in response to any result.

## Seed strings (verbatim)

- Formal run: `<pattern>-preregistered-v1|<member>`
- Negative control, replicate i: `<pattern>-nc-scramble-v1-<i>|<member>`,
  `<pattern>-nc-null-v1-<i>|<member>`

## Negative control (runs BEFORE the formal run — Step-0 rule)

Design, extent (replicates), and the pre-registered pass criterion. The control
is the machinery-validity gate; it is evaluated before any formal result is
hand-traced.

## Decision rule (pre-registered)

State the exact PASS/FAIL rule and what each outcome means operationally
(register / archive / language-only gate / etc.). This is fixed now.

## Prior-exploration disclosure (mandatory honesty)

Any known priors from exploratory runs, and the pre-committed mitigations.

---

## Confirmatory run record (append ONCE, after the run — ADR 0003)

> Filled in exactly once, when the confirmatory run executes. Then update the
> `docs/confirmatory-runs.md` row (`status`, `run_commit`, `outcome`). A FAIL is
> archived as a negative result — not retuned or rerun. A materially different
> hypothesis is a NEW spec + NEW detector ID, never an edit to this record.

- **Run date / commit:**
- **DB fingerprint (sha256):**
- **Negative-control verdict:** (pooled rate, worst member, PASS/FAIL)
- **Formal result:** (observed / expected / p-value / z per statistic)
- **Decision (per the rule above):** PASS → … / FAIL → archived as negative.
- **Invalidation (if any, later):** link to the dated amendment documenting why
  the original run was not a valid execution; only this reopens the run.
