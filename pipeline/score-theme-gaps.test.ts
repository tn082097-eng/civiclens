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
