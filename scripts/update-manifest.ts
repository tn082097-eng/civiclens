// Upsert per-member inventory stats into render/published-members.json — the
// landing page's only input (ADR 0002 §C: public artifacts are deterministic
// functions of verified, committed inputs; the landing never reads the DB).
//
// Run by scripts/package-launch.sh for every member it packages, immediately
// after the verified render, so the manifest reflects the same DB snapshot
// as the pages being shipped. Inventory counts only — never detector output.
//
// Usage: npx tsx scripts/update-manifest.ts <member-slug> [<member-slug>…]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeDb } from '../db/init.js';
import type { PublishedManifest, PublishedMember } from '../render/landing.js';

const MANIFEST_PATH = resolve(
  fileURLToPath(new URL('.', import.meta.url)), '../render/published-members.json');

async function fetchEntry(slug: string): Promise<PublishedMember> {
  const conn = await getDb();
  const who = await (await conn.run(
    `SELECT name, party, chamber, state FROM members WHERE member_id = $1`, [slug]
  )).getRowObjects() as any[];
  if (who.length === 0) throw new Error(`no such member in DB: ${slug}`);
  const stats = await (await conn.run(`
    SELECT
      (SELECT COUNT(*) FROM pfd_transactions WHERE member_id = $1)                              AS trades,
      (SELECT COUNT(*) FROM votes WHERE member_id = $1)                                         AS votes,
      (SELECT COUNT(*) FROM bills WHERE member_id = $1 AND sponsor_role = 'sponsor')            AS sponsored,
      (SELECT COUNT(*) FROM bills WHERE member_id = $1 AND sponsor_role = 'cosponsor')          AS cosponsored,
      (SELECT COUNT(*) FROM donors WHERE member_id = $1)                                        AS donors,
      (SELECT CAST(MAX(d) AS VARCHAR) FROM (
         SELECT MAX(tx_date) AS d FROM pfd_transactions WHERE member_id = $1
         UNION ALL
         SELECT MAX(date) FROM votes WHERE member_id = $1))                                     AS data_through
  `, [slug])).getRowObjects() as any[];
  const s = stats[0];
  return {
    slug,
    name: String(who[0].name),
    party: String(who[0].party ?? ''),
    chamber: String(who[0].chamber ?? ''),
    state: String(who[0].state ?? ''),
    stats: {
      trades: Number(s.trades),
      votes: Number(s.votes),
      sponsored: Number(s.sponsored),
      cosponsored: Number(s.cosponsored),
      donors: Number(s.donors),
    },
    dataThrough: s.data_through == null ? null : String(s.data_through),
  };
}

async function main(): Promise<void> {
  const slugs = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (slugs.length === 0) {
    console.error('usage: update-manifest.ts <member-slug> [<member-slug>…]');
    process.exit(1);
  }
  const manifest: PublishedManifest = existsSync(MANIFEST_PATH)
    ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    : { members: [] };
  for (const slug of slugs) {
    const entry = await fetchEntry(slug);
    const i = manifest.members.findIndex((m) => m.slug === slug);
    if (i >= 0) manifest.members[i] = entry;
    else manifest.members.push(entry);
    console.log(`  ✓ ${slug}: ${JSON.stringify(entry.stats)} through ${entry.dataThrough}`);
  }
  manifest.members.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${MANIFEST_PATH} (${manifest.members.length} published)`);
}

main().then(() => { closeDb(); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
