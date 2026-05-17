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

const DDL = `
CREATE TABLE IF NOT EXISTS pattern_hits (
  pattern         TEXT NOT NULL,
  member          TEXT NOT NULL,
  finding         TEXT NOT NULL,
  intensity       DOUBLE NOT NULL,
  citing_json     TEXT NOT NULL,
  dates_json      TEXT NOT NULL,
  detected_at     TIMESTAMP NOT NULL,
  PRIMARY KEY (pattern, member, dates_json)
);
CREATE INDEX IF NOT EXISTS idx_pattern_hits_member  ON pattern_hits(member);
CREATE INDEX IF NOT EXISTS idx_pattern_hits_pattern ON pattern_hits(pattern);
`;

export async function migratePatternHits(): Promise<void> {
  const conn = await getDb();
  for (const stmt of DDL.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)) {
    await conn.run(stmt);
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
