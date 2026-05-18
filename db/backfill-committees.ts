/**
 * One-off: backfill `committees` rows from the unitedstates YAML, keyed by
 * bioguide_id. Earlier researcher runs lost committee data because their
 * bioguide-to-committee map relied on bioguides that hadn't been propagated
 * into the persisted output. Now that bioguide is populated, this fills in
 * the membership directly.
 *
 * Usage: npx tsx db/backfill-committees.ts
 */

import { applySchema, getDb } from './init.js';
import { committeeCanonical } from './load-bill-committees.js';
import { load as parseYaml } from 'js-yaml';

const UA = 'CivicLens/1.0 (research)';
const COMMITTEES_YAML = 'https://raw.githubusercontent.com/unitedstates/congress-legislators/main/committees-current.yaml';
const MEMBERSHIP_YAML = 'https://raw.githubusercontent.com/unitedstates/congress-legislators/main/committee-membership-current.yaml';

interface CommitteeMeta { name: string; chamber: 'House' | 'Senate' | 'Joint'; parentName: string | null }

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

async function loadCommitteeMap(): Promise<Map<string, CommitteeMeta>> {
  const txt = await fetchText(COMMITTEES_YAML);
  const data = parseYaml(txt) as any[];
  const map = new Map<string, CommitteeMeta>();
  for (const c of data ?? []) {
    const code = String(c.thomas_id ?? '');
    if (!code) continue;
    const chamber = c.type === 'senate' ? 'Senate' : c.type === 'house' ? 'House' : 'Joint';
    map.set(code, { name: String(c.name ?? code), chamber, parentName: null });
    for (const sub of c.subcommittees ?? []) {
      const subCode = `${code}${sub.thomas_id ?? ''}`;
      map.set(subCode, {
        name: `${c.name} — ${sub.name}`,
        chamber,
        parentName: String(c.name ?? ''),
      });
    }
  }
  return map;
}

async function loadMembershipMap(): Promise<Map<string, Array<{ code: string; role: string }>>> {
  const txt = await fetchText(MEMBERSHIP_YAML);
  const data = parseYaml(txt) as Record<string, any[]>;
  const map = new Map<string, Array<{ code: string; role: string }>>();
  for (const [code, members] of Object.entries(data ?? {})) {
    for (const m of members ?? []) {
      const bio = String(m.bioguide ?? '');
      if (!bio) continue;
      const t = String(m.title ?? '');
      const role = /chair/i.test(t) ? 'chair' : /ranking/i.test(t) ? 'ranking' : 'member';
      const arr = map.get(bio) ?? [];
      arr.push({ code, role });
      map.set(bio, arr);
    }
  }
  return map;
}

async function main() {
  await applySchema();
  console.log('Loading unitedstates YAMLs…');
  const [committees, memberships] = await Promise.all([loadCommitteeMap(), loadMembershipMap()]);
  console.log(`  ${committees.size} committees, ${memberships.size} members in YAML\n`);

  const conn = await getDb();
  const r = await conn.run(`SELECT member_id, name, bioguide_id FROM members WHERE bioguide_id IS NOT NULL ORDER BY name`);
  const rows = await r.getRowObjects() as any[];
  const fetchedAt = new Date().toISOString();

  let totalAdded = 0;
  for (const row of rows) {
    const memberId = String(row.member_id);
    const bg = String(row.bioguide_id);
    const memberships_for = memberships.get(bg) ?? [];
    if (memberships_for.length === 0) {
      console.log(`  · ${row.name.padEnd(26)} (no committee assignments in YAML)`);
      continue;
    }
    // Wipe existing rows for this member to avoid stale state.
    await conn.run(`DELETE FROM committees WHERE member_id = ?`, [memberId]);
    const seen = new Set<string>();
    for (const { code, role } of memberships_for) {
      const meta = committees.get(code);
      if (!meta || seen.has(meta.name)) continue;
      seen.add(meta.name);
      const canonical = committeeCanonical(meta.name);
      await conn.run(
        `INSERT OR REPLACE INTO committees
         (member_id, committee_name, committee_canonical, role, source_url, fetched_at)
         VALUES (?,?,?,?,?,?)`,
        [memberId, meta.name, canonical, role, 'https://www.congress.gov/committees', fetchedAt],
      );
      totalAdded++;
    }
    console.log(`  ✓ ${row.name.padEnd(26)} (${memberships_for.length} assignments → ${seen.size} committees)`);
  }
  console.log(`\nDone: ${totalAdded} committee rows written across ${rows.length} members.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
