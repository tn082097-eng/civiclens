# Rigor Pillar (Anomaly Scoring) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Layer a permutation/Monte-Carlo null model on the `trade-vote-alignment` detector so a raw nexus count becomes observed-vs-expected with a p-value and z-score, validated on the Jayapal (signal survives) vs MTG (confound dies) contrast pair.

**Architecture:** A pure `countNexus()` (extracted from the detector's WHERE clause) is reused by both the live observation and every permutation draw, guaranteeing the null is measured with the exact rule as the observation. A seeded `permutationTest()` engine runs two `draw()` closures — calendar-randomization (Jayapal) and volume-preserving date-shuffle (MTG). Results land in additive nullable `pattern_hits` columns; the feed ranks by z-score.

**Tech Stack:** TypeScript, `tsx`, DuckDB (`@duckdb/node-api`), Node built-in test runner (`node:test`), no new dependencies (inline mulberry32 RNG).

**Spec:** `docs/superpowers/specs/2026-05-27-rigor-pillar-design.md`

---

## File Structure

- Create `pipeline/patterns/_rng.ts` — seeded mulberry32 + `seedFrom(str)`. Pure.
- Create `pipeline/patterns/_nexus.ts` — `Trade`, `NexusVote` types + pure `countNexus()`. Pure.
- Create `pipeline/patterns/_permutation.ts` — `permutationTest()` engine + `calendarDraw()` / `volumeShuffleDraw()` null-model factories. Pure (RNG injected).
- Create `pipeline/score-anomaly.ts` — orchestrator: assembles rows from `v_suspicious_trades`, computes observed, runs the member's null, writes scored columns to `pattern_hits`, mirrors to the vault.
- Modify `db/schema.sql` — add 6 nullable columns to `pattern_hits` (~line 487).
- Modify `db/migrate-pattern-hits.ts` — ALTER to add the columns to existing DBs.
- Modify `render/build.ts` — ranked conflict feed: order by z-score, render observed-vs-expected cards.
- Test files mirror each unit: `pipeline/patterns/_rng.test.ts`, `_nexus.test.ts`, `_permutation.test.ts`.

**Test command (verified):** `npx tsx --test <file>` → TAP output, look for `# pass N` / `# fail 0`.

---

### Task 1: Schema — add nullable scoring columns to `pattern_hits`

**Files:**
- Modify: `db/schema.sql:487-495`
- Modify: `db/migrate-pattern-hits.ts`

- [ ] **Step 1: Add columns to the CREATE TABLE in `db/schema.sql`**

Replace the `pattern_hits` column list (after `detected_at TIMESTAMP NOT NULL`) so the table reads:

```sql
CREATE TABLE IF NOT EXISTS pattern_hits (
  pattern         TEXT NOT NULL,
  member          TEXT NOT NULL,
  finding         TEXT NOT NULL,
  intensity       DOUBLE NOT NULL,
  citing_json     TEXT NOT NULL,
  dates_json      TEXT NOT NULL,
  detected_at     TIMESTAMP NOT NULL,
  null_model      TEXT,        -- 'calendar' | 'volume-shuffle' | NULL (unscored)
  observed        INTEGER,
  expected        DOUBLE,
  p_value         DOUBLE,
  z_score         DOUBLE,
  n_perm          INTEGER
);
```

- [ ] **Step 2: Add an idempotent ALTER to `db/migrate-pattern-hits.ts`**

After the existing table-create/backup logic, add (DuckDB supports `ADD COLUMN IF NOT EXISTS`):

```ts
const SCORING_COLS: [string, string][] = [
  ['null_model', 'TEXT'],
  ['observed', 'INTEGER'],
  ['expected', 'DOUBLE'],
  ['p_value', 'DOUBLE'],
  ['z_score', 'DOUBLE'],
  ['n_perm', 'INTEGER'],
];
for (const [col, type] of SCORING_COLS) {
  await conn.run(`ALTER TABLE pattern_hits ADD COLUMN IF NOT EXISTS ${col} ${type}`);
}
```

- [ ] **Step 3: Run the migration against the live DB**

Run: `npx tsx db/migrate-pattern-hits.ts`
Expected: exits 0, no error.

- [ ] **Step 4: Verify columns exist**

Run: `npx tsx -e "import('./db/init.js').then(async m=>{const c=await m.getDb();const r=await c.run('SELECT null_model,observed,expected,p_value,z_score,n_perm FROM pattern_hits LIMIT 0');console.log('ok');})"`
Expected: prints `ok` (query parses → columns exist).

- [ ] **Step 5: Commit**

```bash
git add db/schema.sql db/migrate-pattern-hits.ts
git commit -m "feat(rigor): add nullable scoring columns to pattern_hits"
```

---

### Task 2: Seeded RNG (`_rng.ts`)

**Files:**
- Create: `pipeline/patterns/_rng.ts`
- Test: `pipeline/patterns/_rng.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// pipeline/patterns/_rng.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, seedFrom } from './_rng.ts';

test('same seed yields identical sequence', () => {
  const a = mulberry32(123); const b = mulberry32(123);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test('different seeds diverge', () => {
  const a = mulberry32(1); const b = mulberry32(2);
  assert.notEqual(a(), b());
});

test('outputs are in [0,1)', () => {
  const r = mulberry32(99);
  for (let i = 0; i < 1000; i++) { const x = r(); assert.ok(x >= 0 && x < 1); }
});

test('seedFrom is deterministic per string', () => {
  assert.equal(seedFrom('trade-vote-alignment|jayapal'), seedFrom('trade-vote-alignment|jayapal'));
  assert.notEqual(seedFrom('a|b'), seedFrom('a|c'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test pipeline/patterns/_rng.test.ts`
Expected: FAIL — cannot find module `./_rng.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// pipeline/patterns/_rng.ts
/** Deterministic, dependency-free PRNG for reproducible permutation tests. */

/** mulberry32: 32-bit seed → () => float in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash (FNV-1a) of a string → a seed. */
export function seedFrom(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test pipeline/patterns/_rng.test.ts`
Expected: PASS — `# pass 4`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add pipeline/patterns/_rng.ts pipeline/patterns/_rng.test.ts
git commit -m "feat(rigor): seeded mulberry32 RNG + stable string seed"
```

---

### Task 3: `countNexus()` pure function (`_nexus.ts`)

**Files:**
- Create: `pipeline/patterns/_nexus.ts`
- Test: `pipeline/patterns/_nexus.test.ts`

The nexus rule (from `trade-vote-alignment.ts`): a trade counts if some vote falls 0..`windowDays` days AFTER the trade (trade before vote) AND (the member sat on the bill's committee OR the bill text names the trade's ticker). Broad-market ETF tickers never count. Each qualifying trade is counted once, regardless of how many votes it matches.

- [ ] **Step 1: Write the failing test**

```ts
// pipeline/patterns/_nexus.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countNexus, type Trade, type NexusVote } from './_nexus.ts';

const V = (id: string, date: string, committee: boolean, tickers: string[]): NexusVote =>
  ({ id, voteDate: date, committee, namedTickers: tickers });
const T = (id: string, date: string, ticker: string): Trade => ({ id, txDate: date, ticker });

test('committee vote within window counts the trade', () => {
  const trades = [T('t1', '2024-01-01', 'NVDA')];
  const votes = [V('v1', '2024-01-10', true, [])]; // 9 days after, committee
  assert.equal(countNexus(trades, votes, 14), 1);
});

test('ticker-named bill within window counts the trade', () => {
  const trades = [T('t1', '2024-01-01', 'NVDA')];
  const votes = [V('v1', '2024-01-05', false, ['NVDA'])];
  assert.equal(countNexus(trades, votes, 14), 1);
});

test('day-14 is inside, day-15 is outside', () => {
  const trades = [T('t1', '2024-01-01', 'NVDA')];
  assert.equal(countNexus(trades, [V('v1', '2024-01-15', true, [])], 14), 1);
  assert.equal(countNexus(trades, [V('v2', '2024-01-16', true, [])], 14), 0);
});

test('same-day (0 days) counts', () => {
  assert.equal(countNexus([T('t1', '2024-01-01', 'NVDA')], [V('v1', '2024-01-01', true, [])], 14), 1);
});

test('trade AFTER the vote does not count (negative offset)', () => {
  assert.equal(countNexus([T('t1', '2024-01-20', 'NVDA')], [V('v1', '2024-01-10', true, [])], 14), 0);
});

test('broad-market ETF ticker never counts', () => {
  assert.equal(countNexus([T('t1', '2024-01-01', 'SPY')], [V('v1', '2024-01-05', true, [])], 14), 0);
});

test('ticker path requires the trade ticker to be named, committee=false', () => {
  const trades = [T('t1', '2024-01-01', 'NVDA')];
  assert.equal(countNexus(trades, [V('v1', '2024-01-05', false, ['AAPL'])], 14), 0);
});

test('one trade matching many votes is counted once', () => {
  const trades = [T('t1', '2024-01-01', 'NVDA')];
  const votes = [V('v1', '2024-01-03', true, []), V('v2', '2024-01-05', true, []), V('v3', '2024-01-07', false, ['NVDA'])];
  assert.equal(countNexus(trades, votes, 14), 1);
});

test('counts distinct qualifying trades', () => {
  const trades = [T('t1', '2024-01-01', 'NVDA'), T('t2', '2024-02-01', 'AAPL'), T('t3', '2024-03-01', 'TSLA')];
  const votes = [V('v1', '2024-01-05', true, []), V('v2', '2024-02-03', false, ['AAPL'])];
  assert.equal(countNexus(trades, votes, 14), 2); // t1 + t2; t3 has no vote in window
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test pipeline/patterns/_nexus.test.ts`
Expected: FAIL — cannot find module `./_nexus.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// pipeline/patterns/_nexus.ts
/**
 * Pure nexus rule, extracted from trade-vote-alignment.ts so the live
 * observation and every permutation draw count with the IDENTICAL rule.
 */
import { BROAD_MARKET_ETFS } from './_filters.ts';

export interface Trade {
  id: string;
  txDate: string;   // ISO yyyy-mm-dd
  ticker: string;   // upper-case ticker symbol
}

export interface NexusVote {
  id: string;
  voteDate: string;        // ISO yyyy-mm-dd
  committee: boolean;      // member sat on a committee that handled the bill
  namedTickers: string[];  // tickers the bill text names (common-word filtered upstream)
}

const ETF = new Set(BROAD_MARKET_ETFS);
const MS_PER_DAY = 86_400_000;

function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(later) - Date.parse(earlier)) / MS_PER_DAY);
}

/** Count distinct trades that have a nexus vote within `windowDays` after them. */
export function countNexus(trades: Trade[], votes: NexusVote[], windowDays: number): number {
  let count = 0;
  for (const t of trades) {
    if (ETF.has(t.ticker)) continue;
    const hit = votes.some(v => {
      const d = daysBetween(t.txDate, v.voteDate); // >=0 means trade before vote
      if (d < 0 || d > windowDays) return false;
      return v.committee || v.namedTickers.includes(t.ticker);
    });
    if (hit) count++;
  }
  return count;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test pipeline/patterns/_nexus.test.ts`
Expected: PASS — `# pass 9`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add pipeline/patterns/_nexus.ts pipeline/patterns/_nexus.test.ts
git commit -m "feat(rigor): extract pure countNexus() nexus rule"
```

---

### Task 4: Permutation engine + null-model draws (`_permutation.ts`)

**Files:**
- Create: `pipeline/patterns/_permutation.ts`
- Test: `pipeline/patterns/_permutation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// pipeline/patterns/_permutation.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permutationTest, calendarDraw, volumeShuffleDraw } from './_permutation.ts';
import type { Trade, NexusVote } from './_nexus.ts';
import { mulberry32 } from './_rng.ts';

test('same seed yields identical result (idempotency)', () => {
  const draw = () => Math.random(); // not used; we pass nPerm/seed only via factory below
  const r1 = permutationTest({ observed: 5, nPerm: 1000, seed: 42, draw: makeFixedDraw(42) });
  const r2 = permutationTest({ observed: 5, nPerm: 1000, seed: 42, draw: makeFixedDraw(42) });
  assert.deepEqual(r1, r2);
});

// A draw that returns 0/1/2 deterministically from its own seeded rng,
// so expected ≈ 1 and we can check p/z math against a known distribution.
function makeFixedDraw(seed: number): () => number {
  const rng = mulberry32(seed);
  return () => Math.floor(rng() * 3); // uniform on {0,1,2}, mean 1
}

test('expected is the mean of draws; observed above mean → small p, positive z', () => {
  const r = permutationTest({ observed: 3, nPerm: 5000, seed: 7, draw: makeFixedDraw(7) });
  assert.ok(Math.abs(r.expected - 1) < 0.1, `expected ~1, got ${r.expected}`);
  assert.equal(r.pValue, 0, 'observed 3 exceeds max draw (2) → p=0');
  assert.ok(r.zScore > 0);
  assert.equal(r.nPerm, 5000);
  assert.equal(r.observed, 3);
});

test('p-value is fraction of draws >= observed', () => {
  // observed equal to mean → roughly upper half of mass counts
  const r = permutationTest({ observed: 1, nPerm: 5000, seed: 7, draw: makeFixedDraw(7) });
  assert.ok(r.pValue > 0.4 && r.pValue < 0.95, `p in band, got ${r.pValue}`);
});

test('calendarDraw reassigns trade dates within a weekday pool', () => {
  const trades: Trade[] = [{ id: 't1', txDate: '2024-01-02', ticker: 'NVDA' }];
  const votes: NexusVote[] = [{ id: 'v1', voteDate: '2024-01-10', committee: true, namedTickers: [] }];
  const rng = mulberry32(1);
  const draw = calendarDraw(trades, votes, 14, '2024-01-01', '2024-03-01', rng);
  const c = draw();
  assert.ok(c === 0 || c === 1, `draw returns a nexus count, got ${c}`);
});

test('volumeShuffleDraw permutes dates among the traded dates', () => {
  const trades: Trade[] = [
    { id: 't1', txDate: '2024-01-02', ticker: 'NVDA' },
    { id: 't2', txDate: '2024-01-09', ticker: 'AAPL' },
  ];
  const votes: NexusVote[] = [{ id: 'v1', voteDate: '2024-01-10', committee: false, namedTickers: ['NVDA'] }];
  const rng = mulberry32(1);
  const draw = volumeShuffleDraw(trades, votes, 14, rng);
  const c = draw();
  assert.ok(c >= 0 && c <= 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test pipeline/patterns/_permutation.test.ts`
Expected: FAIL — cannot find module `./_permutation.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// pipeline/patterns/_permutation.ts
/**
 * Monte-Carlo null engine + the two null-model draw factories.
 * RNG is injected so results are reproducible (see _rng.ts seedFrom).
 */
import { countNexus, type Trade, type NexusVote } from './_nexus.ts';

export interface PermResult {
  observed: number;
  expected: number;
  pValue: number;
  zScore: number;
  nPerm: number;
}

export function permutationTest(opts: {
  observed: number;
  nPerm: number;
  seed: number;          // recorded for provenance; draw closure owns the rng
  draw: () => number;    // one resampled nexus count under the null
}): PermResult {
  const { observed, nPerm } = opts;
  const samples = new Array<number>(nPerm);
  let sum = 0, atLeast = 0;
  for (let i = 0; i < nPerm; i++) {
    const c = opts.draw();
    samples[i] = c; sum += c;
    if (c >= observed) atLeast++;
  }
  const expected = sum / nPerm;
  let varSum = 0;
  for (const c of samples) varSum += (c - expected) ** 2;
  const sd = Math.sqrt(varSum / nPerm);
  const zScore = sd === 0 ? 0 : (observed - expected) / sd;
  const pValue = atLeast / nPerm; // one-sided upper tail
  return { observed, expected, pValue, zScore, nPerm };
}

const MS_PER_DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Weekday (Mon–Fri) days in [start,end] inclusive — market-open approximation. */
function weekdayPool(start: string, end: string): string[] {
  const pool: string[] = [];
  for (let ms = Date.parse(start); ms <= Date.parse(end); ms += MS_PER_DAY) {
    const dow = new Date(ms).getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) pool.push(iso(ms));
  }
  return pool;
}

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Calendar randomization (Jayapal): each draw reassigns every trade to a random
 * market-open day in [windowStart,windowEnd], ticker fixed, then counts nexus.
 */
export function calendarDraw(
  trades: Trade[], votes: NexusVote[], windowDays: number,
  windowStart: string, windowEnd: string, rng: () => number,
): () => number {
  const pool = weekdayPool(windowStart, windowEnd);
  return () => {
    const shuffled = trades.map(t => ({ ...t, txDate: pick(pool, rng) }));
    return countNexus(shuffled, votes, windowDays);
  };
}

/**
 * Volume-preserving date shuffle (MTG): each draw permutes the multiset of the
 * member's actual trade dates across trades (tickers fixed), then counts nexus.
 * Preserves trading cadence + basket size.
 */
export function volumeShuffleDraw(
  trades: Trade[], votes: NexusVote[], windowDays: number, rng: () => number,
): () => number {
  const dates = trades.map(t => t.txDate);
  return () => {
    const d = dates.slice();
    for (let i = d.length - 1; i > 0; i--) { // Fisher–Yates
      const j = Math.floor(rng() * (i + 1));
      [d[i], d[j]] = [d[j], d[i]];
    }
    const shuffled = trades.map((t, i) => ({ ...t, txDate: d[i] }));
    return countNexus(shuffled, votes, windowDays);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test pipeline/patterns/_permutation.test.ts`
Expected: PASS — `# pass 6`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add pipeline/patterns/_permutation.ts pipeline/patterns/_permutation.test.ts
git commit -m "feat(rigor): permutation engine + calendar/volume-shuffle nulls"
```

---

### Task 5: `score-anomaly.ts` orchestrator + slice acceptance

**Files:**
- Create: `pipeline/score-anomaly.ts`

This assembles the member's trade/vote universe from `v_suspicious_trades`, computes the observed nexus count, runs the member's assigned null model, and writes the scored columns to that member's existing `trade-vote-alignment` row in `pattern_hits` (UPDATE, not insert — the row is created by `run-patterns`). The common-word ticker filter on the bill-text path matches the detector.

- [ ] **Step 1: Write the orchestrator**

```ts
// pipeline/score-anomaly.ts
/**
 * Rigor pillar: score the trade-vote-alignment detector with a null model.
 *   npx tsx pipeline/score-anomaly.ts --member jayapal
 *   npx tsx pipeline/score-anomaly.ts --member marjorie-taylor-greene
 *
 * Calendar-randomization null for low-volume members; volume-preserving date
 * shuffle for basket traders. Updates pattern_hits scoring columns in place.
 */
import { getDb } from '../db/init.js';
import { COMMON_WORD_TICKERS } from './patterns/_filters.js';
import { countNexus, type Trade, type NexusVote } from './patterns/_nexus.js';
import { permutationTest, calendarDraw, volumeShuffleDraw } from './patterns/_permutation.js';
import { mulberry32, seedFrom } from './patterns/_rng.js';

const PATTERN = 'trade-vote-alignment';
const WINDOW_DAYS = 14;
const N_PERM = 10_000;
const COMMON = new Set(COMMON_WORD_TICKERS);
const BASKET_TRADE_THRESHOLD = 50; // >= this many trades → volume-shuffle null

interface Row {
  filing_id: string; tx_date: string; tx_type: string; instrument: string;
  vote_id: string; vote_date: string;
  member_on_bill_committee: boolean; bill_mentions_ticker: boolean;
}

const SQL = `
SELECT
  trade_filing_id::text AS filing_id,
  tx_date::text         AS tx_date,
  tx_type,
  UPPER(COALESCE(ticker, asset)) AS instrument,
  vote_id::text         AS vote_id,
  vote_date::text       AS vote_date,
  member_on_bill_committee,
  bill_mentions_ticker
FROM v_suspicious_trades
WHERE member_id = ?
`;

function assemble(rows: Row[]): { trades: Trade[]; votes: NexusVote[] } {
  const tradeMap = new Map<string, Trade>();
  const voteMap = new Map<string, NexusVote>();
  for (const r of rows) {
    const tKey = `${r.filing_id}|${r.tx_date}|${r.tx_type}|${r.instrument}`;
    if (!tradeMap.has(tKey)) tradeMap.set(tKey, { id: tKey, txDate: r.tx_date, ticker: r.instrument });
    let v = voteMap.get(r.vote_id);
    if (!v) { v = { id: r.vote_id, voteDate: r.vote_date, committee: false, namedTickers: [] }; voteMap.set(r.vote_id, v); }
    if (r.member_on_bill_committee) v.committee = true;
    if (r.bill_mentions_ticker && !COMMON.has(r.instrument) && !v.namedTickers.includes(r.instrument)) {
      v.namedTickers.push(r.instrument);
    }
  }
  return { trades: [...tradeMap.values()], votes: [...voteMap.values()] };
}

async function scoreMember(member: string): Promise<void> {
  const conn = await getDb();
  const res = await conn.run(SQL, [member]);
  const rows = (await res.getRowObjects()) as unknown as Row[];
  const { trades, votes } = assemble(rows);

  if (trades.length === 0) {
    console.log(`${member}: no qualifying trades — nothing to score.`);
    return;
  }

  const observed = countNexus(trades, votes, WINDOW_DAYS);
  const seed = seedFrom(`${PATTERN}|${member}`);
  const rng = mulberry32(seed);

  let nullModel: 'calendar' | 'volume-shuffle';
  let draw: () => number;
  if (trades.length >= BASKET_TRADE_THRESHOLD) {
    nullModel = 'volume-shuffle';
    draw = volumeShuffleDraw(trades, votes, WINDOW_DAYS, rng);
  } else {
    nullModel = 'calendar';
    const dates = [...trades.map(t => t.txDate), ...votes.map(v => v.voteDate)].sort();
    draw = calendarDraw(trades, votes, WINDOW_DAYS, dates[0], dates[dates.length - 1], rng);
  }

  const r = permutationTest({ observed, nPerm: N_PERM, seed, draw });

  await conn.run(
    `UPDATE pattern_hits
        SET null_model=?, observed=?, expected=?, p_value=?, z_score=?, n_perm=?
      WHERE pattern=? AND member=?`,
    [nullModel, r.observed, r.expected, r.pValue, r.zScore, r.nPerm, PATTERN, member],
  );
  console.log(
    `${member} [${nullModel}]: observed=${r.observed} expected=${r.expected.toFixed(2)} ` +
    `p=${r.pValue.toFixed(4)} z=${r.zScore.toFixed(2)} (n=${r.nPerm})`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--member');
  if (i === -1 || !args[i + 1]) { console.error('usage: score-anomaly.ts --member <slug>'); process.exit(2); }
  await scoreMember(args[i + 1]);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Ensure the detector rows exist (prereq)**

Run: `npx tsx pipeline/run-patterns.ts --member jayapal && npx tsx pipeline/run-patterns.ts --member marjorie-taylor-greene`
Expected: each prints a `trade-vote-alignment: N hit(s)` line. (Confirm the exact Jayapal slug with `npx tsx -e "import('./db/queries.js').then(async m=>console.log((await m.listMembers()).map(x=>x.member_id).filter(s=>s.includes('jay'))))"` and substitute if needed.)

- [ ] **Step 3: Score the contrast pair**

Run: `npx tsx pipeline/score-anomaly.ts --member jayapal`
Run: `npx tsx pipeline/score-anomaly.ts --member marjorie-taylor-greene`

- [ ] **Step 4: Acceptance gate — assert the two predicted outcomes**

Expected from the design:
- **Jayapal** → `null_model=calendar`, low `p_value` (signal survives — eyeball: p well below the expected hot-zone fraction).
- **MTG** → `null_model=volume-shuffle`, `p_value` high / `z_score≈0` (confound dies).

Run: `npx tsx -e "import('./db/init.js').then(async m=>{const c=await m.getDb();const r=await c.run(\"SELECT member,null_model,observed,expected,p_value,z_score FROM pattern_hits WHERE pattern='trade-vote-alignment' AND member IN ('jayapal','marjorie-taylor-greene')\");console.table(await r.getRowObjects());})"`

If MTG's `p_value` is not high (confound did not die) or Jayapal's is not low (signal did not survive), STOP — the null model or the trade universe is wrong. Diagnose before proceeding; do not tune to force the result.

- [ ] **Step 5: Commit**

```bash
git add pipeline/score-anomaly.ts
git commit -m "feat(rigor): score-anomaly orchestrator; validate Jayapal/MTG contrast"
```

---

### Task 6: Render the ranked conflict feed

**Files:**
- Modify: `render/build.ts` (the patterns section)

- [ ] **Step 1: Read the current patterns rendering**

Run: `grep -n "pattern_hits\|trade-vote-alignment\|Patterns" render/build.ts`
Identify where `pattern_hits` rows are loaded and rendered per member.

- [ ] **Step 2: Load scoring columns and rank by z-score**

Where `pattern_hits` is queried, add the scoring columns to the SELECT (`null_model, observed, expected, p_value, z_score, n_perm`) and, for the conflict feed, `ORDER BY z_score DESC NULLS LAST, p_value ASC`.

- [ ] **Step 3: Render observed-vs-expected on scored cards**

For rows where `null_model IS NOT NULL`, render beneath the existing finding sentence:
- `observed N vs expected X.X` (the contrast),
- a provenance line: `null model: <null_model> · N=<n_perm> · p=<p_value>`,
- a verdict derived from the numbers (no hardcoded member names): `p_value <= 0.05` → "timing signal survives"; else → "consistent with chance".
Unscored rows (`null_model IS NULL`) render exactly as today. Honor the no-red / weight-only intensity rule.

- [ ] **Step 4: Rebuild and eyeball**

Run: `npx tsx render/build.ts`
Expected: build completes. Open Jayapal's and MTG's profiles (and the feed) and confirm Jayapal ranks above MTG, and MTG shows observed≈expected with a "consistent with chance" verdict.

- [ ] **Step 5: Commit**

```bash
git add render/build.ts
git commit -m "feat(rigor): rank conflict feed by z-score; observed-vs-expected cards"
```

---

### Task 7: Mirror scored findings into the Obsidian vault

**Files:**
- Modify: `pipeline/score-anomaly.ts` (add a vault write after the UPDATE)

- [ ] **Step 1: Locate the vault Members/Connections convention**

Run: `ls ~/NoService/Projects/CivicLens/ && ls "$(find ~/NoService -type d -name Members 2>/dev/null | head -1)" 2>/dev/null | head`
Identify the existing per-member note path and wikilink style (the vault-sync hook already writes Connections/Members — match its format).

- [ ] **Step 2: Append a scored-finding note**

After the `UPDATE pattern_hits` in `scoreMember`, write/overwrite a note (idempotent, keyed on member+pattern) under the member's vault folder containing: the observed-vs-expected numbers, null model, p/z, and `[[member]]` + cited trade/vote wikilinks. Use the obsidian MCP `obsidian_write_note` tool path-addressed to the member note, or append via the existing vault-writer module if one exists (prefer reusing it — check `db/connections-to-vault.ts` or similar).

- [ ] **Step 3: Run and verify the note appears**

Run: `npx tsx pipeline/score-anomaly.ts --member jayapal`
Expected: the member's vault note now contains the observed-vs-expected block with working wikilinks (open in Obsidian to confirm backlinks resolve).

- [ ] **Step 4: Commit**

```bash
git add pipeline/score-anomaly.ts
git commit -m "feat(rigor): mirror scored findings into Obsidian vault"
```

---

## Self-Review

**Spec coverage:**
- countNexus extraction → Task 3 ✓
- _permutation.ts engine → Task 4 ✓
- score-anomaly.ts orchestrator → Task 5 ✓
- nullable pattern_hits columns → Task 1 ✓
- calendar (market-open mask) + volume-shuffle nulls → Task 4 (`weekdayPool` approximates market-open; full NYSE holiday calendar deferred as documented) ✓
- N=10k, seed=hash(pattern+member), mulberry32 → Tasks 2, 5 ✓
- ranked feed by z-score, observed-vs-expected, verdicts → Task 6 ✓
- vault write-back → Task 7 ✓
- intensity untouched → no task modifies it ✓
- Jayapal/MTG acceptance gate → Task 5 Step 4 ✓

**Deviation from spec (noted):** the spec describes `score-anomaly` *writing* the scored result; in the schema the detector row is created by `run-patterns`, so the orchestrator UPDATEs in place rather than inserting. Functionally identical; documented here.

**Placeholder scan:** no TBD/TODO; every code step has complete code. Task 6/7 reference existing files to read first because the exact insertion point depends on current `render/build.ts` and the vault writer — the *what* and *where* are specified, with grep commands to locate the line.

**Type consistency:** `Trade`/`NexusVote` defined in Task 3, used unchanged in Tasks 4–5. `permutationTest`/`calendarDraw`/`volumeShuffleDraw` signatures match between Task 4 definition and Task 5 call sites. `seedFrom`/`mulberry32` match Task 2.
