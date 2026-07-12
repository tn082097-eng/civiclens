// Baseline DB verification — deterministic health metrics for release checks.
// Prints roster composition, vote→bill linkage, and row counts for the core
// tables; exits non-zero if the Phase 2 linkage gate (≥75%) regresses.
// Run: npm run verify:baseline
import { getDb } from '../db/init.js';

const LINKAGE_GATE_PCT = 75;

async function q(conn: any, sql: string) {
  const r = await conn.run(sql);
  return await r.getRows();
}

const conn = await getDb();

console.log('=== ROSTER (party × chamber) ===');
console.table(await q(conn, `SELECT party, chamber, COUNT(*) FROM members GROUP BY party, chamber ORDER BY party, chamber`));

console.log('=== VOTE->BILL LINKAGE ===');
const [[total, linked, pct]] = await q(conn, `SELECT COUNT(*) total, COUNT(bill_id) linked, ROUND(100.0*COUNT(bill_id)/COUNT(*),1) pct FROM votes`);
console.log(`${linked} / ${total} = ${pct}% (gate: >=${LINKAGE_GATE_PCT}%)`);

console.log('=== ROW COUNTS (core tables) ===');
const tables = [
  'members', 'member_aliases', 'votes', 'bills', 'bill_summaries', 'bill_subjects',
  'bill_committees', 'committees', 'pfd_transactions', 'donors', 'donor_industry',
  'super_pac_ie', 'super_pac_ie_filings', 'lda_filings', 'lda_lobbyists',
  'pattern_hits', 'theme_bill_match', 'pipeline_runs',
];
let missing = 0;
for (const t of tables) {
  try {
    const r = await q(conn, `SELECT COUNT(*) FROM ${t}`);
    console.log(t.padEnd(24), String(r[0][0]));
  } catch (e: any) {
    console.log(t.padEnd(24), 'MISSING:', String(e.message).split('\n')[0]);
    missing++;
  }
}

const linkageOk = Number(pct) >= LINKAGE_GATE_PCT;
if (!linkageOk) console.error(`\nFAIL: linkage ${pct}% below ${LINKAGE_GATE_PCT}% gate`);
if (missing) console.error(`FAIL: ${missing} core table(s) missing`);
process.exit(linkageOk && missing === 0 ? 0 : 1);
