# Recipient-level trade↔contract detector — design spec

**Date:** 2026-07-17 · **Status:** SPEC — build NOT green-lit. Successor to
the gated theme-level detector
(`docs/2026-07-15-district-contracts-detector.md`, permutation p=0.483, tag
`negative-experiment/district-contract-theme`). This doc pre-registers the
null model BEFORE any overlap results are computed.
**Substrate probe:** SOURCES.md §USAspending Endpoint 3 (frozen 2026-07-17,
`pfd-cache/usaspending-recipient-probe-2026-07-17/`).

## Pattern statement

> A member personally trades stock of the specific company receiving federal
> contracts performed in their district.

District-specific by construction. The theme detector failed because neither
side carried district information (Defense ≈49% of every district's mapped
dollars; portfolios are mega-cap-alike). A named contractor in a named
district is not a base rate.

## Feasibility verdict: GO

- Parent resolution is source-side: `GET /recipient/{id}/` returns the
  SAM.gov parent (HOWMEDICA OSTEONICS → STRYKER, GE AVIATION → GE, DB
  CONTROL → HEICO). We do not solve subsidiary mapping ourselves.
- Auto-resolution covered 3%–65% of top-100 recipient dollars by district
  (NJ-05 38%, CA-17 65% incl. $3.9B Lockheed, FL-23 3%, OH-10 8%).
- One genuine overlap already observed: Gottheimer traded NICE; NICE SYSTEMS
  holds $30.9M of NJ-05 contracts.
- False positives (ULCC↔Frontier Technology, SCI↔Enterprise Technology
  Solutions) prove auto-matching alone cannot ship → confirm-table design.

## Identity resolution — two stages, recall then precision

1. **Auto-candidate matcher** (recall): normalized-name match against SEC
   `company_tickers.json`, own name first, then SAM.gov parent name.
2. **`recipient_ticker` confirm table** (precision): hand-curated rows, only
   for pairs where the member actually traded the candidate ticker — the
   curation surface is the overlap set, not 8k names. No auto-match reaches
   the detector without a confirm row.

## Pre-registered null model (registered before any results exist)

Overlap statistic, per member, computed only over confirmed tickers:
- **S1 (binary):** count of distinct tickers both traded in-window and
  confirmed as district-contract recipients.
- **S2 (dollar-weighted):** Σ district contract dollars of those tickers.

**Null:** shuffle member↔district assignment across the House roster; 2,000
permutations, fixed seed, mulberry32 — same harness pattern as
`pipeline/patterns/district-contract-baseline.ts`. Recompute S1/S2 roster-wide
per shuffle. Credibility gate: observed roster-level S1 AND S2 exceed the
null at p < 0.05. Baseline runs BEFORE any hand-tracing of individual hits
(Step-0 rule). If the baseline fails, the detector is not registered — no
threshold tuning afterward (theme-detector lesson).

**Ubiquity exclusion (pre-registered):** any ticker whose confirmed
recipients receive contracts in more than 1/3 of roster districts is
excluded from observed AND null statistics. MSFT/LMT contract everywhere;
presence carries no district information.

**Timing layer (descriptive only):** trade within 90 days of an award action
may sharpen the narrative of a confirmed hit. It is NOT part of the
confirmatory statistic in v1.

## Evaluation caveats

- Evaluate on trading members: ro-khanna and mike-turner have zero
  in-window traded tickers — overlap is impossible for them by construction.
- Same substrate calls as the theme detector: `district_original`,
  CY2023–25, transactions spending level, House-only.
- Probe parent lookups were capped at top-40 unmatched per district; the
  full harvest lifts the cap.

## Go / no-go

GO on feasibility. Build starts only after user review of this spec. Gates
at build time, in order: SOURCES.md freeze (done) → confirm-table curation →
pre-registered baseline → only then hand-tracing and render.
