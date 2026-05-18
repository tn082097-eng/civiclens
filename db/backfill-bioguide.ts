/**
 * One-off: backfill members.bioguide_id by name lookup against Congress.gov.
 * Needed because earlier researcher runs didn't propagate bioguide into the
 * persisted `data` block, so the DB has NULL bioguides corpus-wide. Future
 * runs (post pipeline.ts:369 fix) carry it correctly.
 *
 * Usage: npx tsx db/backfill-bioguide.ts
 */

import { applySchema, getDb } from './init.js';

const CONGRESS_KEY = process.env.CONGRESS_API_KEY ?? '';
const UA = 'CivicLens/1.0 (research)';

interface Match { bioguideId: string; lastName: string; firstName: string; state: string }

async function searchByName(name: string, state: string): Promise<string | null> {
  // Walk currentMember=true list (paginated) and match by last+first or
  // inverted "Last, First" form. State narrows to disambiguate.
  for (let offset = 0; offset < 800; offset += 250) {
    const url = `https://api.congress.gov/v3/member?format=json&currentMember=true&limit=250&offset=${offset}&api_key=${CONGRESS_KEY}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) break;
    const d: any = await r.json();
    const members: Match[] = (d.members ?? []).map((m: any) => ({
      bioguideId: m.bioguideId,
      lastName:   String(m.name ?? '').split(',')[0].trim().toLowerCase(),
      firstName:  String(m.name ?? '').split(',')[1]?.trim().toLowerCase() ?? '',
      state:      String(m.state ?? '').toUpperCase(),
    }));
    // Hyphenated last names (e.g. "Ocasio-Cortez") + Bernie's "Bernard"/"Bernie"
    // canonicalization mismatch handled by substring check.
    const tokens = name.split(/\s+/).map(s => s.toLowerCase());
    const inputLast  = tokens[tokens.length - 1];
    const inputFirst = tokens[0];
    const found = members.find(m =>
      (m.lastName === inputLast || m.lastName.includes(inputLast) || inputLast.includes(m.lastName)) &&
      (m.firstName.startsWith(inputFirst) ||
       inputFirst.startsWith(m.firstName) ||
       m.firstName.startsWith(inputFirst.slice(0, 4)) ||  // "bernie" → "bern"
       inputFirst.startsWith(m.firstName.slice(0, 4)))
    );
    if (found) return found.bioguideId;
    if (members.length < 250) break;
  }
  return null;
}

async function main() {
  await applySchema();
  if (!CONGRESS_KEY) throw new Error('CONGRESS_API_KEY missing');
  const conn = await getDb();
  const r = await conn.run(`SELECT member_id, name, state FROM members WHERE bioguide_id IS NULL ORDER BY name`);
  const rows = await r.getRowObjects() as any[];
  console.log(`Resolving bioguide for ${rows.length} member(s)…\n`);
  let filled = 0, missed = 0;
  for (const row of rows) {
    const name = String(row.name);
    const state = String(row.state ?? '');
    const bg = await searchByName(name, state);
    if (bg) {
      await conn.run(`UPDATE members SET bioguide_id = ? WHERE member_id = ?`, [bg, String(row.member_id)]);
      console.log(`  ✓ ${name.padEnd(26)} → ${bg}`);
      filled++;
    } else {
      console.log(`  ✗ ${name.padEnd(26)} unmatched`);
      missed++;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  console.log(`\nDone: ${filled} filled, ${missed} unmatched.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
