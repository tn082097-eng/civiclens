/**
 * Tests for the confirmatory-run guard core (ADR 0003) — the REAL exported
 * functions in pipeline/patterns/_confirmatory-guard.ts (no re-implementation).
 * Pure string/logic; no DB, no filesystem for the parse/verdict tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRegistry,
  checkDetectors,
  assertConfirmatoryAllowed,
  ConfirmatoryGuardError,
} from '../pipeline/patterns/_confirmatory-guard.js';

const FIXTURE = `
# header prose, not a table
| detector_id | spec | status | run_commit | outcome | invalidation |
|---|---|---|---|---|---|
| recipient-trade | docs/x.md | consumed-fail | a47ca81 | GATE FAIL | |
| trade-vote-alignment | docs/y.md | registered | | awaiting | |
| repaired-one | docs/z.md | consumed-fail | deadbee | defect | docs/z.md#amendment-1 |
| invalidated-empty | docs/w.md | invalidated | | | |
| invalidated-documented | docs/v.md | invalidated | | | docs/v.md#amendment-1 |
`;

test('parseRegistry: extracts data rows, skips header/separator/prose', () => {
  const rows = parseRegistry(FIXTURE);
  assert.equal(rows.length, 5, 'five data rows, no header/sep/prose');
  assert.deepEqual(rows.map(r => r.detector_id), [
    'recipient-trade', 'trade-vote-alignment', 'repaired-one',
    'invalidated-empty', 'invalidated-documented',
  ]);
});

test('checkDetectors: consumed + not invalidated => blocked (stop-consumed)', () => {
  const [r] = checkDetectors(['recipient-trade'], parseRegistry(FIXTURE));
  assert.equal(r.status, 'stop-consumed');
  assert.equal(r.blocked, true);
});

test('checkDetectors: registered + not consumed => ok (ok-registered)', () => {
  const [r] = checkDetectors(['trade-vote-alignment'], parseRegistry(FIXTURE));
  assert.equal(r.status, 'ok-registered');
  assert.equal(r.blocked, false);
});

test('checkDetectors: consumed but documented-invalidation link => ok (replacement permitted through supported workflow)', () => {
  // A documented invalidation permits a replacement run; exactly-one execution
  // is a policy requirement, not mechanically enforced until Phase 2.
  const [r] = checkDetectors(['repaired-one'], parseRegistry(FIXTURE));
  assert.equal(r.status, 'ok-invalidated');
  assert.equal(r.blocked, false);
});

test('checkDetectors: status=invalidated with EMPTY link => BLOCKED (fails closed, ADR 0003 §4)', () => {
  // An unevidenced invalidation must NOT clear — invalidation must be documented
  // before any replacement run. This is the corrected Phase 1 rule.
  const [r] = checkDetectors(['invalidated-empty'], parseRegistry(FIXTURE));
  assert.equal(r.status, 'stop-consumed');
  assert.equal(r.blocked, true);
});

test('checkDetectors: status=invalidated WITH documented link => ok (replacement permitted through supported workflow)', () => {
  const [r] = checkDetectors(['invalidated-documented'], parseRegistry(FIXTURE));
  assert.equal(r.status, 'ok-invalidated');
  assert.equal(r.blocked, false);
});

test('checkDetectors: unknown detector id fails closed => blocked (stop-unknown)', () => {
  const [r] = checkDetectors(['made-up'], parseRegistry(FIXTURE));
  assert.equal(r.status, 'stop-unknown');
  assert.equal(r.blocked, true);
});

// --- assertConfirmatoryAllowed: the in-path enforcement used by runners ---

import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixtureRegistry(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-guard-'));
  const p = join(dir, 'confirmatory-runs.md');
  writeFileSync(p, FIXTURE, 'utf8');
  return p;
}

test('assertConfirmatoryAllowed: throws ConfirmatoryGuardError on a consumed detector', () => {
  const registryPath = fixtureRegistry();
  assert.throws(
    () => assertConfirmatoryAllowed(['recipient-trade'], { registryPath }),
    (e: unknown) => e instanceof ConfirmatoryGuardError && /BLOCKED/.test((e as Error).message),
  );
});

test('assertConfirmatoryAllowed: returns results (no throw) on a clear detector', () => {
  const registryPath = fixtureRegistry();
  const results = assertConfirmatoryAllowed(['trade-vote-alignment'], { registryPath });
  assert.equal(results.length, 1);
  assert.equal(results[0].blocked, false);
});

test('assertConfirmatoryAllowed: mixed set with one consumed => throws (fails the whole batch)', () => {
  const registryPath = fixtureRegistry();
  assert.throws(
    () => assertConfirmatoryAllowed(['trade-vote-alignment', 'recipient-trade'], { registryPath }),
    ConfirmatoryGuardError,
  );
});
