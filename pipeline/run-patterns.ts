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

import { getDb } from '../db/init.js';
import { listMembers } from '../db/queries.js';
import { DETECTORS } from './patterns/registry.js';
import type { PatternHit } from './patterns/types.js';

async function writeHits(
  pattern: string,
  member: string,
  hits: PatternHit[],
): Promise<void> {
  const conn = await getDb();
  // Clear this detector's prior hits for this member, then insert fresh.
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
    await writeHits(det.name, member, hits);
    total += hits.length;
    const summary = hits.length
      ? hits.map(h => `${h.intensity.toFixed(2)}`).join(',')
      : '—';
    console.log(`  ${det.name}: ${hits.length} hit(s) [${summary}]`);
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

main().catch(e => {
  console.error(e);
  process.exit(1);
});
