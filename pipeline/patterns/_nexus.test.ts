import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countNexus,
  buildNexusIndex,
  countNexusIndexed,
  type Trade,
  type NexusVote,
} from './_nexus.js';

const V = (id: string, date: string, committee: boolean, tickers: string[]): NexusVote =>
  ({ id, voteDate: date, committee, namedTickers: tickers });
const T = (id: string, date: string, ticker: string): Trade => ({ id, txDate: date, ticker });

test('committee vote within window counts the trade', () => {
  const trades = [T('t1', '2024-01-01', 'NVDA')];
  const votes = [V('v1', '2024-01-10', true, [])];
  assert.equal(countNexus(trades, votes, 14), 1);
});

test('ticker-named bill within window counts the trade', () => {
  const trades = [T('t1', '2024-01-01', 'NVDA')];
  const votes = [V('v1', '2024-01-05', false, ['NVDA'])];
  assert.equal(countNexus(trades, votes, 14), 1);
});

test('day-14 is inside, day-15 is outside', () => {
  const trades = [T('t1', '2024-01-01', 'NVDA')];
  assert.equal(countNexus(trades, [V('v1', '2024-01-15', true, [])], 14), 1);
  assert.equal(countNexus(trades, [V('v2', '2024-01-16', true, [])], 14), 0);
});

test('same-day (0 days) counts', () => {
  assert.equal(countNexus([T('t1', '2024-01-01', 'NVDA')], [V('v1', '2024-01-01', true, [])], 14), 1);
});

test('trade AFTER the vote does not count (negative offset)', () => {
  assert.equal(countNexus([T('t1', '2024-01-20', 'NVDA')], [V('v1', '2024-01-10', true, [])], 14), 0);
});

test('broad-market ETF ticker never counts', () => {
  assert.equal(countNexus([T('t1', '2024-01-01', 'SPY')], [V('v1', '2024-01-05', true, [])], 14), 0);
});

test('ticker path requires the trade ticker to be named, committee=false', () => {
  const trades = [T('t1', '2024-01-01', 'NVDA')];
  assert.equal(countNexus(trades, [V('v1', '2024-01-05', false, ['AAPL'])], 14), 0);
});

test('one trade matching many votes is counted once', () => {
  const trades = [T('t1', '2024-01-01', 'NVDA')];
  const votes = [
    V('v1', '2024-01-03', true, []),
    V('v2', '2024-01-05', true, []),
    V('v3', '2024-01-07', false, ['NVDA']),
  ];
  assert.equal(countNexus(trades, votes, 14), 1);
});

test('counts distinct qualifying trades', () => {
  const trades = [
    T('t1', '2024-01-01', 'NVDA'),
    T('t2', '2024-02-01', 'AAPL'),
    T('t3', '2024-03-01', 'TSLA'),
  ];
  const votes = [V('v1', '2024-01-05', true, []), V('v2', '2024-02-03', false, ['AAPL'])];
  assert.equal(countNexus(trades, votes, 14), 2);
});

// --- indexed (fast-path) helpers ---

const toMs = (d: string) => Date.parse(d);
const idxTrade = (ticker: string, date: string) => ({ ticker, txMs: toMs(date) });

test('countNexusIndexed matches countNexus on the same inputs', () => {
  const trades = [
    T('t1', '2024-01-01', 'NVDA'),
    T('t2', '2024-02-01', 'AAPL'),
    T('t3', '2024-03-01', 'TSLA'),
    T('t4', '2024-01-01', 'SPY'), // ETF, must be excluded by both
  ];
  const votes = [
    V('v1', '2024-01-05', true, []),
    V('v2', '2024-02-03', false, ['AAPL']),
    V('v3', '2024-03-20', false, ['MSFT']),
  ];
  const naive = countNexus(trades, votes, 14);
  const index = buildNexusIndex(votes);
  const fast = countNexusIndexed(trades.map(t => idxTrade(t.ticker, t.txDate)), index, 14);
  assert.equal(fast, naive);
});

test('indexed path: day-14 inside, day-15 outside', () => {
  const index = buildNexusIndex([
    V('v1', '2024-01-15', true, []),
    V('v2', '2024-01-16', true, []),
  ]);
  assert.equal(countNexusIndexed([idxTrade('NVDA', '2024-01-01')], buildNexusIndex([V('v1', '2024-01-15', true, [])]), 14), 1);
  assert.equal(countNexusIndexed([idxTrade('NVDA', '2024-01-01')], buildNexusIndex([V('v2', '2024-01-16', true, [])]), 14), 0);
  // committee in range still hits when both present
  assert.equal(countNexusIndexed([idxTrade('NVDA', '2024-01-01')], index, 14), 1);
});

test('indexed path: ETF excluded, ticker path respected', () => {
  const index = buildNexusIndex([V('v1', '2024-01-05', false, ['AAPL'])]);
  assert.equal(countNexusIndexed([idxTrade('SPY', '2024-01-01')], index, 14), 0);
  assert.equal(countNexusIndexed([idxTrade('AAPL', '2024-01-01')], index, 14), 1);
  assert.equal(countNexusIndexed([idxTrade('NVDA', '2024-01-01')], index, 14), 0);
});
