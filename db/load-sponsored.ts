/**
 * Authoritative sponsored-legislation loader (Congress.gov).
 *
 * Replaces the LLM-fabricated sponsor rows (Grok-3 researcher → researcher.json
 * → load-from-tasks.ts) with primary-source data from
 * `/member/{bioguide}/sponsored-legislation`, and captures the inline
 * `policyArea` into `bill_subjects` so the donor-sector-vote-alignment detector
 * can match a member's authored bills to their donor themes — the gap that left
 * mike-turner (Defense donors + 40 authored defense bills) with zero hits.
 *
 * Dual-write, two id formats (see SOURCES.md "Sponsored Legislation"):
 *   - bills.bill_id        = `${congress}/${type}/${number}`  (slash)
 *   - bill_subjects.bill_id = `${congress}-${type}-${number}`  (dash)
 * The detector joins bill_subjects via REPLACE(bills.bill_id,'/','-').
 *
 * DURABILITY: load-from-tasks.ts uses INSERT OR REPLACE INTO bills, so this
 * loader MUST run AFTER it — it is a post-research enrichment loader.
 *
 * Usage:
 *   npx tsx db/load-sponsored.ts                 # all members
 *   npx tsx db/load-sponsored.ts mike-turner     # one member (smoke test)
 *   npx tsx agents/pipeline.ts --load-sponsored [member-id]
 */
import { readFileSync } from 'node:fs';
import { applySchema, getDb } from './init.js';
import { ENV_PATH } from '../lib/paths.js';

function loadEnvOnce() {
  if (process.env.CONGRESS_API_KEY) return;
  try {
    const raw = readFileSync(ENV_PATH, 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) continue;
      if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* file missing — keys may come from shell env */ }
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
  policyArea?: { name?: string | null };
}

const URL_TYPE_MAP: Record<string, string> = {
  hr: 'house-bill',
  s: 'senate-bill',
  hres: 'house-resolution',
  sres: 'senate-resolution',
  hjres: 'house-joint-resolution',
  sjres: 'senate-joint-resolution',
  hconres: 'house-concurrent-resolution',
  sconres: 'senate-concurrent-resolution',
};

function buildSourceUrl(congress: number, typeLower: string, number: string | number): string {
  const slug = URL_TYPE_MAP[typeLower] ?? typeLower;
  return `https://www.congress.gov/bill/${congress}th-congress/${slug}/${number}`;
}

function normalizeBillStatus(text: string): 'introduced' | 'passed' | 'failed' | 'signed' {
  const t = text.toLowerCase();
  if (t.includes('became public law') || t.includes('signed by president')) return 'signed';
  if (t.includes('passed')) return 'passed';
  if (t.includes('failed') || t.includes('rejected')) return 'failed';
  return 'introduced';
}

async function fetchAllSponsored(bioguide: string, key: string): Promise<CongressBillItem[]> {
  const out: CongressBillItem[] = [];
  let offset = 0;
  while (true) {
    const url = `https://api.congress.gov/v3/member/${bioguide}/sponsored-legislation?format=json&limit=${PAGE_SIZE}&offset=${offset}&api_key=${key}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${bioguide} offset=${offset}`);
    const d = await r.json() as any;
    const batch = (d.sponsoredLegislation ?? []) as CongressBillItem[];
    out.push(...batch);
    const totalCount = d.pagination?.count;
    if (batch.length < PAGE_SIZE || (totalCount && out.length >= totalCount)) break;
    offset += PAGE_SIZE;
    await new Promise(r => setTimeout(r, 100));  // be polite
  }
  return out;
}

export async function loadSponsored(
  opts: { memberId?: string | null } = {},
): Promise<{ members: number; billsUpserted: number; subjectsWritten: number }> {
  loadEnvOnce();
  const key = process.env.CONGRESS_API_KEY;
  if (!key) throw new Error('CONGRESS_API_KEY missing from CivicLens .env (' + ENV_PATH + ')');

  await applySchema();
  const conn = await getDb();
  const targetArg = opts.memberId ?? null;

  const memberRows = await (await conn.run(
    targetArg
      ? `SELECT member_id, bioguide_id, name FROM members WHERE member_id = ?`
      : `SELECT member_id, bioguide_id, name FROM members WHERE bioguide_id IS NOT NULL ORDER BY member_id`,
    targetArg ? [targetArg] : [],
  )).getRowObjects() as any[];

  console.log(`Loading sponsored legislation for ${memberRows.length} member(s)…\n`);
  const fetchedAt = new Date().toISOString();
  let billsUpserted = 0;
  let subjectsWritten = 0;
  let membersDone = 0;

  for (const m of memberRows) {
    const bio = String(m.bioguide_id ?? '');
    if (!bio) { console.log(`  skip ${m.member_id}: no bioguide`); continue; }

    let bills: CongressBillItem[];
    try {
      bills = await fetchAllSponsored(bio, key);
    } catch (e) {
      console.warn(`  ${m.member_id}: fetch failed — ${(e as Error).message}`);
      continue;
    }

    let upserted = 0, subjects = 0, skipped = 0, noPolicy = 0;
    await conn.run('BEGIN');
    try {
      for (const b of bills) {
        const congress = b.congress;
        const typeLower = String(b.type ?? '').toLowerCase();
        const number = b.number;
        if (!congress || !typeLower || !number) { skipped++; continue; }

        const slashId = `${congress}/${typeLower}/${number}`;
        const dashId = `${congress}-${typeLower}-${number}`;
        const introducedAt = (b.introducedDate ?? '').slice(0, 10) || null;
        const status = normalizeBillStatus(b.latestAction?.text ?? 'introduced');
        const title = b.title ?? `${typeLower.toUpperCase()} ${number}`;
        const sourceUrl = buildSourceUrl(congress, typeLower, number);

        // Authoritative sponsor row overwrites whatever the LLM produced.
        await conn.run(
          `INSERT INTO bills (member_id, bill_id, title, status, sponsor_role, introduced_at, source_url, fetched_at)
           VALUES (?, ?, ?, ?, 'sponsor', ?, ?, ?)
           ON CONFLICT (member_id, bill_id) DO UPDATE SET
             title         = EXCLUDED.title,
             status        = EXCLUDED.status,
             sponsor_role  = 'sponsor',
             introduced_at = EXCLUDED.introduced_at,
             source_url    = EXCLUDED.source_url,
             fetched_at    = EXCLUDED.fetched_at`,
          [m.member_id, slashId, title, status, introducedAt, sourceUrl, fetchedAt],
        );
        upserted++;

        // policyArea is inline in the list response; null for very recent bills.
        const policyArea = b.policyArea?.name ?? null;
        if (policyArea) {
          await conn.run(
            `INSERT OR REPLACE INTO bill_subjects (bill_id, policy_area, subject, source_url, fetched_at)
             VALUES (?, ?, ?, ?, ?)`,
            [dashId, policyArea, policyArea, sourceUrl, fetchedAt],
          );
          subjects++;
        } else {
          noPolicy++;
        }
      }
      await conn.run('COMMIT');
    } catch (e) {
      await conn.run('ROLLBACK');
      console.warn(`  ${m.member_id}: write failed — ${(e as Error).message}`);
      continue;
    }

    billsUpserted += upserted;
    subjectsWritten += subjects;
    membersDone++;
    console.log(`  ${m.member_id} (${m.name}): ${bills.length} fetched, ${upserted} upserted, ${subjects} w/ policyArea, ${noPolicy} no-policy${skipped ? `, ${skipped} skipped` : ''}`);
  }

  console.log(`\nDone. ${membersDone} member(s), ${billsUpserted} sponsor rows upserted, ${subjectsWritten} bill_subjects rows written.`);
  return { members: membersDone, billsUpserted, subjectsWritten };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const memberId = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  loadSponsored({ memberId })
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}
