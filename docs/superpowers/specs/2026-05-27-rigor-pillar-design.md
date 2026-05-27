# CivicLens — Rigor Pillar (Anomaly Scoring)

**Date:** 2026-05-27
**Status:** Design (pre-implementation)
**Owner:** duckjustice
**Scope:** Add a statistical-rigor layer on top of the existing pattern detectors: a permutation/Monte-Carlo null model that turns a raw nexus *count* into an *observed-vs-expected* finding with a p-value and z-score. Vertical slice on one contrast pair (`trade-vote-alignment` for Jayapal and MTG) before any roster-wide rollout. Writes findings back into the Obsidian vault as linked notes.

---

## Why

Pattern Discovery v2 (2026-05-09) shipped detectors that emit a raw count and an `intensity` score. `intensity` answers *"how loud is this trade?"* but not *"is this louder than chance?"* A prolific basket trader like MTG (388 trades, 84 tickers) will mechanically rack up trade-vote coincidences that mean nothing — proximity alone is coincidence, and `intensity` can't tell a confound from a signal. The rigor pillar adds the missing question: **given how this member actually trades, how surprising is the observed nexus?**

This is the first of three planned pillars — **rigor / timing / synthesis** — kept as three distinct objects, not fused. Rigor is built first because timing and synthesis both consume its expected-vs-observed output.

## The contrast pair (why these two members)

Roster-wide, only **Jayapal** produced a `trade-vote-alignment` hit (n=1 trade, committee-linked). The positive-case pool is genuinely thin. So the slice is built around a deliberate contrast that exercises both outcomes:

- **Jayapal** — 1 trade, committee-linked, the only positive hit. Null = **calendar randomization**. Expected outcome: **signal survives** (low p). Demonstrates the engine doesn't destroy a legitimately-timed single trade.
- **MTG** — 388 trades, 84 tickers, basket trader. Null = **volume-preserving date shuffle**. Expected outcome: **confound dies** (p≈high, z≈0). Demonstrates the engine kills a coincidence that `intensity`-alone would have surfaced.

If both outcomes land as predicted, the pillar is validated and we generalize.

## Editorial constraints (non-negotiable)

Inherited from civiclens-core; this spec defers to them.

- **Neutral framing.** A finding states observed, expected, and p-value. No moralizing. "Consistent with chance" and "exceeds chance" are the strongest verbs allowed.
- **Reader verification.** The null model, N, and seed are disclosed on every scored finding so a reader can reproduce it.
- **Primary sources only.** No stub data. Null distributions are built from the member's real trade and vote rows. A member with no qualifying trades gets no scored finding.
- **No red.** Significance surfaces through ranking and weight, never through color affect.

## Architecture

Three new/changed units, each independently testable.

### 1. `countNexus()` — pure function (extracted)

The nexus rule currently lives inside the `WHERE` clause of `pipeline/patterns/trade-vote-alignment.ts`: a trade counts when it falls within `WINDOW_DAYS` (14) **before** a vote **AND** (`member_on_bill_committee` **OR** `bill_mentions_ticker`, with ETFs and common-word tickers filtered).

Extract this into a pure, side-effect-free function:

```
countNexus(trades: Trade[], votes: NexusVote[], windowDays: number): number
```

- `trades` — `{ txDate, ticker, ... }` for one member.
- `votes` — `{ voteDate, ticker?, hasCommitteeNexus }` precomputed eligible votes for that member (the committee/ticker join resolved once, up front).
- Returns the count of distinct trades that land in a nexus window.

It is reused verbatim by (a) the live detector and (b) every permutation draw. This guarantees the null is measured with the *exact same rule* as the observation — no drift between "what we counted" and "what we shuffled." The detector keeps its existing SQL to fetch rows, then calls `countNexus()` instead of inlining the logic.

### 2. `pipeline/patterns/_permutation.ts` — the null engine

```
permutationTest({
  observed: number,
  draw: () => number,    // one resampled nexus count under the null
  nPerm: number,
  seed: number,
}): { observed, expected, pValue, zScore, nPerm }
```

- Runs `draw()` `nPerm` times, collects the null distribution.
- `expected` = mean of null draws; `zScore` = (observed − expected) / sd; `pValue` = fraction of draws ≥ observed (one-sided, upper tail).
- RNG is a tiny inline **mulberry32** seeded deterministically — no new dependency, stable across machines.

The two null models are just two `draw()` closures handed to the same engine:

- **Calendar randomization (Jayapal).** Pool = the member's **full active-session calendar, masked to market-open days**. Each draw reassigns every trade to a random eligible date (keeping ticker fixed), then `countNexus()`. Chosen because the resulting p-value reduces to *"what fraction of the trading calendar falls inside a 14-day pre-vote window for a vote this member had a real nexus to?"* — which **self-corrects for vote density** without hand-tuning. Rejected alternatives: full-calendar-without-market-mask (draws impossible weekend trades); legislative-density-conditioned pool (defines the date pool using the very thing under test — circular, manufactures non-significance).
- **Volume-preserving date shuffle (MTG).** Each draw permutes the trade dates *among the dates she actually traded* (shuffle the date column, keep the multiset of dates and tickers intact), then `countNexus()`. This preserves her trading cadence and basket size, so it asks the honest question: *given that she trades this much, this often, is the real alignment more than her own churn would produce?* For a basket trader the answer is no.

For Jayapal's n=1, the calendar null is effectively analytic (p ≈ hot-days / eligible-days); the engine still runs `nPerm` draws for uniformity and converges instantly.

### 3. `pipeline/score-anomaly.ts` — orchestrator

A pipeline step that, per (member, detector): fetches the detector's rows, computes `observed` via `countNexus()`, selects the null model for that detector, runs `permutationTest`, and writes the scored result back to `pattern_hits`. Idempotent (DELETE-then-insert, matching the existing `run-patterns` convention).

### 4. `pattern_hits` schema — additive nullable columns

Add to `db/schema.sql` (and a migration in `db/migrate-pattern-hits.ts`):

```
null_model   TEXT     -- 'calendar' | 'volume-shuffle' | NULL (unscored)
observed     INTEGER
expected     DOUBLE
p_value      DOUBLE
z_score      DOUBLE
n_perm       INTEGER
```

All nullable. Unscored detectors (everything except the slice, for now) leave them NULL and render exactly as today. `intensity` is **left untouched** — rigor is additive, not a replacement.

## Parameters (locked)

| Param | Value | Rationale |
|---|---|---|
| `windowDays` | 14 | Inherited from the detector; the tight advance-knowledge window. |
| `nPerm` | 10,000 | Resolves p to ~1e-4 (finer than we'd report); sub-second for 388 trades. 1k is noisy, 100k is wasted. |
| `seed` | `hash(pattern + member)` | Idempotency: same DB state → identical p-values, so re-runs don't churn `pattern_hits` or vault notes with random jitter. Per-member seed keeps members reproducible but independent. |
| RNG | inline mulberry32 | No dependency; algorithm under our control → stable across machines. |
| Calendar pool | full session, market-open masked | Self-corrects for vote density; never draws an impossible trade date. |

**Known tradeoff:** a fixed seed means each p-value is one draw from the sampling distribution, not re-randomized per run. Accepted — reproducibility beats re-sampling, and 10k draws already makes the estimate tight.

## Rendering — the ranked conflict feed

The surface is a ranked feed showing **expected vs observed**. Ranking is by **signed z-score (p-value tiebreak)** — *not* raw count and *not* `intensity`. Each card shows:

- observed nexus count vs expected (± sd),
- the null model used, N, and seed (reader verification),
- a one-line plain-English verdict.

Outcome for the slice:
- **Jayapal** → observed=1 in a thin hot-zone, low p → verdict *"timing signal survives"* → rises to the top.
- **MTG** → observed ≈ expected, z≈0 → verdict *"consistent with chance for a 388-trade basket — no timing signal"* → sinks to the bottom.

That ranking inversion (MTG would top a count- or intensity-ranked feed, but bottoms a rigor-ranked one) is the visible payoff of the pillar.

## Vault write-back

Per the active-retrieval vault convention, the scorer writes each scored finding back into the Obsidian vault (`~/NoService/`) as a linked note under the member's existing Connections/Members structure — `[[wikilink]]`'d to the member and the cited trade/vote so the vault's connection graph gains the expected-vs-observed result, not just the raw nexus. Idempotent overwrite keyed on (member, pattern).

## Testing

- **`countNexus()`** — unit tests with hand-built trade/vote fixtures: a trade exactly on the window edge (day 14 in, day 15 out), a same-day trade, an ETF that must be excluded, a common-word ticker on the bill-text path, the trade×vote-explosion case (one trade must count once, not per matching vote).
- **`_permutation.ts`** — seeded determinism (same seed → identical output), a degenerate n=1 case, and a synthetic input where observed sits at a known quantile so expected/p/z are checkable against hand math.
- **Slice acceptance** — run `score-anomaly` for Jayapal and MTG against the live DB and assert the two predicted outcomes (Jayapal low p / survives; MTG high p / collapses). This is the validation gate for generalizing.

## Non-goals

- No roster-wide scoring until the contrast pair validates.
- No new detectors. Rigor wraps the existing `trade-vote-alignment` only, for now.
- Timing and synthesis pillars are out of scope (separate specs).
- `intensity` is not changed, deprecated, or re-derived.

## Outcome (2026-05-27, post-implementation)

The slice shipped, but the data refuted the predicted contrast — recorded here because the result is the point, not the prediction.

- **Jayapal:** observed=1, expected=0.65, **p=0.647** → *consistent with chance*, NOT "signal survives." Her lone trade has 1,182 eligible votes over ~2.5 years, of which 162 are committee votes and **0 are ticker-named**. With a committee vote every ~5–6 days, ~65% of the trading calendar is a nexus "hot zone," so a single trade landing there is unremarkable. The calendar window is correct (verified ~2.5yr span); the signal is genuinely weak.
- **MTG:** **0 detector hits** → the confound never manifested in this detector (the nexus requirement already excludes her); observed=0, p=1.0. Nothing to collapse.

**What this validates:** the rigor pillar works on its first run, and its first finding is that CivicLens's only roster-wide `trade-vote-alignment` hit (which `intensity` rated 0.85) is statistical noise. That is the pillar earning its keep — deflating a hit visual weight overstated. **Implication:** committee-jurisdiction nexus is a weak signal for active committee members; the ticker-named path is the real signal, and no one in the contrast pair has one. Under rigor, the roster currently shows *no* significant trade-vote alignment. User accepted shipping this honestly rather than tuning.

**Performance caveat:** the volume-shuffle null is O(trades × votes × nPerm); MTG (388 × 1,182 × 10k) took minutes. Before any roster-wide scoring run, `countNexus` needs a per-ticker sorted-vote-date + binary-search optimization.

## Open questions

- Whether to backfill the other shipped detectors (`donor-sector-vote-alignment`, `spousal-trade-timing`) with rigor scores after the slice validates — deferred to a follow-up.
- Roster choice for the first roster-wide pass (House-focused per house-focus rule) — deferred.
