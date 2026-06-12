# CivicLens — Member Page: Moment of Insight (Ranked Receipts)

**Date:** 2026-06-11
**Status:** Design (pre-implementation; implementation queued behind phase-2 closeout PRs per ship-over-plan)
**Owner:** duckjustice
**Scope:** Reorganize the member page around a single insight — receipts of theme-matched trade→vote pairs, ranked by statistical rarity, with negative results as a first-class outcome. Demotes (does not delete) the existing section-stack layout. Depends on roster-wide rollout of the rigor pillar (extends `2026-05-27-rigor-pillar-design.md`, which scoped a deliberate one-member vertical slice).

---

## Decision trail

1. A throwaway prototype (`render/prototype-braid.ts` → `site/prototype-braid.html`, 2026-06-11) tested three timeline shapes on real Pelosi data (71 trades, 61 theme-matched pairs from `v_trade_bill_nexus`): **A** braided three-lane timeline, **B** industry-theme swimlanes, **C** vertical chronological ledger.
2. Product owner's critique: none had a moment of insight. The braid is "dots and lines" the viewer must decode; the ledger is a compliance report. The strongest element on screen was the yellow **"N days later"** gap tags — the relationship, not the chart. Proposal: make the relationship the hero, as ranked case-file cards.
3. Engineer's pushback: ranking by raw gap is a cherry-picking machine (6,393 naive date-proximity pairs collapse to 61 only after theme matching; trades cluster, the House votes constantly, so short gaps are statistically inevitable). Rank by surprise vs the null model instead.
4. Adversarial review (Grok, 2026-06-11, archived in vault: `Projects/CivicLens/2026-06-11 Grok design review — member page.md`) accepted both halves and added the binding constraints below. Key verified fact: **exactly one pattern hit corpus-wide has a null-model score** (Jayapal `trade-vote-alignment`, observed 1, expected 0.647, p=0.647 — ordinary), and 31% of votes lack a `bill_id` link (22,258 of 71,639).

**Prototype verdict:** none of A/B/C promoted as-is. C's card bones inform the receipt layout; the braid survives only as a slim temporal spine; B's theme grouping becomes card metadata, not page structure. Prototype files are deleted when implementation starts.

## The moment of insight (the sentence the page is built to deliver)

> "For this member, here are trade–vote receipts on the same policy theme, in time order — with which pairings are closer together than their own trading and voting schedule would predict, and which are ordinary."

Neutral, falsifiable, auditable. The page never says or implies "corrupt"; it says *observed, expected, here are the documents*.

## Page hierarchy (top to bottom)

1. **Headline base-rate statement** — per-member, never a corpus leaderboard. Two forms:
   - Scored & elevated: "12 theme-matched trade–vote pairs; closer timing than ~N in 100 shuffled schedules."
   - Scored & ordinary (the expected common case): "61 theme-matched pairs; timing consistent with this member's trading and voting schedule."
   Always accompanied by a **coverage strip**: "computed on X% of votes with bill links · Y trades · theme map vZ · null model + seed." No headline renders without it.
2. **Temporal spine** — one slim horizontal time axis (trades + gap-tagged matched votes only; no money lane, no density strip). It carries the "before, not after" visual without asking the reader to decode a braid. Deterministic build-time SVG.
3. **Ranked receipts** — case-file cards (anatomy below), worst-first.
4. Existing sections (donors, outside spending, revolving door, co-sponsorship) unchanged, below the receipts.

## Card anatomy (three layers)

1. **Hero line (the receipt):** `purchase NVDA · $1M–$5M · 2 days later → CHIPS and Science Act · voted Yea · Tech & Semiconductors`. Gap tag keeps the existing `tag.before` yellow treatment.
2. **Rarity line (frequency language, never Greek):** "shorter than 94 of 100 shuffled calendars" / "typical gap for this member's matched pairs: ~38 days" / "would arise in about 65 of 100 random schedules" for ordinary pairs. p-values are never printed in this layer.
3. **Audit drawer (collapsed):** observed, expected, p-value, z-score, null model name, n_perm, seed, and primary-source links (PTR PDF, roll call, bill). Everything a reader needs to reproduce the number, per the rigor pillar's reader-verification rule.

## Ranking key (in order)

1. Rarity band (null-model p-value, banded — see colors).
2. Evidence weight: committee-jurisdiction votes and sponsored bills above generic floor votes.
3. Amount band lower bound.
4. Gap in days (closest first among equals — the last tiebreak, never a score).

Raw gap and raw pair-count are **never** the primary key: gap manufactures coincidence into narrative; volume makes prolific traders dominate regardless of signal.

## Color & affect rules

- Rarity bands only: **gray** = consistent with chance; **amber** = fewer than ~1-in-20 shuffles. **No red. No guilt colors.** Reuses the existing weight-only intensity tiers (visual-identity spec, 2026-05-10).
- "Consistent with chance" and "exceeds chance" remain the strongest verbs allowed (rigor pillar constraint).
- **Absent votes are shown, labeled neutrally** ("position: absent"), and not zero-weighted — absence on a theme-matched bill near a disclosed trade can itself be the fact. The card states the position; the reader judges.

## Negative results are a first-class outcome

A member whose timing is ordinary gets a page that *says so* — headline form 1b, gray cards, no amber. The UI must teach that null results are the norm in a high-activity legislature. Quiet members render quiet pages; this spec extends that rule to *exonerating* pages.

## Prerequisite work (blocking)

1. **Rigor pillar roster-wide:** run calendar + volume-shuffle null models for `trade-vote-alignment` across all members with trades (the 2026-05-27 spec's planned generalization). Today exactly one hit is scored; this page cannot rank on a column that is NULL everywhere else.
2. **Per-member matched-pair gap distribution** (for the "typical gap" rarity line) — derivable in the same permutation pass.
3. **Coverage stats query** (votes with `bill_id` %, trade count, theme-map version) surfaced to the renderer.

## Out of scope

- Braid as a default visualization (dead; spine only). Sector-Sankey and all-member "corpus wall" — future specs.
- Cross-member leaderboards of any kind.
- Donor-sector→vote alignment receipts (second "days later" story; same card machinery later, after this ships).
- Any client-side data fetching. Static, deterministic, byte-identical re-renders; `safeJson`/`safeUrl` helpers as in PR 1.

## Testing

- Unit: ranking comparator (rarity band → evidence weight → amount → gap), frequency-language formatter (p→"N in 100" phrasing), coverage-strip renderer.
- Golden: one elevated member, one ordinary member, one no-trades member — byte-identical re-render twice.
- Honesty check: a page with all-NULL rigor columns must refuse the headline (render coverage strip + unranked chronological receipts), never silently rank.
