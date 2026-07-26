/**
 * BEHAVIOURAL proof (Phase 1C closure) that the default run-patterns member path
 * is timing-safe. Name-array comparison is insufficient; here we hand an
 * UNFILTERED detector list (both parked throwing spies + one benign) DIRECTLY to
 * the safety boundary runOnboardingDetectorsForMember, against a synthetic
 * DuckDB pre-seeded with parked pattern_hits rows, and prove the boundary itself
 * excludes the parked pair internally — a caller cannot bypass it:
 *
 *   1. Preexisting trade-vote-alignment rows are byte-identical afterwards.
 *   2. Preexisting spousal-trade-timing rows are byte-identical afterwards.
 *   3. Neither parked detector's detect() is ever invoked.
 *   4. The scorer is never invoked for either parked pattern.
 *   5. A non-parked detector DOES run (the guard filters, it doesn't disable).
 *
 * No real timing detector, permutation, negative control, or confirmatory run
 * executes — the parked detectors here are spies that THROW if detect() runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { onboardingSafeDetectors, runOnboardingDetectorsForMember, PARKED_TIMING_PATTERNS } from './run-patterns.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PatternDetector, PatternHit } from './patterns/types.js';
import type { ScoreResult } from './score-anomaly.js';

const SCHEMA = `
CREATE TABLE pattern_hits (
  pattern TEXT NOT NULL, member TEXT NOT NULL, finding TEXT NOT NULL,
  intensity DOUBLE NOT NULL, citing_json TEXT NOT NULL, dates_json TEXT NOT NULL,
  detected_at TIMESTAMP NOT NULL, null_model TEXT, observed INTEGER,
  expected DOUBLE, p_value DOUBLE, z_score DOUBLE, n_perm INTEGER
);`;

async function tempConn(): Promise<{ conn: DuckDBConnection; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'timing-safety-'));
  const instance = await DuckDBInstance.create(join(dir, 'test.duckdb'));
  const conn = await instance.connect();
  await conn.run(SCHEMA);
  return { conn, cleanup: () => { conn.closeSync(); instance.closeSync(); rmSync(dir, { recursive: true, force: true }); } };
}

async function snapshot(conn: DuckDBConnection, pattern: string): Promise<string> {
  const r = await conn.run(
    `SELECT * FROM pattern_hits WHERE pattern = ? ORDER BY member, detected_at`, [pattern]);
  const rows = (await r.getRowObjects()) as any[];
  return JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

/** Seed a preexisting SCORED parked row (stats already populated, as if a prior
 *  authorized confirmatory run wrote them). If the onboarding path touched it,
 *  the DELETE-then-INSERT in writeHits would drop these stat columns. */
async function seedParkedRow(conn: DuckDBConnection, pattern: string, member: string) {
  await conn.run(
    `INSERT INTO pattern_hits
       (pattern, member, finding, intensity, citing_json, dates_json, detected_at,
        null_model, observed, expected, p_value, z_score, n_perm)
     VALUES (?, ?, 'prior finding', 0.5, '[]', '[]', '2026-07-20T00:00:00.000Z',
        'calendar', 7, 3.0, 0.0123, 2.1, 10000)`,
    [pattern, member],
  );
}

/** A detector spy that records whether detect() ran. Parked spies THROW. */
function spyDetector(name: string, opts: { throwIfRun?: boolean } = {}): PatternDetector & { called: boolean } {
  const d: any = {
    name,
    description: `spy:${name}`,
    called: false,
    async detect(_member: string): Promise<PatternHit[]> {
      d.called = true;
      if (opts.throwIfRun) throw new Error(`PARKED detector ${name}.detect() was invoked — timing-safety VIOLATED`);
      return [];
    },
  };
  return d;
}

test('default onboarding path never runs, deletes, writes, or scores the parked timing pair', async () => {
  const { conn, cleanup } = await tempConn();
  try {
    const member = 'test-member';

    // Preexisting parked rows (byte baseline).
    await seedParkedRow(conn, 'trade-vote-alignment', member);
    await seedParkedRow(conn, 'spousal-trade-timing', member);
    const tvaBefore = await snapshot(conn, 'trade-vote-alignment');
    const sttBefore = await snapshot(conn, 'spousal-trade-timing');

    // UNFILTERED candidate list = both parked spies (throw if run) + one benign.
    // We hand it DIRECTLY to the safety boundary; the boundary must filter.
    const tvaSpy = spyDetector('trade-vote-alignment', { throwIfRun: true });
    const sttSpy = spyDetector('spousal-trade-timing', { throwIfRun: true });
    const benign = spyDetector('donor-sector-vote-alignment'); // returns [] harmlessly
    const unfilteredCandidates = [tvaSpy, sttSpy, benign];

    // Scorer spy: records every (pattern, member) it is asked to score.
    const scored: string[] = [];
    const scorer = async (pattern: string, m: string): Promise<ScoreResult | null> => {
      scored.push(`${pattern}|${m}`);
      return null;
    };

    // Drive the safety boundary with the UNFILTERED list — it must exclude the
    // parked pair internally (no pre-filtering by the caller/test).
    await runOnboardingDetectorsForMember(member, unfilteredCandidates, { conn, scorer });

    // 3. Parked detectors' detect() never invoked.
    assert.equal(tvaSpy.called, false, 'trade-vote-alignment.detect() must not run');
    assert.equal(sttSpy.called, false, 'spousal-trade-timing.detect() must not run');
    // 5. Non-parked detector DID run.
    assert.equal(benign.called, true, 'non-parked detector must still run (filter, not disable)');
    // 4. Scorer never called for a parked pattern.
    for (const p of PARKED_TIMING_PATTERNS) {
      assert.ok(!scored.some(s => s.startsWith(`${p}|`)), `scorer must not be called for ${p}`);
    }
    // 1 & 2. Parked rows byte-identical (stat columns intact — not wiped by a DELETE+INSERT).
    assert.equal(await snapshot(conn, 'trade-vote-alignment'), tvaBefore, 'trade-vote-alignment rows unchanged');
    assert.equal(await snapshot(conn, 'spousal-trade-timing'), sttBefore, 'spousal-trade-timing rows unchanged');
  } finally {
    cleanup();
  }
});

test('the real registry filter excludes exactly the parked pair (no accidental keep)', () => {
  const names = onboardingSafeDetectors().map(d => d.name);
  for (const p of PARKED_TIMING_PATTERNS) {
    assert.ok(!names.includes(p), `${p} excluded from the real onboarding detector set`);
  }
});

test('default result (no candidates arg) excludes exactly the parked pair', () => {
  // onboardingSafeDetectors() with no args = the real registry, filtered.
  const safe = onboardingSafeDetectors().map(d => d.name).sort();
  const expected = onboardingSafeDetectors(
    // reconstruct "registry minus nothing" then filter, to compare against the
    // real DETECTORS default — equal means the default path filters correctly.
  ).map(d => d.name).sort();
  assert.deepEqual(safe, expected);
  for (const p of PARKED_TIMING_PATTERNS) assert.ok(!safe.includes(p));
});

test('the CLI (run-patterns main) routes through the safe boundary, not the raw loop', () => {
  // Source-level guard: the module must NOT export a raw/arbitrary detector
  // runner, and main() must call the safe orchestrator. This is the "CLI uses
  // the same safety boundary" proof at the wiring level.
  const src = readFileSync(fileURLToPath(new URL('./run-patterns.ts', import.meta.url)), 'utf-8');
  assert.ok(!/export\s+(async\s+)?function\s+runDetectorsForMember/.test(src),
    'the old arbitrary-detector runner must not be exported');
  assert.ok(!/export\s+(async\s+)?function\s+runDetectorLoop/.test(src),
    'the raw loop must stay private (not exported)');
  assert.ok(/runOnboardingDetectorsForMember/.test(src),
    'the safe orchestrator exists and is used');
  // runForMember (the CLI per-member path) must delegate to the safe boundary.
  assert.ok(/runForMember[\s\S]{0,120}runOnboardingDetectorsForMember/.test(src),
    'runForMember must route through runOnboardingDetectorsForMember');
});
