# District-contracts detector — design

**Date:** 2026-07-15 · **Status:** BUILT, then **GATED at the permutation baseline (2026-07-16)** — substrate + loader + crosswalk shipped; the theme-level detector does not discriminate above chance and is NOT registered. See "Permutation baseline — verdict" below.
**Substrate probe:** SOURCES.md "USAspending API" (frozen 2026-07-15, NJ-05/Gottheimer/CY2023).

## Pattern statement

> Federal contract dollars flowing into a member's district are concentrated in an
> economic-sector theme, and the member personally trades in that same theme.

The trade↔bill nexus extended to federal money: the member has personal financial
exposure to an industry that is simultaneously a dominant recipient of federal
contracts performed in their district. Neutral framing as always — the finding
states dollars, shares, and counts; the reader judges.

## Design call 1 — district field: `district_original`

Use `district_original` (the district map at award time), not `district_current`
(today's map). The claim is "money into the district *while the member held the
seat*"; redistricting makes `district_current` retroactively relabel old awards
into boundaries the member never represented. This matches the SOURCES.md caveat
verbatim.

Consequences:
- The frozen probe used `district_current`, so **re-freeze one sample with
  `district_original` before writing the loader** (source-first rule). Expect
  small dollar shifts on redistricted states; NJ-05 2023 should be near-identical.
- Stated in the render section's methodology line: "awards by place of
  performance, district boundaries as of award date."

## Design call 2 — NAICS→theme crosswalk shape

New hand-curated table, seeded in `db/load-sector-crosswalk.ts` next to its
siblings, same 12 themes, no new themes:

```sql
CREATE TABLE IF NOT EXISTS naics_theme (
  naics_prefix TEXT PRIMARY KEY,  -- 2–6 digit prefix
  theme        TEXT NOT NULL,     -- one of the existing theme_bill_match themes
  note         TEXT               -- why, when the mapping isn't obvious
);
```

- **Prefix-based, longest-prefix-wins.** NAICS is hierarchical, unlike the flat
  OpenSecrets strings, so exact-code seeding would churn on every new district.
  A code matches the longest seeded prefix (e.g. `3364xx` Aerospace → Defense &
  Aerospace even if `33` Manufacturing → Industrials is also seeded). Longest-
  prefix-wins makes multi-match impossible by construction — the collision-
  exclusivity rule from `donor_industry_theme` holds deterministically.
- Matcher `matchNaicsTheme(code)` exported from the loader; test file
  `lib/naics-crosswalk.test.ts` mirrors `donor-crosswalk.test.ts`: every NAICS
  observed in harvested rollups resolves to exactly the intended theme (frozen
  NJ-05 codes are the first tripwires: 423450 → Pharma & Health, 336413 →
  Defense & Aerospace, 541715 → *unmapped*, see next point).
- **Unmapped-by-construction is load-bearing.** Big federal NAICS families with
  no tradable-theme meaning (construction 23, professional/R&D services 5417
  unless theme-specific, government support services, remediation 562910) stay
  unmapped, exactly like Labor/Ideology/Lawyers on the donor side. Findings say
  "of mapped district contract dollars" and the render section shows the mapped
  share so the exclusion is visible, not silent.
- Seed coverage: exactly the codes observed in harvested rollups (the sic_theme
  philosophy), generalized to a prefix only when the whole subsector is
  unambiguous.

## Design call 3 — detector spine and thresholds

**Trade-side spine, two-sided concentration.** A hit requires ALL of:

1. **Theme is a top district-contract theme:** top-3 by mapped transaction
   dollars AND ≥20% of the member's mapped district contract dollars in the
   window (mirrors the donor detector's `TOP_N=3` / `MIN_SHARE=0.20` shape).
2. **Member traded ≥3 transactions in that theme** (ticker → `sic_theme` +
   `ticker_theme_override`, the existing trade-side mapping) inside the window.
3. **Theme is also a top-3 traded theme for the member** by transaction count.
   This is the MTG basket-trader lesson applied at design time: for a member
   trading 57 tickers a day, *some* trades land in every theme — presence is
   noise. Requiring concentration on both sides is what makes the overlap a
   pattern rather than an intersection of two long lists.

Why trades and not sponsorship: contracts × sponsored-bills is constituency
service — nearly every member authors bills in their district's dominant
industry, so it cannot discriminate (the 35/37-members failure mode the donor
detector already hit once). Contracts × donors at OpenSecrets industry
granularity can't tie actual contractors to actual donations, so the honest
version isn't buildable from current substrate. Personal trades are the one
deliberate, personal-stake act in the theme space.

**Thresholds are provisional until the permutation baseline runs** (Step-0
rule: null baseline BEFORE hand-tracing). Existing `_permutation.ts` infra:
shuffle member↔district assignments across the roster; the detector must fire
on shuffled pairs at a clearly lower rate than on real ones. If it fires on
more than ~⅓ of the real roster, it isn't discriminating — tighten before
shipping, don't narrate around it.

**Scope: House-only v1.** Senators have no district; a state-level filter is a
different, weaker claim and is out of scope. (Consistent with House-focus
roster policy.)

**Window:** fixed CY2023–CY2025 (the 118th–119th data era matching loaded
trades/donors), one API call per district×CY. Tenure-derived windows are a
follow-up once terms data exists; v1 states the window in the finding.

## Data plan

- **Loader** `db/load-district-contracts.ts`, wired as
  `agents/pipeline.ts --load-district-contracts [slug]`. Endpoint 2
  (`spending_by_category/naics`) per district×CY, `district_original` filter,
  cache to `data/caches/usaspending-cache/<state>-<dist>-<cy>.json`. No API key.
- **Table** `district_contract_naics(member_id, cy, naics, naics_desc, amount,
  spending_level)`, PK `(member_id, cy, naics)`. `spending_level` recorded and
  asserted `= 'transactions'` — never mix transaction dollars with award
  ceilings (probe trap). Endpoint 1 itemized awards are **v1.1** (drill-down
  citations); v1 hits cite the rollup rows themselves (`kind: 'contract'`,
  `id: member|cy|naics`) — real, clickable DB rows per the detector contract.
- **District normalization:** `members.district` is bare digits (`"5"`); API
  wants zero-padded (`"05"`). Pad in the loader. One House member currently has
  `district IS NULL` — the loader fails loudly on it (no-stub rule); fix the
  roster row first.
- **Detector** `pipeline/patterns/district-contract-trade-alignment.ts`,
  registered in `registry.ts`. Detectors are pattern-pass modules, not pipeline
  agents — no `pipeline.ts` stage, no `lib/types.ts` AgentName change.
- **Render:** member-page "District contracts" section reads the same exported
  `CONTRACT_SQL` the detector uses (the `DONOR_SQL` one-source-of-truth
  pattern). Total-order `ORDER BY amount DESC, naics ASC` — every new
  render-path query needs a deterministic total order or reproducibility
  re-breaks.

## Verification gates (in order, stop on failure)

1. Re-freeze probe sample with `district_original` → append to SOURCES.md.
2. Crosswalk collision tests green (`lib/naics-crosswalk.test.ts`).
3. Loader smoke on Gottheimer (NJ-05 — the frozen probe target); diagnose
   before re-loading on any mismatch.
4. Permutation null baseline; record the null hit-rate in this doc.
5. Detector on full House roster — a null result on a member is a success.
6. Render regression: rebuild one untouched member, byte-diff clean.
7. Full test suite + double-build byte-identity.

## Permutation baseline — verdict (2026-07-16): FAILED, detector gated

Null model: member↔district assignment shuffled across the 33-member House
roster (2,000 permutations, seed `district-contract-baseline-v1`, mulberry32),
scoring shuffled pairs with the exact shipped decision procedure
(`qualifyingThemes`, shared import — no drift).

**Run 1** (spine as designed): observed 3/33 members with a hit; null expected
2.46, z=0.49, **p=0.483**. A member's trades align with a random *other*
district's contract mix as often as with their own.

**Run 2** (added district-distinctiveness condition, share ≥1.5× roster-median
share for the theme): identical — observed 3, expected 2.46, p=0.483. The
condition never binds: roster medians (Defense 48.7%, Pharma 13.5%, Tech 7.7%)
sit low enough that any theme clearing top-3 + ≥20% clears 1.5× median too.

**Why it can't work at theme level:** (1) Defense & Aerospace is ~49% of every
district's mapped contract dollars — the federal government buys the same
things everywhere, so "top contract theme" carries almost no district
information. (2) The trade side has no district information either —
congressional portfolios are mega-cap-alike (everyone holds AAPL/JNJ/ABBV), so
the Pharma/Tech overlaps that fire are portfolio base rates. The two sides are
exchangeable; no threshold extracts a signal that isn't there. (Same lesson as
the committee-jurisdiction nexus: an everywhere-hot edge is not a nexus.)

**Disposition:** loader, `district_contract_naics` substrate, `naics_theme`
crosswalk, and baseline harness are shipped and stay (real substrate, reusable
edge). The detector file stays for its SQL + spine but is NOT in
`registry.ts` `DETECTORS` and gets no render section. One tightening iteration
was allowed by design; further threshold-tuning against the null would be
p-hacking.

**The discriminating edge (v2 candidate):** recipient-level, not theme-level —
Endpoint 1 itemized awards give `Recipient Name` per district; a member trading
stock of the *specific company* receiving federal contracts performed in their
district is district-specific by construction. Needs recipient-name → ticker
resolution (subsidiary names are the hard part). Not green-lit; propose
separately.

## Open questions — resolved at build (2026-07-16)

- Spine: trades (as recommended) — built, then gated by the baseline above.
- Window: fixed CY2023–2025 — used.
- Endpoint 1 itemized-award citations: deferred; now the core of the v2
  recipient-level candidate rather than a citation nicety.
