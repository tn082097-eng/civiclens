import { getDb, applySchema } from './init.js';
import { getLegislatorIndex, getAllAliases } from '../lib/legislators.js';

async function main() {
  await applySchema();
  const conn = await getDb();
  const index = getLegislatorIndex();
  const aliasMap = getAllAliases();

  // 1. Seed the full alias projection (DELETE-then-insert, idempotent).
  await conn.run('DELETE FROM member_aliases');
  let rows = 0;
  for (const [alias, bios] of aliasMap) {
    for (const bio of bios) {
      await conn.run('INSERT INTO member_aliases VALUES (?, ?)', [alias, bio]);
      rows++;
    }
  }
  console.log(`seeded ${rows} alias rows across ${aliasMap.size} distinct names`);

  // 2. Backfill members: bioguide-derived term_start/end, chamber, state, district.
  //    Keyed by the member row's existing bioguide_id (already 57/57 populated).
  //    Does NOT touch member_id (slug) — preservation is the resolver's job.
  const mrows = (await (await conn.run(
    'SELECT member_id, bioguide_id FROM members WHERE bioguide_id IS NOT NULL',
  )).getRowObjects()) as Array<{ member_id: string; bioguide_id: string }>;

  // Fail-loud: a duplicate bioguide would violate one-person-one-row.
  const seen = new Map<string, string>();
  for (const m of mrows) {
    const prev = seen.get(m.bioguide_id);
    if (prev) {
      console.error(`ABORT: duplicate bioguide ${m.bioguide_id} on member rows "${prev}" and "${m.member_id}". Identity is not 1:1 — refusing to backfill.`);
      process.exit(1);
    }
    seen.set(m.bioguide_id, m.member_id);
  }

  let filled = 0;
  for (const m of mrows) {
    const leg = index.get(m.bioguide_id);
    if (!leg) { console.warn(`no YAML identity for bioguide ${m.bioguide_id} (${m.member_id})`); continue; }
    await conn.run(
      `UPDATE members SET term_start = ?, term_end = ?, chamber = ?, state = ?, district = ? WHERE member_id = ?`,
      [leg.termStart || null, leg.termEnd || null, leg.chamber, leg.state || null, leg.district, m.member_id],
    );
    filled++;
  }
  console.log(`backfilled ${filled} member rows from YAML`);
  process.exit(0);
}

main();
