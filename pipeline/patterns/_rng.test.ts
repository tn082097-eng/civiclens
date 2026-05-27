import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, seedFrom } from './_rng.js';

test('same seed yields identical sequence', () => {
  const a = mulberry32(123);
  const b = mulberry32(123);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test('different seeds diverge', () => {
  const a = mulberry32(1);
  const b = mulberry32(2);
  assert.notEqual(a(), b());
});

test('outputs are in [0,1)', () => {
  const r = mulberry32(99);
  for (let i = 0; i < 1000; i++) {
    const x = r();
    assert.ok(x >= 0 && x < 1);
  }
});

test('seedFrom is deterministic per string', () => {
  assert.equal(
    seedFrom('trade-vote-alignment|jayapal'),
    seedFrom('trade-vote-alignment|jayapal'),
  );
  assert.notEqual(seedFrom('a|b'), seedFrom('a|c'));
});
