# Statistical scoring of the live timing detectors — pre-registration spec

**Date:** 2026-07-20 · **Status:** SPEC — formal scoring run NOT green-lit.
This doc pre-registers the null models BEFORE any formal per-member results
are computed. Template: `docs/2026-07-17-recipient-trade-detector.md`.
**Machinery provenance:** rigor-pillar design
(`docs/superpowers/specs/2026-05-27-rigor-pillar-design.md`); policy anchor:
ADR-0002 §A (`docs/adr/0002-launch-scope-and-descriptive-detector-policy.md`).
**Detector IDs:** `trade-vote-alignment`, `spousal-trade-timing` (registry:
`docs/confirmatory-runs.md`). This spec's confirmatory run is one-shot and
final per ADR 0003; run `npm run guard:confirmatory -- trade-vote-alignment
spousal-trade-timing` before any scoring computation.

## Scope — what this registers (and what it does not)

This spec registers the **statistical scoring layer** for the two LIVE
descriptive detectors:

- `trade-vote-alignment` (`pipeline/patterns/trade-vote-alignment.ts`)
- `spousal-trade-timing` (`pipeline/patterns/spousal-trade-timing.ts`)

It does **not** register new detectors, and it does not change the
descriptive counting, the flag findings, or the DB `intensity` values
(ADR-0002 §A: scoring must populate the existing nullable
`pattern_hits.null_model/observed/expected/p_value/z_score/n_perm` columns
and nothing else in the row).

Both detectors currently render with the honest caveat *"Based on N cited
records; not statistically scored against a null model"* and fire at
intensity 1.0 for basket traders mechanically (a 1,923-trade member
saturates any 14-day window by volume alone — ADR-0002 §A). The rejected
district-contracts detectors were held to a pre-registered permutation gate;
the shipped detectors were not. This spec closes that gap.

## Gate semantics (maintainer decisions, 2026-07-19)

1. **Language-only gate.** A flag scoring p ≥ 0.05 keeps rendering; the
   existing scored branch of `confidencePhrase()` (`render/build.ts`)
   carries the honesty ("About what this member's own trading would produce
   by chance…" + full stats line). No flag suppression, no detector
   deregistration, regardless of outcome.
2. **Intensity cap.** A scored flag with p ≥ 0.05 renders at the lowest
   visual-weight tier (`intensity-low`); p < 0.05 keeps substrate-driven
   weight. Unscored flags (NULL stats) are untouched. Render-time only; the
   DB `intensity` column is not modified.
3. The only **hard gate** in this spec is machinery validity: the negative
   control (below) must pass before the formal run's results may be
   published. Control FAIL → no publication, investigate, dated amendment.

## Prior-exploration disclosure (mandatory honesty)

The trade-vote scoring machinery already ran **exploratorily** during the
rigor pillar (2026-05-27): pramila-jayapal observed=1, expected≈0.65,
**p=0.647**; marjorie-taylor-greene's volume confound collapsed under the
volume-shuffle null (**z≈0**). These two members' approximate outcomes are
known priors. Mitigations, pre-committed:

- All design constants carry forward from the rigor-pillar doc **unchanged**
  and were fixed before any roster-wide results existed:
  `WINDOW_DAYS=14`, `N_PERM=10,000`, `BASKET_TRADE_THRESHOLD=50`,
  calendar-vs-volume-shuffle dispatch. No constant may be adjusted in
  response to the exploratory numbers or to the formal results.
- The formal run uses **fresh seed strings** (below), so no formal number is
  a replay of an exploratory one.
- The spousal detector has never been scored in any form; it has no priors.

## Substrate and spine reconciliation (pre-registered design changes)

Substrate per member = the trades and votes co-appearing in
`v_suspicious_trades` (discretionary asset types only, free-text ETF/index
rows dropped, before-vote pairs within the view's ±180-day join bound).
This truncation — only trades with ≥1 before-vote pairing inside 180 days
enter the shuffleable population — is shared identically by the observed
statistic and every null draw, and is carried forward from the rigor pillar
unchanged.

Two reconciliations are adopted here, **outcome-blind, before any formal
run**, so the null substrate is exactly the population the detector counts
("one spine, no drift" — the baseline-template rule):

1. **ETF exclusion moves to SQL.** The exploratory scorer's substrate query
   did not exclude `BROAD_MARKET_ETFS` tickers; they were skipped inside
   `countNexus` but still inflated `trades.length` (the basket-dispatch
   input) and contributed their dates to the volume-shuffle multiset. The
   formal substrate excludes them at SQL level, matching the detectors.
   Declared consequence: some members may cross the 50-trade dispatch
   boundary relative to the exploratory runs.
2. **Instrument case normalization.** Trade identity is
   `filing_id|tx_date|tx_type|UPPER(COALESCE(ticker, asset))` everywhere —
   scorer AND detectors — so dedupe keys cannot diverge on ticker-less
   assets.

## Statistics (per detector, per member)

- **trade-vote-alignment — S:** count of distinct discretionary non-ETF
  trades with a nexus vote in `[tx_date, tx_date + 14d]`, where nexus =
  member sat on the bill's committee OR the bill text names the traded
  ticker (common-word-guarded). Exactly `countNexus()`
  (`pipeline/patterns/_nexus.ts`) — one rule shared by observation, tests,
  and every permutation draw.
- **spousal-trade-timing — S:** count of distinct spouse/joint-held
  discretionary non-ETF trades with a **committee-handled** vote in
  `[tx_date, tx_date + 14d]`. Committee is the only nexus (no ticker-text
  path). Implemented as `countNexus()` over votes carrying only committee
  flags (`namedTickers: []`); substrate trade-side filter
  `LOWER(holder) IN ('spouse','joint')`.

## Null models

Per member, dispatched on substrate size (same rule both detectors):

- **≥ 50 substrate trades → volume-preserving date shuffle**
  (`volumeShuffleDraw`, `_permutation.ts`): each draw permutes the multiset
  of the member's actual trade dates across their trades (tickers fixed),
  then recounts S. Preserves trade count, cadence, and basket structure.
- **< 50 substrate trades → calendar randomization** (`calendarDraw`): each
  draw reassigns every trade to a uniform random market-open weekday in the
  member's own trade+vote span, tickers fixed, then recounts S.

For spousal, the shuffled population is the member's **household
(spouse/joint) trade subset only** — self-held trades never enter.

**10,000 permutations**, one-sided upper tail
(`p = #{draws ≥ observed} / 10,000`), z from the empirical null SD
(`permutationTest`, `_permutation.ts`).

**Exchangeability.** Under H0 — "this member's (household's) trade *timing*
carries no information about upcoming nexus votes" — the member's trade
dates are exchangeable against their own vote calendar: the volume shuffle
conditions on the member's full trading cadence and portfolio (only the
date↔trade pairing moves); the calendar null conditions on trading at all
within the span. Tickers stay fixed, so the ticker-named path is
conditioned on portfolio composition, and vote dates/attributes are never
moved. The 50-trade threshold is the rigor-pillar constant, reused without
tuning: below it a member's own date multiset is too small to shuffle
informatively, so dates are drawn from the calendar instead.

**Stated limitation:** neither null models earnings-calendar or
market-event clustering of trade dates (a member who trades on earnings
days is compared against uniform/own-cadence dates, not an event-aware
null). This is a known, accepted approximation, disclosed in methodology
copy.

## Seed strings (verbatim, via `seedFrom()` / `mulberry32` in `_rng.ts`)

- Formal run: `trade-vote-alignment-preregistered-v1|<member>` and
  `spousal-trade-timing-preregistered-v1|<member>`
- Negative control, replicate i ∈ 0..19, per member:
  - vote-attribute scramble: `<pattern>-nc-scramble-v1-<i>|<member>`
  - replicate null shuffle: `<pattern>-nc-null-v1-<i>|<member>`

## Negative control (pre-registered; runs BEFORE the formal run)

**Design — vote-attribute scramble:** for each replicate, permute the
`(committee, namedTickers)` attribute tuples across the member's vote set
(for spousal: the committee flags). Vote dates and count are preserved; the
number of committee votes and named-ticker votes is preserved; every trade
is untouched. Then run the FULL procedure on the scrambled data — fresh
observed S + fresh 10,000-permutation null — with the replicate-indexed
seeds above. Rationale: the scramble destroys the real pairing between
trade timing and *which* votes carry a nexus while preserving every
marginal the null conditions on (trade dates/cadence, vote density,
nexus-vote count). A machinery that flags scrambled data is reading
marginals, not timing.

**Extent:** 20 replicates per (detector, member with non-empty substrate).

**Pass criterion (pre-registered):** pooled false-positive rate across all
(member, replicate) pairs ≤ 10% (expected ≈5% at α=0.05), AND no single
member exceeds 4/20 significant replicates. Exceeding either → machinery
gate **FAIL**: formal results are not published, investigation + dated
outcome-blind amendment required before any rerun.

**Ordering (Step-0 rule):** the control runs and is evaluated before the
formal scoring run; no hand-tracing of any member's formal result happens
before both transcripts exist.

## Re-run semantics

One-shot binds the **design** — statistic, null, constants, dispatch, seed
strings, control criterion — not the computation. Scores are a
deterministic function of (data, seed); recomputation after a data refresh
(new PFD filings, new votes) is expected and produces the then-current
honest numbers. Any design change is a NEW dated amendment to this spec,
adopted outcome-blind, or a new spec.

## Members out of scope

- A member with **zero pattern hits** has no `pattern_hits` row (run-patterns
  writes none) and nothing renders — there is nothing to score; the scorer
  skips with a log line and never invents rows.
- A member with a hit row but an **empty substrate** cannot occur (a hit
  implies substrate rows); if observed by the scorer it is a fail-loud
  error, not a skip.
- Zero-trade members: excluded by construction (affects power, not
  validity — same note as the recipient spec).

## Ordered gates (stop on failure)

1. This spec committed after maintainer sign-off — **hard user gate**.
2. Code + tests land green (`npm test`); development uses fixtures only —
   no formal roster scoring output is produced or inspected before gate 3.
3. Negative control run, transcript captured to
   `docs/timing-detectors-scoring-<run-date>/negative-control-run-<date>.txt`;
   verdict reviewed — **user gate**. FAIL → record + stop.
4. Formal one-shot scoring run (`run-patterns --all`, which now scores
   inline), transcript captured alongside; post-run `pattern_hits` dump
   saved to the audit dir for provenance (the DB is not in git).
5. Results appended to this spec verbatim (per-member
   observed/expected/p/z/null_model tables + control summary), dated.
   No tuning, no re-runs; anomalies become dated amendments.
6. Render/methodology updates ship; publication of any page is a separate
   gate (ADR-0002 §C, `civiclens-publish-gate`).

Required product language stays verbatim (ADR-0002 §A): *"The detector
identifies reproducible patterns in available data. It does not establish
causation or statistical significance."* — and the unscored caveat string
in `confidencePhrase()` is load-bearing and must not be removed or softened.
