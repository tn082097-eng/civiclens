# Theme-Gated Trade→Vote Receipts (Lane 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship ranked, theme-gated trade→vote *receipt* rows on member pages — each a dated, row-cited juxtaposition scored against the member's own shuffled-date null — with a coverage strip and statistical-honesty power bands.

**Architecture:** A new pure gap helper (`_gap.ts`) computes, per trade, the minimum days-gap to a *same-theme* vote within a window — mirroring the existing `_nexus.ts` index/binary-search pattern but returning gaps instead of a count. A new orchestrator (`score-theme-gaps.ts`) reads `v_trade_bill_nexus`, computes observed per-pair gaps, runs a per-pair lower-tail permutation null reusing the existing `_permutation` date-shuffle draws, assigns 3 power bands by the member's disclosed-trade count, and emits a typed artifact. The render reads the artifact deterministically (no LLM, per ADR 0001) into ranked receipt cards plus a coverage strip.

**Tech Stack:** TypeScript, `tsx --test` (node:test), DuckDB (`@duckdb/node-api`), Zod (`lib/schemas.ts`).

**Scope note:** This is Lane 1 only. Per-theme Coherence cards, the money→vote detector (#6), and the uniform skeleton (#7) are separate plans that build on this. This plan produces working, testable software on its own.

---

## Design decisions (locked with Grok, 2026-06-15)

- **Per-pair, not member-level.** Existing `countNexus`/`permutationTest` score a member-level *count* (upper tail). Receipts need a per-trade *gap* (lower tail = "closer than chance"). New code, but it reuses the date-shuffle draws and the sorted-index trick.
- **Null = the member's own dates.** Shuffle ALL the member's trade dates (calendar-randomization < 50 trades, volume-shuffle ≥ 50 — same `BASKET_TRADE_THRESHOLD` as `score-anomaly.ts`), re-apply theme matching each draw. Never within-theme pools (circular).
- **Theme is date-invariant.** A trade's theme (ticker→sector→theme) and a vote's theme (bill→subject→theme) do not move when dates shuffle. So the null re-computes only *which same-theme vote is nearest in time*.
- **Vote population is trade-independent (fix from review).** The null must draw against *every* theme-eligible vote in the window, not only votes that historically matched a trade. Conditioning on `v_trade_bill_nexus` votes understates match opportunities and biases `p` low (toward false significance). A dedicated `v_theme_eligible_votes` view (all bill-linked votes × `theme_bill_match`, same focused-bill/title guards, computed independently of trades) is the shared predicate for observation, the null, and the future money→vote detector (#6).
- **Observed gap comes from the guarded pair (fix from review).** The value `p_pair` tests is the nexus row's `days_before_vote` (the specific guarded juxtaposition), keyed by `tradeFilingId` (closest vote per trade). The null reshuffles the full theme-joinable trade set and recomputes each trade's min gap against the eligible-vote population — but the observed it's compared to is the guarded gap, not a loose recompute.
- **One-sided lower tail.** `p_pair = (1 + #{draws: gap' ≤ observed}) / (K + 1)`. Never two-sided, never a "corruption probability."
- **Three power bands** by the member's disclosed-trade count `n`:
  - `n < 5` → **insufficient-data**: receipts shown chronologically, unranked, **no p-values**.
  - `5 ≤ n ≤ 9` → **low-power**: compute `p_pair`, tag "low power (n trades)", **do not rank against the ≥10 cohort**.
  - `n ≥ 10` → **ranked**: full ranked receipts by `p_pair` ascending.
- **Coverage strip** is mandatory honest context: 78.7% of votes carry no bill at all. Render the linked/unlinked split.
- **Deterministic render.** No LLM prose (ADR 0001). Empty/insufficient/zero-pairs are first-class rendered states, never omissions.

---

## File Structure

- **Modify** `db/schema.sql` — add `v_theme_eligible_votes` (all bill-linked votes × `theme_bill_match`, same guards as `v_trade_bill_nexus`, trade-independent). The null's vote population.
- **Create** `pipeline/patterns/_gap.ts` — pure per-trade min-gap-to-same-theme-vote helper (sorted index, binary search). One responsibility: the gap rule, shared by observation, tests, and every null draw.
- **Create** `pipeline/patterns/_gap.test.ts` — unit tests for the gap rule.
- **Create** `pipeline/score-theme-gaps.ts` — orchestrator: read view → observed gaps → per-pair null → power bands → emit artifact. Mirrors `score-anomaly.ts` structure.
- **Create** `pipeline/score-theme-gaps.test.ts` — orchestrator-level tests on a fixture member.
- **Modify** `lib/schemas.ts` — add `ThemeGapReceiptsSchema` (the typed artifact).
- **Modify** `render/build.ts` — render the receipts section + coverage strip from the artifact.
- **Create** `render/receipts.test.ts` — render assertions (ranked vs low-power vs insufficient vs zero-pairs).

---

## Task 1: Pure gap helper (`_gap.ts`)

**Files:**
- Create: `pipeline/patterns/_gap.ts`
- Test: `pipeline/patterns/_gap.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// pipeline/patterns/_gap.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minGapsByTrade, type ThemeTrade, type ThemeVote } from './_gap.js';

const T = (id: string, txDate: string, theme: string): ThemeTrade => ({ id, txDate, theme });
const V = (id: string, voteDate: string, theme: string): ThemeVote => ({ id, voteDate, theme });

test('same-theme vote inside the window yields the day gap', () => {
  const g = minGapsByTrade([T('t1', '2024-01-01', 'tech')], [V('v1', '2024-01-10', 'tech')], 90);
  assert.equal(g.get('t1'), 9);
});

test('vote BEFORE the trade does not count (one-directional)', () => {
  const g = minGapsByTrade([T('t1', '2024-01-10', 'tech')], [V('v1', '2024-01-01', 'tech')], 90);
  assert.equal(g.get('t1'), undefined);
});

test('vote outside the window does not count', () => {
  const g = minGapsByTrade([T('t1', '2024-01-01', 'tech')], [V('v1', '2024-05-01', 'tech')], 90);
  assert.equal(g.get('t1'), undefined);
});

test('different theme does not count', () => {
  const g = minGapsByTrade([T('t1', '2024-01-01', 'tech')], [V('v1', '2024-01-05', 'energy')], 90);
  assert.equal(g.get('t1'), undefined);
});

test('nearest same-theme vote wins when several are in range', () => {
  const g = minGapsByTrade(
    [T('t1', '2024-01-01', 'tech')],
    [V('v1', '2024-01-20', 'tech'), V('v2', '2024-01-05', 'tech')],
    90,
  );
  assert.equal(g.get('t1'), 4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test pipeline/patterns/_gap.test.ts`
Expected: FAIL — `Cannot find module './_gap.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// pipeline/patterns/_gap.ts
/**
 * Pure gap rule: for each trade, the minimum day-gap to a SAME-THEME vote that
 * falls 0..windowDays AFTER it (trade before vote). Mirrors _nexus.ts: votes are
 * folded ONCE into a per-theme sorted date index so each trade is an O(log V)
 * lookup — a per-pair permutation re-runs this thousands of times cheaply.
 */
export interface ThemeTrade {
  id: string;
  txDate: string; // ISO yyyy-mm-dd
  theme: string;
}
export interface ThemeVote {
  id: string;
  voteDate: string; // ISO yyyy-mm-dd
  theme: string;
}
export interface IndexedTrade {
  id: string;
  theme: string;
  txMs: number;
}
/** theme -> ascending epoch-ms of that theme's vote dates. */
export type ThemeVoteIndex = Map<string, number[]>;

const MS_PER_DAY = 86_400_000;

export function buildThemeVoteIndex(votes: ThemeVote[]): ThemeVoteIndex {
  const byTheme: ThemeVoteIndex = new Map();
  for (const v of votes) {
    let arr = byTheme.get(v.theme);
    if (!arr) {
      arr = [];
      byTheme.set(v.theme, arr);
    }
    arr.push(Date.parse(v.voteDate));
  }
  for (const arr of byTheme.values()) arr.sort((a, b) => a - b);
  return byTheme;
}

/** First value >= lo via binary search, or -1 if none. */
function firstAtLeast(sorted: number[], lo: number): number {
  let a = 0;
  let b = sorted.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (sorted[m] < lo) a = m + 1;
    else b = m;
  }
  return a < sorted.length ? a : -1;
}

/** Min gap (whole days) to a same-theme vote in [txMs, txMs + window], or undefined. */
export function minGapIndexed(
  t: IndexedTrade,
  index: ThemeVoteIndex,
  windowDays: number,
): number | undefined {
  const arr = index.get(t.theme);
  if (!arr) return undefined;
  const hi = t.txMs + windowDays * MS_PER_DAY;
  const i = firstAtLeast(arr, t.txMs);
  if (i === -1 || arr[i] > hi) return undefined;
  return Math.round((arr[i] - t.txMs) / MS_PER_DAY);
}

/** Canonical entry point: trade id -> min same-theme day-gap (only trades with a match). */
export function minGapsByTrade(
  trades: ThemeTrade[],
  votes: ThemeVote[],
  windowDays: number,
): Map<string, number> {
  const index = buildThemeVoteIndex(votes);
  const out = new Map<string, number>();
  for (const t of trades) {
    const g = minGapIndexed({ id: t.id, theme: t.theme, txMs: Date.parse(t.txDate) }, index, windowDays);
    if (g !== undefined) out.set(t.id, g);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test pipeline/patterns/_gap.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add pipeline/patterns/_gap.ts pipeline/patterns/_gap.test.ts
git commit -m "feat(patterns): pure per-trade min-gap-to-same-theme-vote helper"
```

---

## Task 2: Per-pair lower-tail null (extend the draw to expose gaps)

**Files:**
- Modify: `pipeline/patterns/_gap.ts` (add the per-pair permutation)
- Test: `pipeline/patterns/_gap.test.ts` (add cases)

The existing `_permutation.ts` draws return a scalar *count*. The receipts need, per draw, each trade's resampled gap, so we can ask per-pair "was the shuffled gap ≤ the observed gap?". We add a small permutation that reuses `_rng` and the same shuffle semantics (calendar / volume) but accumulates per-trade lower-tail hits.

- [ ] **Step 1: Write the failing test**

```ts
// append to pipeline/patterns/_gap.test.ts
import { perPairLowerTail } from './_gap.js';
import { mulberry32 } from './_rng.js';

test('a structurally guaranteed-tight gap scores a low p; a loose one does not', () => {
  // One theme, one trade, votes packed so the observed (tight) gap is rare under shuffle.
  const trades: ThemeTrade[] = [T('t1', '2024-06-03', 'tech')];
  const votes: ThemeVote[] = [V('v1', '2024-06-04', 'tech')]; // observed gap = 1 day
  const observed = minGapsByTrade(trades, votes, 90); // t1 -> 1
  const res = perPairLowerTail({
    trades,
    votes,
    windowDays: 90,
    observed,
    nPerm: 2000,
    rng: mulberry32(42),
    mode: 'calendar',
    windowStart: '2024-01-01',
    windowEnd: '2024-12-31',
  });
  const p = res.get('t1')!;
  assert.ok(p > 0 && p <= 1, 'p in (0,1]');
  assert.ok(p < 0.2, `tight 1-day gap against a sparse calendar should be rare, got ${p}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test pipeline/patterns/_gap.test.ts`
Expected: FAIL — `perPairLowerTail is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to pipeline/patterns/_gap.ts
const WEEKEND = new Set([0, 6]);
function weekdayPoolMs(start: string, end: string): number[] {
  const pool: number[] = [];
  for (let ms = Date.parse(start); ms <= Date.parse(end); ms += MS_PER_DAY) {
    if (!WEEKEND.has(new Date(ms).getUTCDay())) pool.push(ms);
  }
  return pool;
}

/**
 * Per-pair lower-tail null. For each draw, every trade's date is resampled
 * (calendar: a random market-open day in [windowStart,windowEnd]; volume: a
 * Fisher-Yates permutation of the member's own trade dates), theme matching is
 * re-applied, and each observed trade is credited if its resampled gap <= its
 * observed gap. p_pair = (1 + hits) / (nPerm + 1), one-sided lower tail.
 */
export function perPairLowerTail(opts: {
  trades: ThemeTrade[];
  votes: ThemeVote[];
  windowDays: number;
  observed: Map<string, number>;
  nPerm: number;
  rng: () => number;
  mode: 'calendar' | 'volume-shuffle';
  windowStart?: string;
  windowEnd?: string;
}): Map<string, number> {
  const { trades, votes, windowDays, observed, nPerm, rng, mode } = opts;
  const index = buildThemeVoteIndex(votes);
  const slot: IndexedTrade[] = trades.map(t => ({ id: t.id, theme: t.theme, txMs: 0 }));
  const baseDatesMs = trades.map(t => Date.parse(t.txDate));
  const pool = mode === 'calendar' ? weekdayPoolMs(opts.windowStart!, opts.windowEnd!) : [];
  const hits = new Map<string, number>();
  for (const id of observed.keys()) hits.set(id, 0);

  for (let k = 0; k < nPerm; k++) {
    if (mode === 'calendar') {
      for (let i = 0; i < slot.length; i++) slot[i].txMs = pool[Math.floor(rng() * pool.length)];
    } else {
      const d = baseDatesMs.slice();
      for (let i = d.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [d[i], d[j]] = [d[j], d[i]];
      }
      for (let i = 0; i < slot.length; i++) slot[i].txMs = d[i];
    }
    for (const s of slot) {
      const obs = observed.get(s.id);
      if (obs === undefined) continue;
      const g = minGapIndexed(s, index, windowDays);
      if (g !== undefined && g <= obs) hits.set(s.id, hits.get(s.id)! + 1);
    }
  }

  const p = new Map<string, number>();
  for (const [id, h] of hits) p.set(id, (1 + h) / (nPerm + 1));
  return p;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test pipeline/patterns/_gap.test.ts`
Expected: PASS — all gap tests.

- [ ] **Step 5: Commit**

```bash
git add pipeline/patterns/_gap.ts pipeline/patterns/_gap.test.ts
git commit -m "feat(patterns): per-pair lower-tail null for theme-gap receipts"
```

---

## Task 3: Artifact schema (`ThemeGapReceiptsSchema`)

**Files:**
- Modify: `lib/schemas.ts`
- Test: covered by Task 4's orchestrator test (the orchestrator validates-on-write).

- [ ] **Step 1: Add the schema**

```ts
// lib/schemas.ts — add near the other output schemas
export const ReceiptBandSchema = z.enum(['insufficient-data', 'low-power', 'ranked']);

export const ThemeGapReceiptSchema = z.object({
  theme: z.string(),
  tradeFilingId: z.string(),
  ticker: z.string(),
  txType: z.string(),
  txDate: z.string(),
  voteId: z.string(),
  voteDate: z.string(),
  billId: z.string(),
  billTitle: z.string(),
  daysBeforeVote: z.number().int().nonnegative(),
  pPair: z.number().min(0).max(1).nullable(), // null in insufficient-data band
  tradeSourceUrl: z.string(),
  voteSourceUrl: z.string(),
  billSourceUrl: z.string(),
});

export const ThemeGapReceiptsSchema = z.object({
  memberId: z.string(),
  tradeCount: z.number().int().nonnegative(),          // theme-mappable trades = band denominator + null population
  disclosedTradeCount: z.number().int().nonnegative(), // raw PTR rows, for the coverage strip's "N disclosed"
  band: ReceiptBandSchema,
  nPerm: z.number().int().positive(),
  windowDays: z.number().int().positive(),
  coverage: z.object({
    votesTotal: z.number().int().nonnegative(),
    votesBillLinked: z.number().int().nonnegative(),
  }),
  receipts: z.array(ThemeGapReceiptSchema), // ranked band: sorted by pPair asc; others: chronological
});
export type ThemeGapReceipts = z.infer<typeof ThemeGapReceiptsSchema>;
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors introduced).

- [ ] **Step 3: Commit**

```bash
git add lib/schemas.ts
git commit -m "feat(schemas): ThemeGapReceipts artifact (per-pair receipts + bands + coverage)"
```

---

## Task 4: Theme-eligible vote view (`v_theme_eligible_votes`)

**Files:**
- Modify: `db/schema.sql` (add the view near `v_trade_bill_nexus`, line ~634)
- Test: `pipeline/score-theme-gaps.test.ts` covers it indirectly via the smoke run; add a direct count assertion below.

The null must be able to match a shuffled trade against *any* theme-eligible vote in the window — not only votes that historically matched a trade. This view is the trade-independent vote population, carrying the SAME focused-bill/title guards as `v_trade_bill_nexus` so observation and null share one predicate.

- [ ] **Step 1: Add the view**

```sql
-- db/schema.sql — after the v_trade_bill_nexus definition.
-- Column shapes verified against live schema (Grok review, 2026-06-15):
--   * votes has NO bill_title — title comes from bill_summaries.title (as v_trades_near_votes does)
--   * the column is votes.date, aliased to vote_date here
--   * theme is BILL-anchored (m.theme) — not the ticker-side COALESCE the nexus uses
CREATE OR REPLACE VIEW v_theme_eligible_votes AS
SELECT DISTINCT
  v.member_id,
  v.vote_id,
  v.date AS vote_date,
  m.theme,
  v.bill_id
FROM votes v
JOIN bill_subjects      bsub ON bsub.bill_id = v.bill_id
LEFT JOIN bill_summaries bsum ON bsum.bill_id = v.bill_id
JOIN theme_bill_match    m   ON ( (m.policy_area IS NOT NULL AND bsub.policy_area = m.policy_area)
                               OR (m.subject_pattern IS NOT NULL AND bsub.subject ILIKE m.subject_pattern
                                   AND (SELECT COUNT(*) FROM bill_subjects b2 WHERE b2.bill_id = v.bill_id) <= 25) )
WHERE v.bill_id IS NOT NULL
  AND bsum.title IS NOT NULL
  AND LENGTH(bsum.title) >= 6
  AND bsum.title NOT ILIKE 'Providing for consideration%'
  AND bsum.title NOT ILIKE '%appropriations%'
  AND bsum.title NOT ILIKE '%consolidated%'
  AND bsum.title NOT ILIKE '%continuing%'
  AND bsum.title NOT ILIKE '%relief act%'
  AND bsum.title NOT ILIKE '%reconciliation%'
  AND bsum.title NOT ILIKE '%omnibus%'
  AND bsum.title NOT ILIKE '%national defense authorization%'
  AND bsum.title NOT ILIKE '%rescissions act%'
  AND regexp_extract(v.bill_id, '-(hr|s|hjres|sjres)-', 1) <> '';
```

- [ ] **Step 2: Verify it populates and is trade-independent**

Run:
```bash
npx tsx -e "import {getDb} from './db/init.js'; const c=await getDb(); \
  const n=await (await c.run('SELECT count(*) c FROM v_theme_eligible_votes')).getRowObjects(); \
  const nx=await (await c.run('SELECT count(DISTINCT vote_id) c FROM v_trade_bill_nexus')).getRowObjects(); \
  console.log('eligible_votes', String(n[0].c), 'nexus_distinct_votes', String(nx[0].c));"
```
Expected: `eligible_votes` ≥ `nexus_distinct_votes` (the eligible population is a superset — that's the whole point of the fix).

- [ ] **Step 3: Commit**

```bash
git add db/schema.sql
git commit -m "feat(schema): v_theme_eligible_votes — trade-independent vote population for the null"
```

---

## Task 5: Orchestrator (`score-theme-gaps.ts`)

**Files:**
- Create: `pipeline/score-theme-gaps.ts`
- Test: `pipeline/score-theme-gaps.test.ts`

The orchestrator reads `v_trade_bill_nexus` (observed guarded pairs), `v_theme_eligible_votes` (the null's vote population), the member's theme-mappable trade set from `pfd_transactions` (band denominator + null population), the raw disclosed-trade count, and a coverage count, then assembles the typed artifact. **Observed gap per trade = min `days_before_vote` across that trade's nexus rows** (the guarded juxtaposition). The null reshuffles the full theme-mappable trade set and recomputes gaps against `v_theme_eligible_votes`. Bands gate whether p-values are computed and how receipts are ordered.

- [ ] **Step 1: Write the failing test (pure assembly fn, DB injected)**

```ts
// pipeline/score-theme-gaps.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleReceipts, bandFor } from './score-theme-gaps.js';
import { ThemeGapReceiptsSchema } from '../lib/schemas.js';

test('bandFor: power bands by disclosed-trade count', () => {
  assert.equal(bandFor(4), 'insufficient-data');
  assert.equal(bandFor(5), 'low-power');
  assert.equal(bandFor(9), 'low-power');
  assert.equal(bandFor(10), 'ranked');
});

test('insufficient-data band emits receipts with null p, chronological', () => {
  const art = assembleReceipts({
    memberId: 'jane-doe',
    tradeCount: 3,
    disclosedTradeCount: 7,
    windowDays: 90,
    nPerm: 10000,
    coverage: { votesTotal: 71639, votesBillLinked: 15256 },
    nexusRows: [
      { theme: 'tech', tradeFilingId: 'f2', ticker: 'NVDA', txType: 'purchase', txDate: '2024-03-02',
        voteId: 'v2', voteDate: '2024-03-10', billId: '118-hr-2', billTitle: 'Chips B',
        daysBeforeVote: 8, tradeSourceUrl: 'u', voteSourceUrl: 'u', billSourceUrl: 'u' },
      { theme: 'tech', tradeFilingId: 'f1', ticker: 'AMD', txType: 'purchase', txDate: '2024-01-01',
        voteId: 'v1', voteDate: '2024-01-04', billId: '118-hr-1', billTitle: 'Chips A',
        daysBeforeVote: 3, tradeSourceUrl: 'u', voteSourceUrl: 'u', billSourceUrl: 'u' },
    ],
    pByTrade: new Map(), // not computed in insufficient band
  });
  assert.equal(art.band, 'insufficient-data');
  assert.deepEqual(art.receipts.map(r => r.pPair), [null, null]);
  // chronological by txDate ascending
  assert.deepEqual(art.receipts.map(r => r.txDate), ['2024-01-01', '2024-03-02']);
  assert.doesNotThrow(() => ThemeGapReceiptsSchema.parse(art));
});

test('ranked band sorts by pPair ascending', () => {
  const art = assembleReceipts({
    memberId: 'big-trader', tradeCount: 40, disclosedTradeCount: 52, windowDays: 90, nPerm: 10000,
    coverage: { votesTotal: 71639, votesBillLinked: 15256 },
    nexusRows: [
      { theme: 'tech', tradeFilingId: 'fA', ticker: 'A', txType: 'purchase', txDate: '2024-01-01',
        voteId: 'vA', voteDate: '2024-01-30', billId: '118-hr-1', billTitle: 'A',
        daysBeforeVote: 29, tradeSourceUrl: 'u', voteSourceUrl: 'u', billSourceUrl: 'u' },
      { theme: 'tech', tradeFilingId: 'fB', ticker: 'B', txType: 'purchase', txDate: '2024-02-01',
        voteId: 'vB', voteDate: '2024-02-03', billId: '118-hr-2', billTitle: 'B',
        daysBeforeVote: 2, tradeSourceUrl: 'u', voteSourceUrl: 'u', billSourceUrl: 'u' },
    ],
    pByTrade: new Map([['fA', 0.40], ['fB', 0.01]]),
  });
  assert.equal(art.band, 'ranked');
  assert.deepEqual(art.receipts.map(r => r.tradeFilingId), ['fB', 'fA']); // 0.01 before 0.40
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test pipeline/score-theme-gaps.test.ts`
Expected: FAIL — `Cannot find module './score-theme-gaps.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// pipeline/score-theme-gaps.ts
/**
 * Lane-1 scorer: theme-gated trade->vote receipts with a per-pair lower-tail
 * null and statistical-honesty power bands. Mirrors score-anomaly.ts but scores
 * PER PAIR (gap, lower tail) instead of a member-level count.
 *   npx tsx pipeline/score-theme-gaps.ts --member nancy-pelosi
 */
import { writeFileSync } from 'node:fs';
import { getDb } from '../db/init.js';
import { perPairLowerTail, type ThemeTrade, type ThemeVote } from './patterns/_gap.js';
import { mulberry32, seedFrom } from './patterns/_rng.js';
import { ThemeGapReceiptsSchema, type ThemeGapReceipts } from '../lib/schemas.js';

const WINDOW_DAYS = 90;
const N_PERM = 10_000;
const BASKET_TRADE_THRESHOLD = 50;
const MIN_TRADES_RANKED = 10;
const MIN_TRADES_POWER = 5;

export type Band = 'insufficient-data' | 'low-power' | 'ranked';
export function bandFor(tradeCount: number): Band {
  if (tradeCount < MIN_TRADES_POWER) return 'insufficient-data';
  if (tradeCount < MIN_TRADES_RANKED) return 'low-power';
  return 'ranked';
}

export interface NexusRow {
  theme: string;
  tradeFilingId: string;
  ticker: string;
  txType: string;
  txDate: string;
  voteId: string;
  voteDate: string;
  billId: string;
  billTitle: string;
  daysBeforeVote: number;
  tradeSourceUrl: string;
  voteSourceUrl: string;
  billSourceUrl: string;
}

export function assembleReceipts(input: {
  memberId: string;
  tradeCount: number;            // theme-mappable = band denominator
  disclosedTradeCount: number;   // raw PTR rows, coverage strip only
  windowDays: number;
  nPerm: number;
  coverage: { votesTotal: number; votesBillLinked: number };
  nexusRows: NexusRow[];
  pByTrade: Map<string, number>;
}): ThemeGapReceipts {
  const band = bandFor(input.tradeCount);
  const receipts = input.nexusRows.map(r => ({
    ...r,
    pPair: band === 'insufficient-data' ? null : (input.pByTrade.get(r.tradeFilingId) ?? null),
  }));
  receipts.sort((a, b) =>
    band === 'ranked'
      ? (a.pPair ?? 1) - (b.pPair ?? 1) || a.txDate.localeCompare(b.txDate)
      : a.txDate.localeCompare(b.txDate),
  );
  const art: ThemeGapReceipts = {
    memberId: input.memberId,
    tradeCount: input.tradeCount,
    disclosedTradeCount: input.disclosedTradeCount,
    band,
    nPerm: input.nPerm,
    windowDays: input.windowDays,
    coverage: input.coverage,
    receipts,
  };
  return ThemeGapReceiptsSchema.parse(art);
}

/** Observed gap per trade = the closest guarded vote (min days_before_vote across its nexus rows). */
export function observedGaps(nexusRows: NexusRow[]): Map<string, number> {
  const g = new Map<string, number>();
  for (const r of nexusRows) {
    const cur = g.get(r.tradeFilingId);
    if (cur === undefined || r.daysBeforeVote < cur) g.set(r.tradeFilingId, r.daysBeforeVote);
  }
  return g;
}

// --- DB glue (not unit-tested; exercised by --member runs) ---

async function loadMember(member: string): Promise<{
  nexusRows: NexusRow[];
  trades: ThemeTrade[];
  votes: ThemeVote[];
  tradeCount: number;
  disclosedTradeCount: number;
  coverage: { votesTotal: number; votesBillLinked: number };
}> {
  const conn = await getDb();
  const nx = (await (await conn.run(
    `SELECT theme, trade_filing_id::text AS "tradeFilingId", UPPER(ticker) AS ticker, tx_type AS "txType",
            tx_date::text AS "txDate", vote_id::text AS "voteId", vote_date::text AS "voteDate",
            bill_id AS "billId", bill_title AS "billTitle", days_before_vote::int AS "daysBeforeVote",
            trade_source_url AS "tradeSourceUrl", vote_source_url AS "voteSourceUrl", bill_source_url AS "billSourceUrl"
       FROM v_trade_bill_nexus WHERE member_id = ?
      ORDER BY "tradeFilingId", "txDate", ticker, "voteId"`,
    [member],
  )).getRowObjects()) as unknown as NexusRow[];

  // Full disclosed trade set (band denominator + null population), with theme.
  const trades = (await (await conn.run(
    `SELECT p.filing_id::text AS id, p.tx_date::text AS "txDate",
            COALESCE(o.theme, st.theme) AS theme
       FROM pfd_transactions p
       JOIN ticker_sectors ts ON ts.ticker = UPPER(p.ticker)
       LEFT JOIN sic_theme st ON st.sic = ts.sic
       LEFT JOIN ticker_theme_override o ON o.ticker = UPPER(p.ticker)
      WHERE p.member_id = ? AND COALESCE(o.theme, st.theme) IS NOT NULL`,
    [member],
  )).getRowObjects()) as unknown as ThemeTrade[];

  // Null vote population: trade-INDEPENDENT theme-eligible votes (the review fix).
  const votes = (await (await conn.run(
    `SELECT vote_id::text AS id, vote_date::text AS "voteDate", theme
       FROM v_theme_eligible_votes WHERE member_id = ?`,
    [member],
  )).getRowObjects()) as unknown as ThemeVote[];

  const disclosed = (await (await conn.run(
    `SELECT count(*)::int AS c FROM pfd_transactions WHERE member_id = ?`,
    [member],
  )).getRowObjects())[0] as unknown as { c: number };

  const cov = (await (await conn.run(
    `SELECT count(*)::int AS "votesTotal",
            count(*) FILTER (WHERE bill_id IS NOT NULL)::int AS "votesBillLinked"
       FROM votes WHERE member_id = ?`,
    [member],
  )).getRowObjects())[0] as unknown as { votesTotal: number; votesBillLinked: number };

  return {
    nexusRows: nx, trades, votes,
    tradeCount: trades.length, disclosedTradeCount: disclosed.c, coverage: cov,
  };
}

async function scoreMember(member: string): Promise<void> {
  const { nexusRows, trades, votes, tradeCount, disclosedTradeCount, coverage } = await loadMember(member);
  const band = bandFor(tradeCount);

  let pByTrade = new Map<string, number>();
  if (band !== 'insufficient-data' && trades.length > 0) {
    // Observed = the GUARDED pair's gap (closest nexus vote per trade), not a loose recompute.
    const observed = observedGaps(nexusRows);
    const rng = mulberry32(seedFrom(`theme-gap|${member}`));
    const mode = trades.length >= BASKET_TRADE_THRESHOLD ? 'volume-shuffle' : 'calendar';
    const all = [...trades.map(t => t.txDate), ...votes.map(v => v.voteDate)].sort();
    // Null reshuffles the full theme-mappable trade set; recomputes gaps against the
    // trade-independent eligible-vote population. Observed stays the guarded gap.
    pByTrade = perPairLowerTail({
      trades, votes, windowDays: WINDOW_DAYS, observed, nPerm: N_PERM, rng, mode,
      windowStart: all[0], windowEnd: all[all.length - 1],
    });
  }

  const art = assembleReceipts({
    memberId: member, tradeCount, disclosedTradeCount,
    windowDays: WINDOW_DAYS, nPerm: N_PERM, coverage, nexusRows, pByTrade,
  });
  const out = `pipeline/artifacts/${member}.theme-gaps.json`;
  writeFileSync(out, JSON.stringify(art, null, 2));
  console.log(`${member} [${band}]: trades=${tradeCount} receipts=${art.receipts.length} -> ${out}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--member');
  if (i === -1 || !args[i + 1]) {
    console.error('usage: score-theme-gaps.ts --member <slug>');
    process.exit(2);
  }
  await scoreMember(args[i + 1]);
}

// Only run main() as a script, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test pipeline/score-theme-gaps.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Smoke-run against the real DB**

Run: `npx tsx pipeline/score-theme-gaps.ts --member nancy-pelosi`
Expected: prints `nancy-pelosi [...]: trades=N receipts=M -> pipeline/artifacts/nancy-pelosi.theme-gaps.json` and writes a schema-valid file. (Pelosi is the richest-trade member in the corpus.)

- [ ] **Step 6: Commit**

```bash
git add pipeline/score-theme-gaps.ts pipeline/score-theme-gaps.test.ts
git commit -m "feat(pipeline): score-theme-gaps orchestrator (per-pair receipts, power bands)"
```

---

## Task 6: Render — coverage strip + ranked receipt cards

**Files:**
- Modify: `render/build.ts` (add a receipts section fed by the artifact)
- Test: `render/receipts.test.ts`

Render reads the `ThemeGapReceipts` artifact and emits a deterministic section: a coverage strip, then receipt cards. No LLM (ADR 0001). The four states (`insufficient-data`, `low-power`, `ranked`, and zero-receipts) all render explicit copy — never omission (consistent with #7).

- [ ] **Step 1: Write the failing test**

```ts
// render/receipts.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReceiptsSection } from './build.js';
import type { ThemeGapReceipts } from '../lib/schemas.js';

const base: ThemeGapReceipts = {
  memberId: 'm', tradeCount: 0, disclosedTradeCount: 0, band: 'insufficient-data', nPerm: 10000, windowDays: 90,
  coverage: { votesTotal: 71639, votesBillLinked: 15256 }, receipts: [],
};

test('coverage strip states the linked/total split honestly', () => {
  const html = renderReceiptsSection(base);
  assert.match(html, /15,?256/);
  assert.match(html, /71,?639/);
});

test('coverage strip shows all three trade counts (disclosed / mappable / receipts)', () => {
  const html = renderReceiptsSection({ ...base, disclosedTradeCount: 12, tradeCount: 4 });
  assert.match(html, /12 disclosed/i);
  assert.match(html, /4 theme-mappable/i);
  assert.match(html, /0 .*receipt/i);
});

test('zero receipts renders an explicit empty state, not omission', () => {
  const html = renderReceiptsSection(base);
  assert.match(html, /no .*trade.*vote.*on record/i);
});

test('insufficient-data shows the n-trades reason and no p-values', () => {
  const html = renderReceiptsSection({
    ...base, tradeCount: 3,
    receipts: [{ theme: 'tech', tradeFilingId: 'f', ticker: 'AMD', txType: 'purchase', txDate: '2024-01-01',
      voteId: 'v', voteDate: '2024-01-04', billId: '118-hr-1', billTitle: 'Chips A', daysBeforeVote: 3,
      pPair: null, tradeSourceUrl: 'u', voteSourceUrl: 'u', billSourceUrl: 'u' }],
  });
  assert.match(html, /minimum 5|insufficient/i);
  assert.doesNotMatch(html, /p\s*=/i);
});

test('ranked receipt shows the day-gap juxtaposition and p, with all three cite links', () => {
  const html = renderReceiptsSection({
    ...base, tradeCount: 40, band: 'ranked',
    receipts: [{ theme: 'tech', tradeFilingId: 'f', ticker: 'NVDA', txType: 'purchase', txDate: '2024-02-01',
      voteId: 'v', voteDate: '2024-02-03', billId: '118-hr-2', billTitle: 'Chips B', daysBeforeVote: 2,
      pPair: 0.01, tradeSourceUrl: 'TU', voteSourceUrl: 'VU', billSourceUrl: 'BU' }],
  });
  assert.match(html, /2 days later/i);
  assert.match(html, /p\s*=\s*0\.01/);
  for (const u of ['TU', 'VU', 'BU']) assert.ok(html.includes(u), `cite ${u} present`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test render/receipts.test.ts`
Expected: FAIL — `renderReceiptsSection is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// render/build.ts — add and export. esc() is the existing HTML-escaper in this file.
import type { ThemeGapReceipts } from '../lib/schemas.js';

const fmtN = (n: number) => n.toLocaleString('en-US');

export function renderReceiptsSection(a: ThemeGapReceipts): string {
  const cov = `<p class="coverage">` +
    `${fmtN(a.coverage.votesBillLinked)} of ${fmtN(a.coverage.votesTotal)} roll-call votes are linked to a ` +
    `specific bill; the rest are procedural and cannot be matched. ` +
    `${fmtN(a.disclosedTradeCount)} disclosed trades · ${fmtN(a.tradeCount)} theme-mappable · ` +
    `${fmtN(a.receipts.length)} theme-matched receipts.</p>`;

  if (a.receipts.length === 0) {
    return `<section class="receipts"><h2>Trade–vote timing</h2>${cov}` +
      `<p class="empty">No theme-matched trade→vote pairs on record for this member.</p></section>`;
  }
  if (a.band === 'insufficient-data') {
    const banner = `<p class="band">Timing score unavailable — ${a.tradeCount} disclosed trades ` +
      `(minimum 5). Receipts below are shown for the record, unranked.</p>`;
    return `<section class="receipts"><h2>Trade–vote timing</h2>${cov}${banner}` +
      a.receipts.map(card).join('') + `</section>`;
  }
  const banner = a.band === 'low-power'
    ? `<p class="band">Low statistical power — ${a.tradeCount} disclosed trades. Timing shown but not ranked.</p>`
    : '';
  return `<section class="receipts"><h2>Trade–vote timing</h2>${cov}${banner}` +
    a.receipts.map(card).join('') + `</section>`;
}

function card(r: ThemeGapReceipts['receipts'][number]): string {
  const p = r.pPair === null ? '' : ` · <span class="p">p = ${r.pPair.toFixed(2)}</span>`;
  return `<article class="receipt" data-theme="${esc(r.theme)}">` +
    `<a href="${esc(r.tradeSourceUrl)}">${esc(r.txType)} ${esc(r.ticker)}</a> on ${esc(r.txDate)} — ` +
    `<b>${r.daysBeforeVote} days later</b> → ` +
    `<a href="${esc(r.voteSourceUrl)}">voted</a> on ` +
    `<a href="${esc(r.billSourceUrl)}">${esc(r.billTitle)}</a> (${esc(r.voteDate)})${p}</article>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test render/receipts.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Full suite + corpus validation**

Run: `npm test && npm run validate:corpus`
Expected: all green; corpus still validates.

- [ ] **Step 6: Commit**

```bash
git add render/build.ts render/receipts.test.ts
git commit -m "feat(render): theme-gap receipts section + coverage strip (deterministic, ADR 0001)"
```

---

## Self-Review

**Spec coverage:**
- Per-pair lower-tail null → Tasks 1–2. ✓
- Trade-independent vote population (review fix) → `v_theme_eligible_votes` (Task 4), consumed by the null in Task 5. ✓
- Observed gap = guarded nexus-row gap (review fix) → `observedGaps()` (Task 5). ✓
- 3 power bands → `bandFor` (Task 5) + render banners (Task 6). ✓
- Coverage strip (3 trade counts + vote split) → schema (Task 3) + render (Task 6). ✓
- Theme re-applied post-shuffle, across-all-trades → `perPairLowerTail` rebuilds gaps each draw (Task 2). ✓
- Deterministic render / no LLM → Task 6 is pure string assembly. ✓
- Empty/insufficient/zero states first-class → Task 6 tests. ✓
- Low-power p shown in audit drawer, not headline rank (Grok nit) → render `low-power` banner keeps receipts chronological, no cross-cohort sort (Task 6). ✓
- Reuse existing `_rng` + shuffle semantics → Task 2 imports `mulberry32`; mirrors `_permutation` draws. ✓

**Open items deliberately deferred (separate plans):** per-theme Coherence cards; money→vote detector (#6, which reuses `v_theme_eligible_votes`); uniform skeleton (#7) — Task 6's empty-states are the seam they plug into.

**Resolved in review:** `assembleReceipts` validate-on-write throw is correct for a pipeline emitter (Grok confirmed it's a different failure class from the code-checker/final-reviewer circuit-breaker; a bad nexus row is a data bug — fail loud with the member slug).

**Verified against live schema (Grok review):** `v_theme_eligible_votes` columns corrected — `votes.date AS vote_date`, title from `bill_summaries.title` (votes has no `bill_title`), `m.theme` bill-anchored. Task 4 Step 2's smoke assertion (`eligible_votes >= nexus_distinct_votes`) is the post-build sanity check; if it fails, predicate drift between the two views.
