/**
 * Timing-safe onboarding tests (Phase 1C). The default run-patterns member path
 * must never detect/write/score the parked timing pair
 * (trade-vote-alignment, spousal-trade-timing). We assert the detector selection
 * used by the onboarding path excludes exactly those two and keeps every other
 * detector — so no new member gets first timing p-values as an onboarding side
 * effect, and existing timing pattern_hits rows are never touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onboardingSafeDetectors, PARKED_TIMING_PATTERNS } from './run-patterns.ts';
import { DETECTORS } from './patterns/registry.ts';
import { SCORED_PATTERNS } from './score-anomaly.ts';

test('parked timing patterns are exactly the scored pair', () => {
  assert.deepEqual([...PARKED_TIMING_PATTERNS].sort(), [...SCORED_PATTERNS].sort());
});

test('onboarding-safe detectors exclude both parked timing detectors', () => {
  const names = onboardingSafeDetectors().map(d => d.name);
  assert.ok(!names.includes('trade-vote-alignment'), 'trade-vote-alignment filtered out');
  assert.ok(!names.includes('spousal-trade-timing'), 'spousal-trade-timing filtered out');
});

test('onboarding-safe detectors keep every non-parked detector', () => {
  const safe = onboardingSafeDetectors().map(d => d.name).sort();
  const expected = DETECTORS.map(d => d.name)
    .filter(n => !(PARKED_TIMING_PATTERNS as readonly string[]).includes(n))
    .sort();
  assert.deepEqual(safe, expected);
  // Sanity: the registry really does still contain the parked pair (we filter,
  // not delete) — so this guard is doing work.
  assert.ok(DETECTORS.some(d => d.name === 'trade-vote-alignment'));
});
