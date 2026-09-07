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

test('ranked receipt shows the day-gap juxtaposition and a frequency band, with all three cite links', () => {
  const html = renderReceiptsSection({
    ...base, tradeCount: 40, band: 'ranked',
    receipts: [{ theme: 'tech', tradeFilingId: 'f', ticker: 'NVDA', txType: 'purchase', txDate: '2024-02-01',
      voteId: 'v', voteDate: '2024-02-03', billId: '118-hr-2', billTitle: 'Chips B', daysBeforeVote: 2,
      pPair: 0.01, tradeSourceUrl: 'https://example.com/TU', voteSourceUrl: 'https://example.com/VU',
      billSourceUrl: 'https://example.com/BU' }],
  });
  assert.match(html, /2 days later/i);
  assert.match(html, /shorter than 19 of 20 shuffles/i);
  assert.match(html, /rarity-rare/);
  assert.doesNotMatch(html, /p\s*=/i);
  for (const u of ['TU', 'VU', 'BU']) assert.ok(html.includes(`https://example.com/${u}`), `cite ${u} present`);
});

test('receipt card collapses non-http(s) source URLs to # (scheme allowlist)', () => {
  const html = renderReceiptsSection({
    ...base, tradeCount: 40, band: 'ranked',
    receipts: [{ theme: 'tech', tradeFilingId: 'f', ticker: 'NVDA', txType: 'purchase', txDate: '2024-02-01',
      voteId: 'v', voteDate: '2024-02-03', billId: '118-hr-2', billTitle: 'Chips B', daysBeforeVote: 2,
      pPair: 0.01, tradeSourceUrl: 'javascript:alert(1)', voteSourceUrl: 'data:text/html,x',
      billSourceUrl: 'https://www.congress.gov/bill/118/hr/2' }],
  });
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /data:text/);
  assert.match(html, /href="#"/);
  assert.ok(html.includes('https://www.congress.gov/bill/118/hr/2'), 'valid https cite kept');
});

function receipt(pPair: number | null, i: number): ThemeGapReceipts['receipts'][number] {
  return {
    theme: 'tech', tradeFilingId: `f-${i}`, ticker: `T${i}`, txType: 'purchase',
    txDate: '2024-02-01', voteId: `v-${i}`, voteDate: '2024-02-03',
    billId: `118-hr-${i}`, billTitle: `Bill ${i}`, daysBeforeVote: 2, pPair,
    tradeSourceUrl: 'https://example.com/trade', voteSourceUrl: 'https://example.com/vote',
    billSourceUrl: 'https://example.com/bill',
  };
}

test('ranked receipts summarize the full scored distribution against chance', () => {
  // None of 100 below 0.05; about five are expected under a uniform null.
  // A missing distribution or a tail-only card view makes this test fail.
  const receipts = Array.from({ length: 100 }, (_, i) => receipt(0.10 + (i % 80) / 100, i));
  const html = renderReceiptsSection({
    ...base, tradeCount: 100, disclosedTradeCount: 100, band: 'ranked', receipts,
  });
  assert.match(html, /100 scored pairs/i);
  assert.match(html, /about 5 .*expected by chance/i);
  assert.match(html, /Observed:\s*0/i);
  assert.match(html, /fewer than chance predicts/i);
  assert.match(html, /<svg/i);
});

test('receipt cards are capped at 20 and the truncation is disclosed', () => {
  const receipts = Array.from({ length: 25 }, (_, i) => receipt(i / 100, i));
  const html = renderReceiptsSection({
    ...base, tradeCount: 25, disclosedTradeCount: 25, band: 'ranked', receipts,
  });
  assert.equal((html.match(/<article class="receipt/g) ?? []).length, 20);
  assert.match(html, /Showing the 20 shortest-gap pairs of 25/i);
  assert.match(html, /full distribution is above/i);
});

test('ordinary and unscored receipts never print raw p-values', () => {
  const ordinary = renderReceiptsSection({
    ...base, tradeCount: 40, band: 'ranked', receipts: [receipt(0.42, 1)],
  });
  assert.match(ordinary, /rarity-ordinary/);
  assert.match(ordinary, /consistent with chance/i);
  assert.doesNotMatch(ordinary, /p\s*=/i);

  const unscored = renderReceiptsSection({
    ...base, tradeCount: 3, band: 'insufficient-data', receipts: [receipt(null, 2)],
  });
  assert.doesNotMatch(unscored, /rarity-(?:rare|ordinary)/);
  assert.doesNotMatch(unscored, /p\s*=/i);
});
