import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderIeCycles, ieCycleLabel, ieFetchOutcome, ieUnavailableNote } from './ie-cycles.js';

// Regression: the render used to pick MAX(cycle) and show only that cycle.
// FEC opens a new cycle with minimum-threshold Schedule E rows ($2–$10), so the
// trivial in-progress cycle structurally outranked the real one — e.g. Frankel
// rendered "$10 / 2026" while $106,500 of 2024 opposition was hidden.
// 15 members were affected. Every cycle with data must now render.

test('orderIeCycles returns every cycle, newest first', () => {
  assert.deepEqual(orderIeCycles([{ cycle: 2024 }, { cycle: 2026 }]), [2026, 2024]);
  assert.deepEqual(orderIeCycles([{ cycle: 2026 }, { cycle: 2024 }]), [2026, 2024]);
});

test('orderIeCycles keeps a lone cycle and dedupes', () => {
  assert.deepEqual(orderIeCycles([{ cycle: 2024 }]), [2024]);
  assert.deepEqual(orderIeCycles([{ cycle: 2024 }, { cycle: 2024 }]), [2024]);
});

test('orderIeCycles on no rows yields no cycles', () => {
  assert.deepEqual(orderIeCycles([]), []);
});

// The ordering is by cycle, NOT by spend: sorting by dollars is not a total
// order (ties at $10 are plausible) and would re-introduce a ranking heuristic.
test('orderIeCycles ignores magnitude — dan-crenshaw case', () => {
  // Crenshaw's 2026 ($1.48M) legitimately dominates his 2024 ($1,380); his page
  // was already correct and must not regress. Descending cycle puts 2026 first
  // regardless, so both the dominant and the trivial cases render the same way.
  assert.deepEqual(orderIeCycles([{ cycle: 2024 }, { cycle: 2026 }]), [2026, 2024]);
});

test('ieCycleLabel marks the in-progress cycle', () => {
  assert.equal(ieCycleLabel(2026, 2026), '2026 cycle (in progress)');
  assert.equal(ieCycleLabel(2024, 2026), '2024 cycle');
});

// --- Failed-cycle disclosure -------------------------------------------------
// The per-cycle fetch loop drops a cycle whose FEC fetch throws, logging only a
// console.warn. The DB says the cycle HAS independent-expenditure rows, so a page
// that silently omits it asserts something the data contradicts — the same visible
// failure as the MAX(cycle) bug above (real money missing from the page), by a
// different cause. These helpers make the omission explicit instead.

test('ieFetchOutcome: every requested cycle rendered → complete', () => {
  assert.deepEqual(
    ieFetchOutcome([2026, 2024], [2026, 2024]),
    { kind: 'complete', failed: [] },
  );
});

test('ieFetchOutcome: some cycles failed → partial, names the missing ones', () => {
  assert.deepEqual(
    ieFetchOutcome([2026, 2024], [2026]),
    { kind: 'partial', failed: [2024] },
  );
});

// The Frankel shape: the cycle holding the real money is the one that failed.
test('ieFetchOutcome: failure of the money cycle is reported, not hidden', () => {
  const o = ieFetchOutcome([2026, 2024], [2026]);
  assert.equal(o.kind, 'partial');
  assert.deepEqual(o.failed, [2024]);
});

test('ieFetchOutcome: all cycles failed → total, distinct from genuinely-empty', () => {
  assert.deepEqual(
    ieFetchOutcome([2026, 2024], []),
    { kind: 'total', failed: [2026, 2024] },
  );
});

// A member with no IE rows at all requests the current cycle and gets nothing
// back. That is a true "no spending on record", NOT a fetch failure.
test('ieFetchOutcome: nothing requested → complete, never a false failure', () => {
  assert.deepEqual(ieFetchOutcome([], []), { kind: 'complete', failed: [] });
});

test('ieFetchOutcome: failed list is newest-first regardless of arg order', () => {
  assert.deepEqual(ieFetchOutcome([2024, 2026], []).failed, [2026, 2024]);
});

test('ieUnavailableNote names each failed cycle', () => {
  assert.match(ieUnavailableNote([2024]), /2024/);
  const two = ieUnavailableNote([2026, 2024]);
  assert.match(two, /2026/);
  assert.match(two, /2024/);
});

// The note is the user-visible disclosure; it must not read as "no spending".
test('ieUnavailableNote says unavailable, never claims absence of spending', () => {
  const note = ieUnavailableNote([2024]);
  assert.match(note, /could not be retrieved|unavailable/i);
  assert.doesNotMatch(note, /no independent.expenditure/i);
});

test('ieUnavailableNote on no failures is empty', () => {
  assert.equal(ieUnavailableNote([]), '');
});
