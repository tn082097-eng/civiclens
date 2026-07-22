/**
 * Pattern Discovery v2 — detection pass.
 *
 * Runs AFTER the agent pipeline (not an agent). Reads DuckDB, runs each
 * registered detector for one member or the whole roster, and upserts results
 * into pattern_hits. Site rebuild reads from there.
 *
 *   npx tsx pipeline/run-patterns.ts --member marjorie-taylor-greene
 *   npx tsx pipeline/run-patterns.ts --all
 *
 * Re-running is idempotent per (detector, member): a detector's prior hits for
 * that member are cleared before its fresh hits are written, so tuning a
 * threshold and re-running just replaces that detector's rows.
 */

import type { DuckDBConnection } from '@duckdb/node-api';
import { getDb } from '../db/init.js';
import { listMembers } from '../db/queries.js';
import { DETECTORS } from './patterns/registry.js';
import type { PatternHit } from './patterns/types.js';
import { SCORED_PATTERNS, scorePattern, type ScoreResult } from './score-anomaly.js';
import { warnIfUnconsumed } from './patterns/_confirmatory-guard.js';

/** Signature of the inline scorer (real one is scorePattern; tests inject a stub). */
type Scorer = (pattern: string, member: string) => Promise<ScoreResult | null>;

async function writeHits(
  pattern: string,
  member: string,
  hits: PatternHit[],
  conn: DuckDBConnection,
): Promise<void> {
  // Clear this detector's prior hits for this member, then insert fresh.
  // This DELETE-then-INSERT is the idempotency mechanism (pattern_hits has no
  // PK by design — DuckDB index-delete bug, db/schema.sql). It drops the stat
  // columns, so writeAndScore re-scores immediately for SCORED_PATTERNS to
  // avoid stranding previously-scored stats as NULL on a re-run.
  await conn.run('DELETE FROM pattern_hits WHERE pattern = ? AND member = ?', [
    pattern,
    member,
  ]);
  for (const h of hits) {
    await conn.run(
      `INSERT INTO pattern_hits
         (pattern, member, finding, intensity, citing_json, dates_json, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        h.pattern,
        h.member,
        h.finding,
        h.intensity,
        JSON.stringify(h.citing),
        JSON.stringify(h.dates),
        h.detectedAt,
      ],
    );
  }
}

/**
 * Orchestration contract: write a detector's hits, then — for a SCORED_PATTERNS
 * detector with at least one hit — re-score inline so the freshly re-inserted
 * rows carry their stat columns. Because writeHits DELETE-then-INSERTs without
 * stats, skipping this step would silently NULL previously-scored stats on a
 * re-run (the wipeout bug). Returns the scorer's result (for the log line) or
 * null when no scoring applies.
 *
 * A scorer failure propagates — it is never swallowed into "0 hits".
 */
export async function writeAndScore(
  pattern: string,
  member: string,
  hits: PatternHit[],
  deps: { conn?: DuckDBConnection; scorer?: Scorer } = {},
): Promise<ScoreResult | null> {
  const conn = deps.conn ?? (await getDb());
  const scorer = deps.scorer ?? scorePattern;
  await writeHits(pattern, member, hits, conn);
  if (
    hits.length > 0 &&
    (SCORED_PATTERNS as readonly string[]).includes(pattern)
  ) {
    return scorer(pattern, member);
  }
  return null;
}

async function runForMember(member: string): Promise<number> {
  let total = 0;
  for (const det of DETECTORS) {
    let hits: PatternHit[];
    try {
      hits = await det.detect(member);
    } catch (e) {
      // A detector failing must not silently produce zero — surface loudly.
      console.error(`  ✗ ${det.name} threw for ${member}:`, (e as Error).message);
      throw e;
    }
    const score = await writeAndScore(det.name, member, hits);
    total += hits.length;
    const summary = hits.length
      ? hits.map(h => `${h.intensity.toFixed(2)}`).join(',')
      : '—';
    const scoreNote = score
      ? ` p=${score.pValue.toFixed(4)} z=${score.zScore.toFixed(2)} [${score.nullModel}]`
      : '';
    console.log(`  ${det.name}: ${hits.length} hit(s) [${summary}]${scoreNote}`);
  }
  return total;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const memberIdx = args.indexOf('--member');
  const all = args.includes('--all');

  if (!all && memberIdx === -1) {
    console.error('usage: run-patterns.ts --member <slug> | --all');
    process.exit(2);
  }

  let members: string[];
  if (all) {
    members = (await listMembers()).map(m => m.member_id);
  } else {
    const slug = args[memberIdx + 1];
    if (!slug) {
      console.error('--member requires a slug');
      process.exit(2);
    }
    members = [slug];
  }

  // ADR 0003: this is a routine recompute path, not the confirmatory event —
  // warn (do not block) if a scored detector's confirmatory run isn't consumed.
  warnIfUnconsumed([...SCORED_PATTERNS]);

  let grandTotal = 0;
  for (const m of members) {
    console.log(`▸ ${m}`);
    grandTotal += await runForMember(m);
  }
  console.log(
    `\nDone. ${grandTotal} hit(s) across ${members.length} member(s), ` +
      `${DETECTORS.length} detector(s).`,
  );
  process.exit(0);
}

// Entry-point guard (repo convention): only run the CLI when invoked directly,
// so importing this module for its exports (e.g. writeAndScore in tests) does
// not trigger main()/process.exit.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
