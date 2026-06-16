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
  const g = minGapsByTrade(
    [T('t1', '2024-01-01', 'tech')],
    [V('v1', '2024-01-20', 'tech'), V('v2', '2024-01-05', 'tech')],
    90,
  );
  assert.equal(g.get('t1'), 4);
});
