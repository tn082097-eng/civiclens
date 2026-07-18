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
   curation surface is the overlap set, not 8k names.
   No auto-match reaches the detector without a confirm row. Confirmation is
   based only on objective identity evidence — SEC issuer identity, SAM.gov
   parent identity, publicly verifiable corporate ownership — never on
   whether the overlap looks interesting; each confirm row cites its
   evidence.

The confirmation workflow is implemented so that the curator has access only
to information necessary to determine corporate identity (recipient name,
normalized name, parent entity, candidate ticker, and supporting identity
metadata). No contract values, district assignments, member identities,
overlap statistics, trade dates, or detector outputs are displayed during
confirmation (`pipeline/patterns/recipient-trade-candidates.ts`).

Restricting the worklist to tickers traded in-window by ANY roster member is
a pre-registered computational optimization of the curation surface, not an
analytical filter based on observed detector results: candidate generation
itself is recipient → normalized name → SEC ticker, independent of outcomes.
The roster-wide (not own-member) scope is what keeps the confirmed set
uncorrelated with the observed member↔district pairing under the shuffle
null.

Parent resolution follows the authoritative SAM.gov parent relationship
without attempting economic attribution among subsidiaries: GE AVIATION →
GE is an identity statement, not a claim about how much of the parent's
value the district contract represents (same caution for conglomerates like
RTX or Alphabet).

## Pre-registered null model (registered before any results exist)

Overlap statistic, per member, computed only over confirmed tickers:
- **S1 (breadth):** count of distinct tickers both traded in-window and
  confirmed as district-contract recipients. Weights a $500 contract equal
  to a $5B one by design — it measures how *broadly* a member's trading
  touches their district's contractor base.
- **S2 (exposure):** Σ district contract dollars of those tickers — the
  dollar scale of the overlap. S1 and S2 answer different questions; both
  must clear the gate.

**Null:** shuffle member↔district assignment across the House roster; 2,000
permutations, fixed seed, mulberry32 — same harness pattern as
`pipeline/patterns/district-contract-baseline.ts`. Recompute S1/S2 roster-wide
per shuffle. Credibility gate: observed roster-level S1 AND S2 exceed the
null at p < 0.05. Baseline runs BEFORE any hand-tracing of individual hits
(Step-0 rule). If the baseline fails, the detector is not registered — no
threshold tuning afterward (theme-detector lesson).

**Exchangeability (why the shuffle is valid):** under the null, after
conditioning on each member's observed trading behavior and each district's
observed contractor composition, there is no association between a member
and their own district beyond random assignment. Permutations preserve each
member's trade set and each district's confirmed recipient set unchanged;
only the member↔district pairing is shuffled. Districts with hundreds of
recipients keep them; members trading 5 or 200 tickers keep them.

**Ubiquity exclusion (pre-registered):** any ticker whose confirmed
recipients receive contracts in more than 1/3 of roster districts is
excluded from observed AND null statistics. The cutoff is a design
criterion, not a tuned constant: a company receiving contracts in most
districts (MSFT/LMT contract everywhere) is treated as lacking district
specificity — its presence cannot distinguish a member's own district from
a shuffled one. One-third is pre-registered here and will not be adjusted
after results exist.

**Timing layer (descriptive only):** trade within 90 days of an award action
may sharpen the narrative of a confirmed hit. It is NOT part of the
confirmatory statistic in v1.

**Negative control (pre-registered, runs with the baseline):** permute
confirmed ticker identities across the confirm table while preserving each
member's trade count and each district's recipient count, then rerun the
detector. This control must reliably return null; a detector that fires on
identity-scrambled data is reading marginals, not pairings. Run before any
hand-tracing, reported next to the main baseline.

## Evaluation caveats

- Evaluate on trading members: ro-khanna and mike-turner have zero
  in-window traded tickers — overlap is impossible for them by construction.
  Excluding zero-trade members affects statistical power, not validity.
- Same substrate calls as the theme detector: `district_original`,
  CY2023–25, transactions spending level, House-only.
- Probe parent lookups were capped at top-40 unmatched per district; the
  full harvest lifts the cap.

## Go / no-go

GO on feasibility. Build starts only after user review of this spec. Gates
at build time, in order: SOURCES.md freeze (done) → confirm-table curation →
pre-registered baseline → only then hand-tracing and render.
