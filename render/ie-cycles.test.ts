import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderIeCycles, ieCycleLabel } from './ie-cycles.js';

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
