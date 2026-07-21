/**
 * In-path enforcement test (ADR 0003) with a COMPUTATION SENTINEL.
 *
 * Runs the REAL confirmatory baseline CLIs as subprocesses against the REAL
 * registry (where recipient-trade / district-contracts are consumed-fail). The
 * in-path guard [assertConfirmatoryAllowed] fires at the TOP of main(), before
 * getDb() and before any substrate/permutation work.
 *
 * Sentinel: each baseline's computation, once it opens the DB, prints
 * recognizable progress lines ("roster:", "substrate", "observed", "null (").
 * A blocked run must (a) exit non-zero and (b) emit NONE of those lines — the
 * absence of any computation-progress marker proves no outcome-bearing
 * computation ran. (The DB path is hardcoded in lib/paths.ts, so a canary-file
 * approach would false-pass; output-absence is the honest tripwire and also
 * confirms the guard aborts before the real DB is touched.)
 *
 * These spawn tsx subprocesses (a few seconds each); no network. Because the
 * guard aborts first, the real data/civiclens.duckdb is never opened.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '../../..');

// Lines that only appear AFTER the DB is opened and computation begins.
const COMPUTATION_MARKERS = /roster:|substrate|observed|null \(|expected |negative control —/i;

function runBaseline(relScript: string, args: string[]) {
  const res = spawnSync('npx', ['tsx', relScript, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: res.status, output: `${res.stdout ?? ''}\n${res.stderr ?? ''}` };
}

test('recipient-trade baseline: consumed detector BLOCKED, no computation runs', () => {
  const { code, output } = runBaseline('pipeline/patterns/recipient-trade-baseline.ts', ['50']);
  assert.notEqual(code, 0, `must exit non-zero (got ${code}); output:\n${output}`);
  assert.match(output, /BLOCKED|consumed/i, 'must report the guard block');
  assert.doesNotMatch(output, COMPUTATION_MARKERS,
    'no computation-progress marker may appear — the guard must abort before any computation');
});

test('district-contract baseline: consumed detector BLOCKED, no computation runs', () => {
  const { code, output } = runBaseline('pipeline/patterns/district-contract-baseline.ts', ['50']);
  assert.notEqual(code, 0, `must exit non-zero (got ${code}); output:\n${output}`);
  assert.match(output, /BLOCKED|consumed/i, 'must report the guard block');
  assert.doesNotMatch(output, COMPUTATION_MARKERS,
    'no computation-progress marker may appear — the guard must abort before any computation');
});
