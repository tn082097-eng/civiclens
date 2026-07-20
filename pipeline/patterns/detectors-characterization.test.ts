/**
 * Characterization tests for the PURE logic of the two live timing detectors.
 *
 * Purpose: pin the score/intensity assembly and the trade-identity key so the
 * uppercase dedupe-key reconciliation cannot silently change detector output.
 * SQL is NOT exercised here (pre-registration gate: no CLI against the live DB).
 * Only the pure helpers the detectors expose are tested.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tradeIdentityKey, tradeIntensity } from './trade-vote-alignment.js';
import { spousalIntensity } from './spousal-trade-timing.js';

test('tradeIdentityKey uppercases the instrument (dedupe-key reconciliation)', () => {
  const base = { filing_id: 'f1', tx_date: '2024-01-01', tx_type: 'P' };
  assert.equal(
    tradeIdentityKey({ ...base, instrument: 'Nvda' }),
    tradeIdentityKey({ ...base, instrument: 'NVDA' }),
    'mixed-case instrument collapses to one identity',
  );
  assert.equal(tradeIdentityKey({ ...base, instrument: 'nvda' }), 'f1|2024-01-01|P|NVDA');
});

test('tradeIdentityKey keeps distinct trades distinct', () => {
  const k1 = tradeIdentityKey({ filing_id: 'f1', tx_date: '2024-01-01', tx_type: 'P', instrument: 'NVDA' });
  const k2 = tradeIdentityKey({ filing_id: 'f1', tx_date: '2024-01-01', tx_type: 'S', instrument: 'NVDA' });
  assert.notEqual(k1, k2, 'buy vs sell are different trades');
});

test('tradeIntensity is best-score / 100, capped at 1', () => {
  assert.equal(tradeIntensity(60), 0.6);
  assert.equal(tradeIntensity(85), 0.85);
  assert.equal(tradeIntensity(100), 1);
  assert.equal(tradeIntensity(105), 1, 'ticker-named bonus over 100 is capped');
});

test('spousalIntensity: base 0.5 + 0.3*proximity + 0.2*volume, capped at 1', () => {
  // tightest = 14 (loosest) -> proximity 0; n=1 -> volume 0.2 -> 0.5 + 0 + 0.04
  assert.ok(Math.abs(spousalIntensity(14, 1) - 0.54) < 1e-9);
  // tightest = 0 (same day) -> proximity 1; n=5 -> volume 1 -> 0.5 + 0.3 + 0.2 = 1
  assert.equal(spousalIntensity(0, 5), 1);
  // n over 5 stays capped, not >1
  assert.equal(spousalIntensity(0, 20), 1);
});
