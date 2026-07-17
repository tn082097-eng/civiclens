/**
 * District recipient loader. Fetches USAspending recipient rollups
 * (transaction dollars per recipient × district × CY, Endpoint 3 in
 * SOURCES.md §USAspending) into district_contract_recipient, then resolves
 * SAM.gov parents (GET /recipient/{id}/) for every recipient not matched on
 * own name — the probe capped parent lookups at top-40; this harvest lifts
 * the cap per SOURCES.md.
 *
 * Filter is district_original; House-only; spending_level asserted
 * 'transactions'. Recipient pages cached to
 * data/caches/usaspending-recipient-cache/<state>-<dist>-<cy>.json, parent
 * profiles to .../recipient/<recipient_id>.json. Cache is the frozen source
 * of record; refetch only with --force (page cache only — parent profiles
 * are identity facts, never refetched).
 *
 * Usage:
 *   npx tsx db/load-district-recipients.ts [member-id] [--cy 2023,2024,2025] [--force] [--dry-run] [--skip-parents]
 *   npx tsx agents/pipeline.ts --load-district-recipients [member-id] [...]
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySchema, getDb } from './init.js';
import { padDistrict } from './load-district-contracts.js';
import { USASPENDING_RECIPIENT_CACHE } from '../lib/paths.js';
import { fetchSecTickers } from '../lib/sec-tickers.js';
import { buildNameIndex, normCorpName } from '../lib/recipient-match.js';

const API = 'https://api.usaspending.gov/api/v2/search/spending_by_category/recipient/';
const RECIPIENT_API = 'https://api.usaspending.gov/api/v2/recipient';
const DEFAULT_CYS = [2023, 2024, 2025];
const PAGE_LIMIT = 100;

interface RecipRow { recipient_id: string | null; name: string; amount: number }
interface DistrictRef { memberId: string; state: string; district: string }

async function houseMembers(memberId?: string): Promise<DistrictRef[]> {
  const conn = await getDb();
  const r = await conn.run(
    `SELECT member_id, state, district
       FROM members
      WHERE chamber = 'house' AND in_office
        ${memberId ? 'AND member_id = ?' : ''}
      ORDER BY member_id`,
    memberId ? [memberId] : [],
  );
  const rows = (await r.getRowObjects()) as unknown as Array<{ member_id: string; state: string | null; district: string | null }>;
  if (memberId && rows.length === 0) {
    throw new Error(`no in-office House member "${memberId}" (senators have no district — House only)`);
  }
  return rows.map((row) => {
    if (!row.state || !row.district) {
      throw new Error(
        `members.state/district missing for House member "${row.member_id}" — ` +
        `fix the roster row (legislators YAML is the identity source); refusing to stub`,
      );
    }
    return { memberId: row.member_id, state: row.state, district: row.district };
  });
}

async function fetchPage(state: string, district: string, cy: number, page: number): Promise<any> {
  const body = {
    filters: {
      award_type_codes: ['A', 'B', 'C', 'D'],
      place_of_performance_locations: [
        { country: 'USA', state, district_original: padDistrict(district) },
      ],
      time_period: [{ start_date: `${cy}-01-01`, end_date: `${cy}-12-31` }],
    },
    limit: PAGE_LIMIT,
    page,
  };
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`USAspending ${res.status} for ${state}-${district} CY${cy} page ${page}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/** Fetch (or read cached) full recipient rollup for one district × CY. */
async function fetchDistrictCy(
  ref: DistrictRef,
  cy: number,
  opts: { force?: boolean },
): Promise<{ rows: RecipRow[]; fromCache: boolean }> {
  const cachePath = join(USASPENDING_RECIPIENT_CACHE, `${ref.state}-${padDistrict(ref.district)}-${cy}.json`);
  if (!opts.force && existsSync(cachePath)) {
    return { rows: JSON.parse(readFileSync(cachePath, 'utf8')).rows, fromCache: true };
  }

  const rows: RecipRow[] = [];
  let page = 1;
  for (;;) {
    const data = await fetchPage(ref.state, ref.district, cy, page);
    if (data.spending_level !== 'transactions') {
      throw new Error(
        `spending_level "${data.spending_level}" for ${ref.state}-${ref.district} CY${cy} — ` +
        `expected 'transactions'; never mix transaction dollars with award ceilings`,
      );
    }
    for (const r of data.results ?? []) {
      rows.push({ recipient_id: r.recipient_id ?? null, name: String(r.name), amount: Number(r.amount) });
    }
    if (!data.page_metadata?.hasNext) break;
    page = data.page_metadata.next;
    await new Promise((r) => setTimeout(r, 250)); // no documented limit — page politely
  }

  mkdirSync(USASPENDING_RECIPIENT_CACHE, { recursive: true });
  writeFileSync(cachePath, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    filter: { state: ref.state, district_original: padDistrict(ref.district), cy },
    spending_level: 'transactions',
    rows,
  }, null, 2));
  return { rows, fromCache: false };
}

/** Fetch (or read cached) SAM.gov parent profile for one recipient id. */
async function fetchParent(recipientId: string): Promise<{ parent_name: string | null; parent_uei: string | null; name: string | null }> {
  const cachePath = join(USASPENDING_RECIPIENT_CACHE, 'recipient', `${recipientId}.json`);
  if (existsSync(cachePath)) {
    const c = JSON.parse(readFileSync(cachePath, 'utf8'));
    return { parent_name: c.parent_name ?? null, parent_uei: c.parent_uei ?? null, name: c.name ?? null };
  }
  const res = await fetch(`${RECIPIENT_API}/${recipientId}/`);
  if (!res.ok) throw new Error(`recipient profile ${res.status} for ${recipientId}`);
  const prof = await res.json();
  if (!prof || typeof prof !== 'object' || !('name' in prof)) {
    throw new Error(`recipient profile ${recipientId}: unexpected payload shape — not caching`);
  }
  mkdirSync(join(USASPENDING_RECIPIENT_CACHE, 'recipient'), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    name: prof.name ?? null, parent_name: prof.parent_name ?? null, parent_uei: prof.parent_uei ?? null,
  }, null, 2));
  await new Promise((r) => setTimeout(r, 150)); // polite, matches probe cadence
  return { parent_name: prof.parent_name ?? null, parent_uei: prof.parent_uei ?? null, name: prof.name ?? null };
}

export async function loadDistrictRecipients(opts: {
  memberId?: string;
  cys?: number[];
  force?: boolean;
  dryRun?: boolean;
  skipParents?: boolean;
} = {}): Promise<{ members: number; rowsInserted: number; parentsFetched: number; errored: number }> {
  await applySchema();
  const conn = await getDb();
  const cys = opts.cys?.length ? opts.cys : DEFAULT_CYS;
  const members = await houseMembers(opts.memberId);

  console.log(
    `Loading district recipients for ${members.length} House member(s) × CY ${cys.join(',')}` +
    `${opts.dryRun ? ' (dry-run — DB unchanged)' : ''}…`,
  );

  let rowsInserted = 0;
  let errored = 0;
  for (const m of members) {
    for (const cy of cys) {
      let rows: RecipRow[];
      let fromCache: boolean;
      try {
        ({ rows, fromCache } = await fetchDistrictCy(m, cy, opts));
      } catch (e: any) {
        errored++;
        console.error(`  ${m.memberId} CY${cy}: ERROR ${e?.message ?? e}`);
        continue;
      }
      const total = rows.reduce((a, r) => a + r.amount, 0);
      console.log(
        `  ${m.memberId} (${m.state}-${padDistrict(m.district)}) CY${cy}: ` +
        `${rows.length} recipients, $${Math.round(total).toLocaleString()}${fromCache ? ' (cache)' : ''}`,
      );
      if (opts.dryRun) continue;

      const fetchedAt = new Date().toISOString();
      await conn.run(`DELETE FROM district_contract_recipient WHERE member_id = ? AND cy = ?`, [m.memberId, cy]);
      for (const r of rows) {
        const recipientKey = r.recipient_id ?? r.name;
        await conn.run(
          `INSERT INTO district_contract_recipient
           (member_id, cy, recipient_key, recipient_id, recipient_name, amount, spending_level, fetched_at)
           VALUES (?,?,?,?,?,?,'transactions',?)`,
          [m.memberId, cy, recipientKey, r.recipient_id, r.name, r.amount, fetchedAt],
        );
        rowsInserted++;
      }
    }
  }

  let parentsFetched = 0;
  if (!opts.skipParents && !opts.dryRun) {
    const idx = buildNameIndex(await fetchSecTickers());
    const dr = await conn.run(
      `SELECT DISTINCT recipient_id, recipient_name FROM district_contract_recipient WHERE recipient_id IS NOT NULL`,
    );
    const distinctRecipients = (await dr.getRowObjects()) as unknown as Array<{ recipient_id: string; recipient_name: string }>;
    for (const rec of distinctRecipients) {
      if (idx.get(normCorpName(rec.recipient_name))) continue; // already own-name matched
      const existing = await conn.run(`SELECT 1 FROM recipient_parent WHERE recipient_id = ?`, [rec.recipient_id]);
      if ((await existing.getRowObjects()).length > 0) continue;

      try {
        const parent = await fetchParent(rec.recipient_id);
        const fetchedAt = new Date().toISOString();
        await conn.run(
          `INSERT OR REPLACE INTO recipient_parent (recipient_id, recipient_name, parent_name, parent_uei, fetched_at)
           VALUES (?,?,?,?,?)`,
          [rec.recipient_id, parent.name ?? rec.recipient_name, parent.parent_name, parent.parent_uei, fetchedAt],
        );
        parentsFetched++;
      } catch (e: any) {
        errored++;
        console.error(`  parent ${rec.recipient_id} (${rec.recipient_name}): ERROR ${e?.message ?? e}`);
      }
    }
    console.log(`Parent resolution: ${parentsFetched} profile(s) fetched.`);
  }

  console.log(`Done: ${rowsInserted} rows inserted, ${parentsFetched} parents fetched, ${errored} error(s).`);
  return { members: members.length, rowsInserted, parentsFetched, errored };
}

export function parseArgs(argv: string[]): { memberId?: string; cys: number[]; force: boolean; dryRun: boolean; skipParents: boolean } {
  let memberId: string | undefined;
  let force = false;
  let dryRun = false;
  let skipParents = false;
  const cys: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') { force = true; continue; }
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a === '--skip-parents') { skipParents = true; continue; }
    if (a === '--cy') {
      for (const part of (argv[++i] ?? '').split(',')) {
        const n = parseInt(part.trim(), 10);
        if (Number.isFinite(n)) cys.push(n);
      }
      continue;
    }
    if (!a.startsWith('--')) memberId = a;
  }
  return { memberId, cys, force, dryRun, skipParents };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadDistrictRecipients(parseArgs(process.argv.slice(2)))
    .then(({ errored }) => process.exit(errored > 0 ? 1 : 0))
    .catch((e) => { console.error(e); process.exit(2); });
}
