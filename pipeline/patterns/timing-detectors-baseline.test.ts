/**
 * Fixture-only tests for the timing-detectors negative-control harness.
 * No DB, no formal scoring output — pure-core behaviour only (spec Step-0:
 * the real control run is a gated, transcript-captured event).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scrambleVoteAttributes,
  runControlReplicate,
  evaluateVerdict,
} from './timing-detectors-baseline.js';
import { mulberry32, seedFrom } from './_rng.js';
import type { Trade, NexusVote } from './_nexus.js';

function votes(n: number): NexusVote[] {
  // Fixture where committee=true ALWAYS co-occurs with namedTickers=['X'],
  // committee=false ALWAYS with []. The tuple invariant must survive scramble.
  return Array.from({ length: n }, (_, i) => {
    const committee = i % 3 === 0; // ~1/3 committee votes
    return {
      id: `v${i}`,
      voteDate: `2023-01-${String((i % 28) + 1).padStart(2, '0')}`,
      committee,
      namedTickers: committee ? ['X'] : [],
    };
  });
}

test('scrambleVoteAttributes: preserves count, dates-in-place, marginals, tuple co-travel', () => {
  const original = votes(30);
  const rng = mulberry32(seedFrom('scramble-test'));
  const scrambled = scrambleVoteAttributes(original, rng);

  assert.equal(scrambled.length, original.length, 'vote count preserved');

  // Vote ids and dates stay at the same index (only attributes move).
  for (let i = 0; i < original.length; i++) {
    assert.equal(scrambled[i].id, original[i].id, `id at ${i} unchanged`);
    assert.equal(scrambled[i].voteDate, original[i].voteDate, `date at ${i} unchanged`);
  }

  // Committee-vote count preserved.
  const cOrig = original.filter(v => v.committee).length;
  const cScr = scrambled.filter(v => v.committee).length;
  assert.equal(cScr, cOrig, 'committee count preserved');

  // namedTickers multiset preserved.
  const tickerCount = (vs: NexusVote[]) => vs.reduce((n, v) => n + v.namedTickers.length, 0);
  assert.equal(tickerCount(scrambled), tickerCount(original), 'named-ticker multiset preserved');

  // Tuple co-travel: committee <=> namedTickers=['X'] invariant survives.
  for (const v of scrambled) {
    if (v.committee) assert.deepEqual(v.namedTickers, ['X'], 'committee vote keeps its ticker tuple');
    else assert.deepEqual(v.namedTickers, [], 'non-committee vote keeps empty tuple');
  }

  // Input not mutated.
  assert.deepEqual(original, votes(30), 'input array not mutated');
});

test('scrambleVoteAttributes: seeded determinism, seed-sensitivity', () => {
  const original = votes(40);
  const a = scrambleVoteAttributes(original, mulberry32(seedFrom('seed-A')));
  const a2 = scrambleVoteAttributes(original, mulberry32(seedFrom('seed-A')));
  const b = scrambleVoteAttributes(original, mulberry32(seedFrom('seed-B')));

  const shape = (vs: NexusVote[]) => vs.map(v => `${v.committee}:${v.namedTickers.join(',')}`).join('|');
  assert.equal(shape(a), shape(a2), 'same seed -> identical arrangement');
  assert.notEqual(shape(a), shape(b), 'different seed -> different arrangement');
});

test('runControlReplicate: well-formed ScoreResult, deterministic', () => {
  const trades: Trade[] = Array.from({ length: 8 }, (_, i) => ({
    id: `t${i}`,
    txDate: `2023-01-${String((i % 20) + 1).padStart(2, '0')}`,
    ticker: 'X',
  }));
  const vs = votes(20);

  const r1 = runControlReplicate(trades, vs, 'scr-1', 'null-1', 50);
  const r2 = runControlReplicate(trades, vs, 'scr-1', 'null-1', 50);

  assert.ok(['calendar', 'volume-shuffle'].includes(r1.nullModel), 'valid nullModel');
  assert.ok(r1.pValue >= 0 && r1.pValue <= 1, 'pValue in [0,1]');
  assert.equal(r1.nPerm, 50, 'nPerm honoured (test override)');
  assert.deepEqual(r1, r2, 'deterministic across two calls with same seeds');
});

test('evaluateVerdict: pooled 10% boundary and per-member >4/20 rule', () => {
  // Exactly 4/20 on one member, pooled small -> PASS.
  assert.equal(
    evaluateVerdict([{ member: 'a', sig: 4 }, { member: 'b', sig: 0 }], 20).pass,
    true,
    '4/20 with low pool passes',
  );
  // 5/20 on one member -> FAIL even if pooled <= 10%.
  assert.equal(
    evaluateVerdict([{ member: 'a', sig: 5 }, ...Array.from({ length: 20 }, (_, i) => ({ member: `z${i}`, sig: 0 }))], 20).pass,
    false,
    '5/20 on a single member fails despite low pool',
  );
  // Pooled just over 10% -> FAIL. 2 members, 3+0 of 20 each = 3/40 = 7.5% pass;
  // 5+0 of 20 -> but 5>4 fails on per-member. Build a pure pooled-fail:
  // 3 members at 3/20 each = 9/60 = 15% pooled, none over 4 -> FAIL on pool.
  assert.equal(
    evaluateVerdict([{ member: 'a', sig: 3 }, { member: 'b', sig: 3 }, { member: 'c', sig: 3 }], 20).pass,
    false,
    'pooled 15% fails on the pooled rule with no per-member breach',
  );
  // Pooled exactly 10% (2/20 on one member of ten), none over 4 -> PASS.
  assert.equal(
    evaluateVerdict([{ member: 'a', sig: 2 }, { member: 'b', sig: 0 }], 20).pass,
    true,
    'pooled 5% passes',
  );
});
