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

> **Amended 2026-07-28 — roster launch.** The single-member phase closed. The
> inclusion rule below supersedes the single-member target; the rest of this
> section (deferred corpus pages, no single-member site mode) stands unchanged.

- ~~The current publish target is a **single-member launch** (Josh Gottheimer,
  the verified end-to-end page).~~ Superseded — see the inclusion rule below.
- Corpus-wide pages — `index.html`, `network.html`, `nexus.html` — are
  **deferred** until the roster is validated roster-wide. They aggregate all
  ~57 members, 37 of whom have no trade data loaded; publishing them now would
  surface visibly partial members.
- `render/build.ts --member <slug>` builds one page and does not touch the
  corpus pages. There is deliberately **no** single-member *site* mode yet;
  building one is future work to be decided at roster-launch time, not
  retrofitted now.

### B.1 Inclusion rule (amendment, 2026-07-28)

A member is published when **both** hold:

1. Their theme-gaps band is **`ranked`** or **`low-power`** — i.e. the member
   has enough theme-mappable trades for the page to say something. Members at
   `insufficient-data` are not published; their pages would be honest but
   empty, which is the failure §B was written to prevent.
2. They are a **sitting member of the current Congress**. Publication is
   opt-in via the `MEMBERS` array in `scripts/package-launch.sh`, so
   non-sitting members cannot leak onto the site by default; this criterion
   makes the exclusion deliberate rather than incidental.

Rationale for the band threshold rather than a raw trade count: the band
denominator is *theme-mappable* trades, so it already accounts for the
crosswalk coverage gap. A member with many trades that never resolve to a
theme legitimately stays unpublished until the crosswalk improves — the fix
belongs in `db/load-sector-crosswalk.ts`, not in a lowered publish bar.

Applying the rule at the 2026-07-28 roster launch yields **10 members**:
gottheimer · goldman · moskowitz · frankel · whitehouse · pelosi · moore ·
wyden · collins · crenshaw.

`marjorie-taylor-greene` meets criterion 1 (band `ranked`) but fails
criterion 2: she resigned effective 2026-01-05 (`members.in_office = false`,
`term_end 2026-01-05`; her vote record ends 2025-12-18 and congress.gov
returns no committee assignments). Her data is complete and correct through
her last day — she is excluded as a non-sitting member, not as a data defect.

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
