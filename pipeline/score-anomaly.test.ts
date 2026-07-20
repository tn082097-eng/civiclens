/**
 * Pure (no-DB) tests for the generalized per-member scorer.
 *
 * The pre-registration gate forbids running any pipeline CLI against the live
 * DB, so these exercise ONLY the pure core `computeScore(trades, votes, seed)`:
 * observed count + null dispatch + permutationTest. The DB flow (`scorePattern`,
 * substrate load, row-check, UPDATE) is not tested here.
 *
 * `computeScore` takes an optional final `nPerm` arg (default 10_000) purely for
 * test speed; the CLI / `scorePattern` path never exposes it (pre-registered
 * constant).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeScore, SCORED_PATTERNS } from './score-anomaly.js';
import type { Trade, NexusVote } from './patterns/_nexus.js';

const T = (id: string, date: string, ticker: string): Trade => ({ id, txDate: date, ticker });
/** Committee-only vote (the spousal shape): namedTickers always []. */
const CV = (id: string, date: string): NexusVote =>
  ({ id, voteDate: date, committee: true, namedTickers: [] });

// (a) Spousal observed count on hand-built fixtures. Committee is the only
//     nexus; window is [tx_date, tx_date + 14d].
test('spousal observed: committee vote inside 14d window counts', () => {
  const trades = [T('t1', '2024-01-01', 'NVDA')];
  const votes = [CV('v1', '2024-01-10')]; // +9 days
  const r = computeScore(trades, votes, 'seed-a', 200);
  assert.equal(r.observed, 1);
});

test('spousal observed: committee vote outside 14d window does not count', () => {
  const trades = [T('t1', '2024-01-01', 'NVDA')];
  const votes = [CV('v1', '2024-01-16')]; // +15 days
  const r = computeScore(trades, votes, 'seed-a', 200);
  assert.equal(r.observed, 0);
});

test('spousal observed: same-day vote counts', () => {
  const trades = [T('t1', '2024-01-01', 'NVDA')];
  const votes = [CV('v1', '2024-01-01')];
  const r = computeScore(trades, votes, 'seed-a', 200);
  assert.equal(r.observed, 1);
});

test('spousal observed: a second vote on the same trade does not double count', () => {
  const trades = [T('t1', '2024-01-01', 'NVDA')];
  const votes = [CV('v1', '2024-01-05'), CV('v2', '2024-01-10')]; // both in-window
  const r = computeScore(trades, votes, 'seed-a', 200);
  assert.equal(r.observed, 1, 'the trade is counted once, not twice');
});

// (b) Seeded determinism: same fixture + same seedString -> identical result.
test('determinism: same fixture + same seed -> deep-equal ScoreResult', () => {
  const trades = [
    T('t1', '2024-01-01', 'NVDA'),
    T('t2', '2024-02-01', 'AAPL'),
    T('t3', '2024-03-01', 'TSLA'),
  ];
  const votes = [CV('v1', '2024-01-05'), CV('v2', '2024-03-04')];
  const a = computeScore(trades, votes, 'trade-vote-alignment-preregistered-v1|x', 500);
  const b = computeScore(trades, votes, 'trade-vote-alignment-preregistered-v1|x', 500);
  assert.deepEqual(a, b);
});

// (c) Different seedString -> (almost surely) different null on a small-nPerm
//     variant.
test('seed sensitivity: different seed -> different expected/pValue', () => {
  const trades = [
    T('t1', '2024-01-01', 'NVDA'),
    T('t2', '2024-02-01', 'AAPL'),
    T('t3', '2024-03-01', 'TSLA'),
    T('t4', '2024-04-01', 'MSFT'),
  ];
  const votes = [CV('v1', '2024-01-05'), CV('v2', '2024-03-04'), CV('v3', '2024-04-02')];
  const a = computeScore(trades, votes, 'seed-one', 500);
  const b = computeScore(trades, votes, 'seed-two', 500);
  assert.notDeepEqual(
    { expected: a.expected, pValue: a.pValue },
    { expected: b.expected, pValue: b.pValue },
  );
});

// (d) Dispatch boundary: 49 -> calendar, 50 -> volume-shuffle.
function nTrades(n: number): Trade[] {
  const out: Trade[] = [];
  for (let i = 0; i < n; i++) {
    const day = String((i % 27) + 1).padStart(2, '0');
    out.push(T(`t${i}`, `2024-01-${day}`, 'NVDA'));
  }
  return out;
}

test('dispatch: 49 trades -> calendar null model', () => {
  const trades = nTrades(49);
  const votes = [CV('v1', '2024-01-15')];
  const r = computeScore(trades, votes, 'seed-a', 50);
  assert.equal(r.nullModel, 'calendar');
});

test('dispatch: 50 trades -> volume-shuffle null model', () => {
  const trades = nTrades(50);
  const votes = [CV('v1', '2024-01-15')];
  const r = computeScore(trades, votes, 'seed-a', 50);
  assert.equal(r.nullModel, 'volume-shuffle');
});

test('SCORED_PATTERNS lists both live detectors in order', () => {
  assert.deepEqual(SCORED_PATTERNS, ['trade-vote-alignment', 'spousal-trade-timing']);
});
