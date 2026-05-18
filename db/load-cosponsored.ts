/**
 * Backfill cosponsored legislation into the `bills` table.
 *
 * Hits Congress.gov v3 `/member/{bioguide}/cosponsored-legislation` for each
 * member with a bioguide_id, paginates through all results, and inserts rows
 * with sponsor_role = 'cosponsor'. ON CONFLICT DO NOTHING so a member's own
 * sponsorship row is never overwritten by a cosponsor row.
 *
 * Source-first artifacts: pfd-cache/cosponsor-probe-2026-05-09/
 *
 * Usage: npx tsx db/load-cosponsored.ts [member-id]   (no arg = all members)
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getDb } from './init.js';

function loadEnvOnce() {
  if (process.env.CONGRESS_API_KEY) return;
  try {
    const raw = readFileSync(join(homedir(), '.hermes', '.env'), 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) continue;
      if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* file missing — keys may come from shell env */ }
}
loadEnvOnce();

const CONGRESS_KEY = process.env.CONGRESS_API_KEY;
if (!CONGRESS_KEY) {
  console.error('CONGRESS_API_KEY missing from ~/.hermes/.env');
  process.exit(1);
}

const PAGE_SIZE = 250;  // max per congress.gov docs
const UA = 'CivicLens/1.0 (https://github.com/duckjustice; civiclens@local)';

interface CongressBillItem {
  congress: number;
  type: string;
  number: string | number;
  title?: string;
  introducedDate?: string;
  latestAction?: { text?: string };
}

const URL_TYPE_MAP: Record<string,string> = {
  hr:    'house-bill',
  s:     'senate-bill',
  hres:  'house-resolution',
  sres:  'senate-resolution',
  hjres: 'house-joint-resolution',
  sjres: 'senate-joint-resolution',
  hconres: 'house-concurrent-resolution',
  sconres: 'senate-concurrent-resolution',
};

function buildSourceUrl(congress: number, typeLower: string, number: string | number): string {
  const slug = URL_TYPE_MAP[typeLower] ?? `${typeLower}`;
  return `https://www.congress.gov/bill/${congress}th-congress/${slug}/${number}`;
}

function normalizeBillStatus(text: string): 'introduced' | 'passed' | 'failed' | 'signed' {
  const t = text.toLowerCase();
  if (t.includes('became public law') || t.includes('signed by president')) return 'signed';
  if (t.includes('passed')) return 'passed';
  if (t.includes('failed') || t.includes('rejected')) return 'failed';
  return 'introduced';
}

async function fetchAllCosponsored(bioguide: string): Promise<CongressBillItem[]> {
  const out: CongressBillItem[] = [];
  let offset = 0;
  while (true) {
    const url = `https://api.congress.gov/v3/member/${bioguide}/cosponsored-legislation?format=json&limit=${PAGE_SIZE}&offset=${offset}&api_key=${CONGRESS_KEY}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120_000) });
    if (!r.ok) {
      throw new Error(`HTTP ${r.status} for ${bioguide} offset=${offset}`);
    }
    const d = await r.json() as any;
    const batch = (d.cosponsoredLegislation ?? []) as CongressBillItem[];
    out.push(...batch);
    const totalCount = d.pagination?.count;
    if (batch.length < PAGE_SIZE || (totalCount && out.length >= totalCount)) break;
    offset += PAGE_SIZE;
    // be polite
    await new Promise(r => setTimeout(r, 100));
  }
  return out;
}

async function main() {
  const conn = await getDb();
  const targetArg = process.argv[2] ?? null;

  const memberRows = await (await conn.run(
    targetArg
      ? `SELECT member_id, bioguide_id, name FROM members WHERE member_id = ?`
      : `SELECT member_id, bioguide_id, name FROM members WHERE bioguide_id IS NOT NULL ORDER BY member_id`,
    targetArg ? [targetArg] : []
  )).getRowObjects() as any[];

  console.log(`Loading cosponsors for ${memberRows.length} member(s)…\n`);
  const fetchedAt = new Date().toISOString();
  let totalInserted = 0;

  for (const m of memberRows) {
    const bio = String(m.bioguide_id ?? '');
    if (!bio) { console.log(`  skip ${m.member_id}: no bioguide`); continue; }
    let bills: CongressBillItem[];
    try {
      bills = await fetchAllCosponsored(bio);
    } catch (e) {
      console.warn(`  ${m.member_id}: fetch failed — ${(e as Error).message}`);
      continue;
    }

    let inserted = 0;
    let skipped = 0;
    await conn.run('BEGIN');
    try {
      for (const b of bills) {
        const congress = b.congress;
        const typeLower = String(b.type ?? '').toLowerCase();
        const number = b.number;
        if (!congress || !typeLower || !number) { skipped++; continue; }
        const billId = `${congress}/${typeLower}/${number}`;
        const introducedAt = (b.introducedDate ?? '').slice(0, 10) || null;
        const status = normalizeBillStatus(b.latestAction?.text ?? 'introduced');
        const title = b.title ?? `${typeLower.toUpperCase()} ${number}`;
        const sourceUrl = buildSourceUrl(congress, typeLower, number);

        const before = (await (await conn.run(
          `SELECT count(*) AS n FROM bills WHERE member_id = ? AND bill_id = ?`,
          [m.member_id, billId]
        )).getRowObjects())[0] as any;

        await conn.run(
          `INSERT INTO bills (member_id, bill_id, title, status, sponsor_role, introduced_at, source_url, fetched_at)
           VALUES (?, ?, ?, ?, 'cosponsor', ?, ?, ?)
           ON CONFLICT (member_id, bill_id) DO NOTHING`,
          [m.member_id, billId, title, status, introducedAt, sourceUrl, fetchedAt]
        );

        const after = (await (await conn.run(
          `SELECT count(*) AS n FROM bills WHERE member_id = ? AND bill_id = ?`,
          [m.member_id, billId]
        )).getRowObjects())[0] as any;

        if (Number(after.n) > Number(before.n)) inserted++; else skipped++;
      }
      await conn.run('COMMIT');
    } catch (e) {
      await conn.run('ROLLBACK');
      console.warn(`  ${m.member_id}: insert failed — ${(e as Error).message}`);
      continue;
    }

    totalInserted += inserted;
    console.log(`  ${m.member_id} (${m.name}): ${bills.length} fetched, ${inserted} inserted, ${skipped} dup/skipped`);
  }

  console.log(`\nDone. ${totalInserted} cosponsor rows inserted.`);

  // Summary
  const total = (await (await conn.run(`SELECT sponsor_role, count(*) AS n FROM bills GROUP BY sponsor_role`)).getRowObjects()) as any[];
  console.log('Bills table now:', total.map(r => ({ ...r, n: Number(r.n) })));
  process.exit(0);
}

main();
