/**
 * Explicit one-shot migration for the pattern_hits table (Pattern Discovery v2).
 *
 * The table also lives in schema.sql (canonical, idempotent like every other
 * table). This script exists so the patterns pass can be brought up on an
 * existing DB without re-running the full schema, per the v2 spec's named
 * deliverable. Idempotent: safe to run repeatedly.
 *
 *   npx tsx db/migrate-pattern-hits.ts
 */

import { getDb } from './init.js';

// No enforced PRIMARY KEY — see the note in schema.sql. An enforced PK trips
// DuckDB's "Failed to delete all rows from index" bug on run-patterns re-runs.
const DDL = `
CREATE TABLE IF NOT EXISTS pattern_hits (
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
);
`;

// Rigor-pillar scoring columns. Added via ALTER ... IF NOT EXISTS so an
// existing DB gains them without a rebuild. All nullable (unscored = NULL).
const SCORING_COLS: [string, string][] = [
  ['null_model', 'TEXT'],
  ['observed', 'INTEGER'],
  ['expected', 'DOUBLE'],
  ['p_value', 'DOUBLE'],
  ['z_score', 'DOUBLE'],
  ['n_perm', 'INTEGER'],
];

export async function migratePatternHits(): Promise<void> {
  const conn = await getDb();
  // Drop any ART indexes (PK + secondary) on pattern_hits — in this DuckDB
  // version they all hit "Failed to delete all rows from index" on run-patterns
  // re-runs. See schema.sql. Safe if they don't exist.
  await conn.run('DROP INDEX IF EXISTS idx_pattern_hits_member');
  await conn.run('DROP INDEX IF EXISTS idx_pattern_hits_pattern');
  // Drop a legacy PK-bearing table in place (its unique ART index is the bug);
  // preserve existing rows. CREATE-IF-NOT-EXISTS alone can't alter an existing
  // table, so detect the PK and rebuild without it.
  const hasPk = (await (await conn.run(
    `SELECT COUNT(*) AS n FROM duckdb_constraints()
      WHERE table_name = 'pattern_hits' AND constraint_type = 'PRIMARY KEY'`,
  )).getRowObjects())[0] as { n: number | bigint };
  if (Number(hasPk.n) > 0) {
    await conn.run('BEGIN');
    try {
      await conn.run(`CREATE OR REPLACE TEMP TABLE _pattern_hits_bak AS SELECT * FROM pattern_hits`);
      await conn.run('DROP TABLE pattern_hits');
      for (const stmt of DDL.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)) {
        await conn.run(stmt);
      }
      // Explicit columns: the backup predates the scoring columns, so SELECT *
      // into the wider new table would mismatch arity.
      await conn.run(
        `INSERT INTO pattern_hits
           (pattern, member, finding, intensity, citing_json, dates_json, detected_at)
         SELECT pattern, member, finding, intensity, citing_json, dates_json, detected_at
           FROM _pattern_hits_bak`,
      );
      await conn.run('COMMIT');
    } catch (e) {
      await conn.run('ROLLBACK');
      throw e;
    }
    await addScoringCols(conn);
    return;
  }
  for (const stmt of DDL.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)) {
    await conn.run(stmt);
  }
  await addScoringCols(conn);
}

async function addScoringCols(conn: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  for (const [col, type] of SCORING_COLS) {
    await conn.run(`ALTER TABLE pattern_hits ADD COLUMN IF NOT EXISTS ${col} ${type}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migratePatternHits()
    .then(() => {
      console.log('pattern_hits table ready');
      process.exit(0);
    })
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
