/**
 * Orchestration contract for run-patterns: writeHits followed by inline scoring
 * for SCORED_PATTERNS with hits > 0. Guards the stats-wipeout re-run bug — a
 * DELETE-then-INSERT that drops the stat columns must be immediately followed by
 * a re-score so a run-patterns re-run can never strand previously-scored stats
 * as NULL.
 *
 * Uses its own temp DuckDB (never data/civiclens.duckdb, per spec gate 2) and a
 * stub scorer wired the same way runForMember wires the real scorePattern.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

import { writeAndScore } from './run-patterns.js';
import { SCORED_PATTERNS, type ScoreResult } from './score-anomaly.js';
import type { PatternHit } from './patterns/types.js';

const SCHEMA = `
CREATE TABLE pattern_hits (
  pattern         TEXT NOT NULL,
  member          TEXT NOT NULL,
  finding         TEXT NOT NULL,
  intensity       DOUBLE NOT NULL,
  citing_json     TEXT NOT NULL,
  dates_json      TEXT NOT NULL,
  detected_at     TIMESTAMP NOT NULL,
  null_model      TEXT,
  observed        INTEGER,
  expected        DOUBLE,
  p_value         DOUBLE,
  z_score         DOUBLE,
  n_perm          INTEGER
);`;

async function tempConn(): Promise<{ conn: DuckDBConnection; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'run-patterns-test-'));
  const instance = await DuckDBInstance.create(join(dir, 'test.duckdb'));
  const conn = await instance.connect();
  await conn.run(SCHEMA);
  return {
    conn,
    cleanup: () => {
      conn.closeSync();
      instance.closeSync();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function hit(pattern: string, member: string): PatternHit {
  return {
    pattern,
    member,
    finding: 'test finding',
    intensity: 0.9,
    citing: [],
    dates: [],
    detectedAt: '2026-07-20T00:00:00.000Z',
  };
}

async function statsRow(conn: DuckDBConnection, pattern: string, member: string) {
  const res = await conn.run(
    `SELECT null_model, observed, expected, p_value, z_score, n_perm
       FROM pattern_hits WHERE pattern=? AND member=?`,
    [pattern, member],
  );
  const rows = (await res.getRowObjects()) as unknown as Record<string, unknown>[];
  return rows[0];
}

/**
 * Stub scorer mirroring the real scorePattern's contract: it persists the stat
 * columns via UPDATE (the real scorer owns the write), returns the result, and
 * records that it ran.
 */
function stubScorer(
  conn: DuckDBConnection,
  calls: string[],
): (pattern: string, member: string) => Promise<ScoreResult | null> {
  return async (pattern, member) => {
    calls.push(`${pattern}|${member}`);
    const result: ScoreResult = {
      nullModel: 'calendar',
      observed: 3,
      expected: 1.5,
      pValue: 0.42,
      zScore: 1.1,
      nPerm: 10,
    };
    await conn.run(
      `UPDATE pattern_hits
          SET null_model=?, observed=?, expected=?, p_value=?, z_score=?, n_perm=?
        WHERE pattern=? AND member=?`,
      [result.nullModel, result.observed, result.expected, result.pValue, result.zScore, result.nPerm, pattern, member],
    );
    return result;
  };
}

const SCORED = SCORED_PATTERNS[0]; // 'trade-vote-alignment'

test('scored pattern with hits: writeHits then re-score leaves stats non-NULL (wipeout regression)', async () => {
  const { conn, cleanup } = await tempConn();
  try {
    const calls: string[] = [];
    const scorer = (p: string, m: string) => stubScorer(conn, calls)(p, m);

    // Prior run already scored this (pattern, member).
    await writeAndScore(SCORED, 'test-member', [hit(SCORED, 'test-member')], { conn, scorer });
    let row = await statsRow(conn, SCORED, 'test-member');
    assert.notEqual(row.p_value, null, 'first write should be scored');

    // Re-run: DELETE-then-INSERT drops stats, then re-score must repopulate.
    await writeAndScore(SCORED, 'test-member', [hit(SCORED, 'test-member')], { conn, scorer });
    row = await statsRow(conn, SCORED, 'test-member');

    assert.notEqual(row.null_model, null, 'null_model repopulated after re-run');
    assert.notEqual(row.observed, null, 'observed repopulated after re-run');
    assert.notEqual(row.p_value, null, 'p_value repopulated after re-run');
    assert.notEqual(row.z_score, null, 'z_score repopulated after re-run');
    assert.notEqual(row.n_perm, null, 'n_perm repopulated after re-run');
    assert.equal(calls.length, 2, 'scorer invoked on both runs');
  } finally {
    cleanup();
  }
});

test('non-scored pattern: writeHits only, scorer never invoked, stats stay NULL', async () => {
  const { conn, cleanup } = await tempConn();
  try {
    const calls: string[] = [];
    const scorer = (p: string, m: string) => stubScorer(conn, calls)(p, m);
    const pattern = 'donor-sector-vote-alignment'; // not in SCORED_PATTERNS

    await writeAndScore(pattern, 'test-member', [hit(pattern, 'test-member')], { conn, scorer });

    const row = await statsRow(conn, pattern, 'test-member');
    assert.equal(row.p_value, null, 'unscored pattern leaves p_value NULL');
    assert.equal(row.null_model, null, 'unscored pattern leaves null_model NULL');
    assert.equal(calls.length, 0, 'scorer not invoked for unscored pattern');
  } finally {
    cleanup();
  }
});

test('scored pattern with ZERO hits: writeHits clears rows, scorer not invoked', async () => {
  const { conn, cleanup } = await tempConn();
  try {
    const calls: string[] = [];
    const scorer = (p: string, m: string) => stubScorer(conn, calls)(p, m);

    await writeAndScore(SCORED, 'test-member', [], { conn, scorer });

    const res = await conn.run('SELECT count(*)::int AS n FROM pattern_hits', []);
    const rows = (await res.getRowObjects()) as unknown as { n: number }[];
    assert.equal(rows[0].n, 0, 'no rows written for zero hits');
    assert.equal(calls.length, 0, 'scorer not invoked when there are no hits');
  } finally {
    cleanup();
  }
});
