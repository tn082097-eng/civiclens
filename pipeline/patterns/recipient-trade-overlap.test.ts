import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from './_rng.js';
import {
  excludedTickers, districtTickerDollars, rosterStats, scrambleConfirmTickers,
  type ConfirmRow, type RecipientAmount,
} from './recipient-trade-overlap.js';

const confirms: ConfirmRow[] = [
  { recipientKey: 'r-nice', ticker: 'NICE' },
  { recipientKey: 'r-lmt-a', ticker: 'LMT' },
  { recipientKey: 'r-lmt-b', ticker: 'LMT' },
  { recipientKey: 'r-syk', ticker: 'SYK' },
];

function districts(): Map<string, RecipientAmount[]> {
  return new Map([
    ['m1', [{ recipientKey: 'r-nice', amount: 500 }, { recipientKey: 'r-lmt-a', amount: 10 }]],
    ['m2', [{ recipientKey: 'r-lmt-b', amount: 20 }, { recipientKey: 'r-x', amount: 7 }]],
    ['m3', [{ recipientKey: 'r-lmt-a', amount: 30 }, { recipientKey: 'r-syk', amount: 5e9 }]],
    ['m4', []], ['m5', []], ['m6', []],
  ]);
}

test('ubiquity: strictly greater than 1/3 of roster districts excludes', () => {
  // 6 districts: LMT appears in 3 (> 2) → excluded; NICE in 1, SYK in 1 → kept.
  const ex = excludedTickers(confirms, districts(), 6);
  assert.deepEqual([...ex].sort(), ['LMT']);
});

test('ubiquity boundary: exactly 1/3 is NOT excluded', () => {
  const ex = excludedTickers(confirms, districts(), 9); // 3 of 9 = exactly 1/3
  assert.equal(ex.size, 0);
});

test('districtTickerDollars: confirmed only, excluded dropped, dollars summed', () => {
  const cmap = new Map(confirms.map((c) => [c.recipientKey, c.ticker]));
  const d = districtTickerDollars(districts().get('m1')!, cmap, new Set(['LMT']));
  assert.deepEqual([...d.entries()], [['NICE', 500]]); // r-lmt-a excluded, r-x unconfirmed
});

test('rosterStats: S1 breadth ($500 == $5B), S2 exposure', () => {
  const cmap = new Map(confirms.map((c) => [c.recipientKey, c.ticker]));
  const ds = districts();
  const dollars = new Map([...ds.keys()].map((m) => [m, districtTickerDollars(ds.get(m)!, cmap, new Set())]));
  const traded = new Map([
    ['m1', new Set(['NICE', 'AAPL'])],
    ['m2', new Set<string>()],
    ['m3', new Set(['SYK'])],
    ['m4', new Set<string>()], ['m5', new Set<string>()], ['m6', new Set<string>()],
  ]);
  const ids = [...ds.keys()];
  const obs = rosterStats(ids, ids, traded, dollars);
  // m1: NICE overlap (S1 +1, S2 +500); m3: SYK overlap (S1 +1, S2 +5e9)
  assert.equal(obs.s1, 2);
  assert.equal(obs.s2, 500 + 5e9);
  // shuffled assignment: m1 scored against m2's district → no overlap anywhere except…
  const shuffled = ['m2', 'm1', 'm4', 'm3', 'm6', 'm5'];
  const nul = rosterStats(ids, shuffled, traded, dollars);
  // m1 vs m2-district: traded {NICE,AAPL} ∩ {LMT} = ∅; m3 vs m4-district: ∅ → 0
  assert.equal(nul.s1, 0);
  assert.equal(nul.s2, 0);
});

test('scramble preserves marginals: ticker multiset + recipient keys unchanged', () => {
  const rng = mulberry32(42);
  const out = scrambleConfirmTickers(confirms, rng);
  assert.deepEqual(out.map((c) => c.recipientKey), confirms.map((c) => c.recipientKey));
  assert.deepEqual(out.map((c) => c.ticker).sort(), confirms.map((c) => c.ticker).sort());
});

test('scramble is deterministic under a fixed seed', () => {
  const a = scrambleConfirmTickers(confirms, mulberry32(7));
  const b = scrambleConfirmTickers(confirms, mulberry32(7));
  assert.deepEqual(a, b);
});
