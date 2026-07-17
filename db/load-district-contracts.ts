/**
 * District federal-contract loader. Fetches USAspending NAICS rollups
 * (transaction dollars per district × calendar year) into
 * district_contract_naics, the substrate for the district-contract-trade
 * detector and the Pattern Discovery contract's CitedRow.kind = 'contract'.
 *
 * Filter is district_original — the district map at award time, the honest
 * reading of "money into the district while the member held the seat". See
 * SOURCES.md §USAspending for the measured current-vs-original delta (GA-14)
 * and docs/2026-07-15-district-contracts-detector.md for the design.
 *
 * House-only: senators have no district. A House member with NULL district is
 * a hard error (no-stub rule), not a skip. Responses cached to
 * data/caches/usaspending-cache/<state>-<dist>-<cy>.json; the cache is the
 * frozen source of record, refetch only with --force. "Latest fetch wins" per
 * (member, cy).
 *
 * Usage:
 *   npx tsx db/load-district-contracts.ts [member-id] [--cy 2023,2024,2025] [--force] [--dry-run]
 *   npx tsx agents/pipeline.ts --load-district-contracts [member-id] [--cy ...] [--force] [--dry-run]
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySchema, getDb } from './init.js';
import { USASPENDING_CACHE } from '../lib/paths.js';

const API = 'https://api.usaspending.gov/api/v2/search/spending_by_category/naics/';
const DEFAULT_CYS = [2023, 2024, 2025];
const PAGE_LIMIT = 100;

interface NaicsRow { code: string; name: string; amount: number }
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

/** API wants zero-padded 2-digit districts ("5" → "05"). */
export function padDistrict(district: string): string {
  return district.padStart(2, '0');
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

/** Fetch (or read cached) full NAICS rollup for one district × CY. */
async function fetchDistrictCy(
  ref: DistrictRef,
  cy: number,
  opts: { force?: boolean },
): Promise<{ rows: NaicsRow[]; fromCache: boolean }> {
  const cachePath = join(USASPENDING_CACHE, `${ref.state}-${padDistrict(ref.district)}-${cy}.json`);
  if (!opts.force && existsSync(cachePath)) {
    return { rows: JSON.parse(readFileSync(cachePath, 'utf8')).rows, fromCache: true };
  }

  const rows: NaicsRow[] = [];
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
      rows.push({ code: String(r.code), name: r.name ?? null, amount: Number(r.amount) });
    }
    if (!data.page_metadata?.hasNext) break;
    page = data.page_metadata.next;
    await new Promise((r) => setTimeout(r, 250)); // no documented limit — page politely
  }

  mkdirSync(USASPENDING_CACHE, { recursive: true });
  writeFileSync(cachePath, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    filter: { state: ref.state, district_original: padDistrict(ref.district), cy },
    spending_level: 'transactions',
    rows,
  }, null, 2));
  return { rows, fromCache: false };
}

export async function loadDistrictContracts(opts: {
  memberId?: string;
  cys?: number[];
  force?: boolean;
  dryRun?: boolean;
} = {}): Promise<{ members: number; rowsInserted: number; errored: number }> {
  await applySchema();
  const conn = await getDb();
  const cys = opts.cys?.length ? opts.cys : DEFAULT_CYS;
  const members = await houseMembers(opts.memberId);

  console.log(
    `Loading district contracts for ${members.length} House member(s) × CY ${cys.join(',')}` +
    `${opts.dryRun ? ' (dry-run — DB unchanged)' : ''}…`,
  );

  let rowsInserted = 0;
  let errored = 0;
  for (const m of members) {
    for (const cy of cys) {
      let rows: NaicsRow[];
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
        `${rows.length} NAICS rows, $${Math.round(total).toLocaleString()}${fromCache ? ' (cache)' : ''}`,
      );
      if (opts.dryRun) continue;

      const fetchedAt = new Date().toISOString();
      await conn.run(`DELETE FROM district_contract_naics WHERE member_id = ? AND cy = ?`, [m.memberId, cy]);
      for (const r of rows) {
        await conn.run(
          `INSERT INTO district_contract_naics
           (member_id, cy, naics, naics_desc, amount, spending_level, fetched_at)
           VALUES (?,?,?,?,?,'transactions',?)`,
          [m.memberId, cy, r.code, r.name, r.amount, fetchedAt],
        );
        rowsInserted++;
      }
    }
  }

  console.log(`Done: ${rowsInserted} rows inserted, ${errored} district-CY fetch error(s).`);
  return { members: members.length, rowsInserted, errored };
}

export function parseArgs(argv: string[]): { memberId?: string; cys: number[]; force: boolean; dryRun: boolean } {
  let memberId: string | undefined;
  let force = false;
  let dryRun = false;
  const cys: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') { force = true; continue; }
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a === '--cy') {
      for (const part of (argv[++i] ?? '').split(',')) {
        const n = parseInt(part.trim(), 10);
        if (Number.isFinite(n)) cys.push(n);
      }
      continue;
    }
    if (!a.startsWith('--')) memberId = a;
  }
  return { memberId, cys, force, dryRun };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadDistrictContracts(parseArgs(process.argv.slice(2)))
    .then(({ errored }) => process.exit(errored > 0 ? 1 : 0))
    .catch((e) => { console.error(e); process.exit(2); });
}
