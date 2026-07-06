import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadThemeGapsOrSentinel } from './load-artifacts.js';

test('missing artifact returns a valid empty sentinel', () => {
  const a = loadThemeGapsOrSentinel('definitely-no-such-member-xyz');
  assert.equal(a.memberId, 'definitely-no-such-member-xyz');
  assert.equal(a.receipts.length, 0);
  assert.equal(a.band, 'insufficient-data');
  assert.equal(a.coverage.votesTotal, 0);
  assert.equal(a.tradeCount, 0);
});
