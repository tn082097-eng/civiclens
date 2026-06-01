/**
 * Backfill members.fec_candidate_id by name search against OpenFEC.
 * Required by lib/fec-ie.ts which keys off candidate_id.
 *
 * OpenFEC `/candidates/` does NOT expose bioguide_id (verified live), so we
 * use `/candidates/search/?q=<name>` and disambiguate by state + office.
 *
 * Usage:
 *   npx tsx db/backfill-fec-candidate.ts                # all null members
 *   import { resolveFecCandidateId } from './backfill-fec-candidate.js'  # single member, called from sync-task.ts
 */

import { readFileSync } from 'node:fs';
import { applySchema, getDb } from './init.js';
import { ENV_PATH } from '../lib/paths.js';

const UA = 'CivicLens/1.0 (research)';

// Mirror of researcher/fetch.ts loadEnvOnce — required for callers that don't
// boot through the pipeline (e.g. sync-task.ts, smoke tests).
let envLoaded = false;
function loadEnvOnce() {
  if (envLoaded) return;
  envLoaded = true;
  if (process.env.OPENFEC_API_KEY) return;
  try {
    const raw = readFileSync(ENV_PATH, 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) continue;
      if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* file missing — keys may come from shell env */ }
}

// Manual overrides for members FEC indexes under non-obvious name forms.
// Verified live via /candidates/search/ + state/office/district disambiguation.
export const FEC_OVERRIDES: Record<string, string> = {
  'chuck-schumer':    'S8NY00082', // SCHUMER, CHARLES E. (NY S)
  'jim-jordan':       'H6OH04082', // JORDAN, JAMES D. (OH-04)
  'katie-porter':     'H8CA45130', // PORTER, KATHERINE (CA-45 House — most recent active House run)
  'mike-johnson':     'H6LA04138', // JOHNSON, JAMES MICHAEL (Speaker, LA-04)
  'tommy-tuberville': 'S0AL00230', // TUBERVILLE, THOMAS H (AL S)
};

function chamberToOffice(chamber: string | null): 'H' | 'S' | null {
  if (!chamber) return null;
  const c = chamber.toLowerCase();
  if (c.startsWith('house')) return 'H';
  if (c.startsWith('senate')) return 'S';
  return null;
}

function getFecKey(): string {
  loadEnvOnce();
  return process.env.OPENFEC_API_KEY ?? '';
}

export async function lookupFecId(name: string, state: string | null, chamber: string | null): Promise<string | null> {
  const FEC_KEY = getFecKey();
  if (!FEC_KEY) return null;
  const wantOffice = chamberToOffice(chamber);
  const wantState = state ? state.toUpperCase() : null;
  const url = `https://api.open.fec.gov/v1/candidates/search/?api_key=${FEC_KEY}&q=${encodeURIComponent(name)}&per_page=20`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) return null;
  const d: any = await r.json();
  const results: any[] = d.results ?? [];
  if (results.length === 0) return null;
  // Sort client-side: most recent filer first.
  results.sort((a, b) => String(b.last_file_date ?? '').localeCompare(String(a.last_file_date ?? '')));

  // Strict: matching state AND office
  const strict = results.find(r => (!wantState || r.state === wantState) && (!wantOffice || r.office === wantOffice));
  if (strict) return strict.candidate_id;

  // Loose: matching state only (covers chamber switchers)
  const stateMatch = wantState ? results.find(r => r.state === wantState) : null;
  if (stateMatch) return stateMatch.candidate_id;

  return null;
}

/**
 * Resolve and persist members.fec_candidate_id for a single member if currently
 * null. Honors FEC_OVERRIDES first, then live name search. No-op if already set.
 * Called from sync-task.ts so newly-ingested members get an FEC ID without a
 * separate manual backfill run.
 */
export async function resolveFecCandidateId(memberId: string): Promise<{ filled: boolean; fec: string | null; reason?: string }> {
  const conn = await getDb();
  const r = await conn.run(`SELECT name, state, chamber, fec_candidate_id FROM members WHERE member_id = ?`, [memberId]);
  const rows = await r.getRowObjects() as any[];
  if (rows.length === 0) return { filled: false, fec: null, reason: 'member not found' };
  const row = rows[0];
  if (row.fec_candidate_id) return { filled: false, fec: String(row.fec_candidate_id), reason: 'already set' };
  if (FEC_OVERRIDES[memberId]) {
    const fec = FEC_OVERRIDES[memberId];
    await conn.run(`UPDATE members SET fec_candidate_id = ? WHERE member_id = ?`, [fec, memberId]);
    return { filled: true, fec };
  }
  const fec = await lookupFecId(String(row.name), row.state ?? null, row.chamber ?? null);
  if (!fec) return { filled: false, fec: null, reason: 'no FEC match' };
  await conn.run(`UPDATE members SET fec_candidate_id = ? WHERE member_id = ?`, [fec, memberId]);
  return { filled: true, fec };
}

async function main() {
  await applySchema();
  if (!getFecKey()) throw new Error('OPENFEC_API_KEY missing');
  const conn = await getDb();
  const r = await conn.run(`SELECT member_id, name FROM members WHERE fec_candidate_id IS NULL ORDER BY name`);
  const rows = await r.getRowObjects() as any[];
  console.log(`Resolving FEC candidate_id for ${rows.length} member(s)…\n`);
  let filled = 0, missed = 0;
  for (const row of rows) {
    const name = String(row.name);
    const memberId = String(row.member_id);
    const result = await resolveFecCandidateId(memberId);
    if (result.filled) {
      console.log(`  ✓ ${name.padEnd(26)} → ${result.fec}`);
      filled++;
    } else {
      console.log(`  ✗ ${name.padEnd(26)} unmatched (${result.reason ?? 'unknown'})`);
      missed++;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`\nDone: ${filled} filled, ${missed} unmatched.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
