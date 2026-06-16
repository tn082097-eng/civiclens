import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minGapsByTrade, type ThemeTrade, type ThemeVote } from './_gap.js';

const T = (id: string, txDate: string, theme: string): ThemeTrade => ({ id, txDate, theme });
const V = (id: string, voteDate: string, theme: string): ThemeVote => ({ id, voteDate, theme });

test('same-theme vote inside the window yields the day gap', () => {
  const g = minGapsByTrade([T('t1', '2024-01-01', 'tech')], [V('v1', '2024-01-10', 'tech')], 90);
  assert.equal(g.get('t1'), 9);
});

test('vote BEFORE the trade does not count (one-directional)', () => {
  const g = minGapsByTrade([T('t1', '2024-01-10', 'tech')], [V('v1', '2024-01-01', 'tech')], 90);
  assert.equal(g.get('t1'), undefined);
});

test('vote outside the window does not count', () => {
  const g = minGapsByTrade([T('t1', '2024-01-01', 'tech')], [V('v1', '2024-05-01', 'tech')], 90);
  assert.equal(g.get('t1'), undefined);
});

test('different theme does not count', () => {
  const g = minGapsByTrade([T('t1', '2024-01-01', 'tech')], [V('v1', '2024-01-05', 'energy')], 90);
  assert.equal(g.get('t1'), undefined);
});

test('nearest same-theme vote wins when several are in range', () => {
  // v2 (2024-01-05, gap=4) is inserted second but is closer; the test proves
  // buildThemeVoteIndex's sort is honoured so the nearer vote wins.
  const g = minGapsByTrade(
    [T('t1', '2024-01-01', 'tech')],
    [V('v1', '2024-01-20', 'tech'), V('v2', '2024-01-05', 'tech')],
    90,
  );
  assert.equal(g.get('t1'), 4);
});

test('vote exactly windowDays after trade IS counted (inclusive boundary)', () => {
  // 2024-03-31 is exactly 90 days after 2024-01-01 (Jan:31 + Feb:29 + Mar:30 = 90).
  // gap <= windowDays is inclusive, so gap=90 must be returned.
  const g = minGapsByTrade([T('t1', '2024-01-01', 'tech')], [V('v1', '2024-03-31', 'tech')], 90);
  assert.equal(g.get('t1'), 90);
});

test('vote windowDays+1 after trade is NOT counted (one past boundary)', () => {
  // 2024-04-01 is 91 days after 2024-01-01 — one past the 90-day window.
  const g = minGapsByTrade([T('t1', '2024-01-01', 'tech')], [V('v1', '2024-04-01', 'tech')], 90);
  assert.equal(g.get('t1'), undefined);
});
