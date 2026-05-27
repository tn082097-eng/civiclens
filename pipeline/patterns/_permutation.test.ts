import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permutationTest, calendarDraw, volumeShuffleDraw } from './_permutation.js';
import type { Trade, NexusVote } from './_nexus.js';
import { mulberry32 } from './_rng.js';

// A draw that returns 0/1/2 uniformly from its own seeded rng (mean 1),
// so expected/p/z are checkable against a known distribution.
function makeFixedDraw(seed: number): () => number {
  const rng = mulberry32(seed);
  return () => Math.floor(rng() * 3);
}

test('same seed yields identical result (idempotency)', () => {
  const r1 = permutationTest({ observed: 5, nPerm: 1000, seed: 42, draw: makeFixedDraw(42) });
  const r2 = permutationTest({ observed: 5, nPerm: 1000, seed: 42, draw: makeFixedDraw(42) });
  assert.deepEqual(r1, r2);
});

test('expected is the mean of draws; observed above max -> p=0, z>0', () => {
  const r = permutationTest({ observed: 3, nPerm: 5000, seed: 7, draw: makeFixedDraw(7) });
  assert.ok(Math.abs(r.expected - 1) < 0.1, `expected ~1, got ${r.expected}`);
  assert.equal(r.pValue, 0, 'observed 3 exceeds max draw (2) -> p=0');
  assert.ok(r.zScore > 0);
  assert.equal(r.nPerm, 5000);
  assert.equal(r.observed, 3);
});

test('p-value is fraction of draws >= observed', () => {
  const r = permutationTest({ observed: 1, nPerm: 5000, seed: 7, draw: makeFixedDraw(7) });
  assert.ok(r.pValue > 0.4 && r.pValue < 0.95, `p in band, got ${r.pValue}`);
});

test('calendarDraw returns a nexus count', () => {
  const trades: Trade[] = [{ id: 't1', txDate: '2024-01-02', ticker: 'NVDA' }];
  const votes: NexusVote[] = [{ id: 'v1', voteDate: '2024-01-10', committee: true, namedTickers: [] }];
  const rng = mulberry32(1);
  const draw = calendarDraw(trades, votes, 14, '2024-01-01', '2024-03-01', rng);
  const c = draw();
  assert.ok(c === 0 || c === 1, `got ${c}`);
});

test('volumeShuffleDraw returns a nexus count', () => {
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
