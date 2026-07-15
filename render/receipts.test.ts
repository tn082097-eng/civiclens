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

test('ranked receipt shows the day-gap juxtaposition and p, with all three cite links', () => {
  const html = renderReceiptsSection({
    ...base, tradeCount: 40, band: 'ranked',
    receipts: [{ theme: 'tech', tradeFilingId: 'f', ticker: 'NVDA', txType: 'purchase', txDate: '2024-02-01',
      voteId: 'v', voteDate: '2024-02-03', billId: '118-hr-2', billTitle: 'Chips B', daysBeforeVote: 2,
      pPair: 0.01, tradeSourceUrl: 'https://example.com/TU', voteSourceUrl: 'https://example.com/VU',
      billSourceUrl: 'https://example.com/BU' }],
  });
  assert.match(html, /2 days later/i);
  assert.match(html, /p\s*=\s*0\.01/);
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
