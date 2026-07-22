# ADR 0002 — Launch scope, descriptive-detector policy, and verified-artifact deployment

**Date:** 2026-07-09
**Status:** Accepted
**Deciders:** maintainer, at the single-member milestone publish gate

> Provenance: records the product decisions closed at the 2026-07-08/09
> single-member (Gottheimer) milestone so future sessions inherit them instead
> of re-litigating. Where this names files, verify against the live tree.

## A. Descriptive trade-timing detectors are descriptive — by policy, not omission

`trade-vote-alignment` and `spousal-trade-timing` (pipeline/patterns/) are
**descriptive envelopes**: they count true, cited proximities (trade within 14
days before a vote with a committee-jurisdiction nexus) and emit an
intensity from the trade-analyst rubric. They have **no null model** and make
**no statistical claim**.

Consequences accepted:

- For a high-volume basket trader (e.g. 1,923 disclosed transactions), these
  detectors fire near maximum intensity **mechanically** — proximity to some
  committee-handled vote is guaranteed by trade volume alone. This is known,
  verified behavior (a 71-trade member produces zero hits from the same code),
  not a bug.
- The render layer is the honesty boundary: `confidencePhrase()` in
  `render/build.ts` gives every unscored hit the explicit lead
  *"Based on N cited records; not statistically scored against a null model"*
  and no stat line. **This caveat copy is intentional and load-bearing. Do not
  remove or soften it.**
- No causal language anywhere: findings are neutral counts with citations.
- **Null-model calibration of these detectors is future work, not a launch
  blocker.** When it happens it must populate the existing
  `null_model/observed/expected/p_value/n_perm` columns on `pattern_hits`
  (the render already upgrades its language automatically when those are
  present) — not change the descriptive counting.

The statistical layer that DOES exist (theme-gaps permutation scoring,
`pipeline/score-theme-gaps.ts`, 10k permutations) renders separately in the
Trade–vote timing section with real p-values. The two layers must never be
conflated.

Required product language (verbatim, maintainer-set):

> The detector identifies reproducible patterns in available data. It does
> not establish causation or statistical significance.

## B. Launch scope: single member first

- The current publish target is a **single-member launch** (Josh Gottheimer,
  the verified end-to-end page).
- Corpus-wide pages — `index.html`, `network.html`, `nexus.html` — are
  **deferred** until the roster is validated roster-wide. They aggregate all
  ~57 members, 37 of whom have no trade data loaded; publishing them now would
  surface visibly partial members.
- `render/build.ts --member <slug>` builds one page and does not touch the
  corpus pages. There is deliberately **no** single-member *site* mode yet;
  building one is future work to be decided at roster-launch time, not
  retrofitted now.

## C. Deployment: verified-artifact, never a CI rebuild

- `.github/workflows/deploy.yml` (workflow_dispatch-only, dormant) originally
  invoked `render/build.ts`, which requires `data/civiclens.duckdb`. The DB is
  not in git and must never be published: the repo is public, a Release asset
  or CI-delivered DB would expose the raw OpenSecrets-derived `donor_industry`
  table (substrate-only rule — OpenSecrets data fuels detectors but is not
  republished), and a CI build would render all ~58 members, contradicting
  the single-member launch scope in §B.
- **Decision: deploy the already-verified site bytes.** Flow: local verified
  build → committed launch artifact (`public/`, assembled by
  `scripts/package-launch.sh` from byte-diff-verified `site/` output) →
  GitHub Pages via `actions/upload-pages-artifact`. CI runs no Node build, no
  pipeline loaders, needs no secrets, and publishes exactly the bytes that
  passed local determinism verification.
- **Full database regeneration in CI is out of scope** — the pipeline takes
  hours, needs API keys, and CI-side regeneration would create a second
  source of truth. Continuous data-rebuild infrastructure is future work.

## Out of scope for this ADR

Detector mathematics, new detectors, architecture changes, roster growth.

> The statistical-integrity policy for confirmatory detector analyses — one
> preregistered run per detector, FAIL archived not optimized, new hypothesis ⇒
> new registration — is **ADR 0003**
> (`docs/adr/0003-preregistered-confirmatory-analysis-policy.md`).
