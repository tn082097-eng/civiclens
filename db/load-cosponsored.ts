/**
 * Backfill cosponsored legislation into the `bills` table.
 *
 * Hits Congress.gov v3 `/member/{bioguide}/cosponsored-legislation` for each
 * member with a bioguide_id, paginates through all results, and inserts rows
 * with sponsor_role = 'cosponsor'. ON CONFLICT DO NOTHING so a member's own
 * sponsorship row is never overwritten by a cosponsor row.
 *
 * Fail-closed contract (stratum 4, Chris Van Hollen, 2026-09-09): the fetch for
 * the target member "terminated incomplete before target rows were loaded", yet
 * the step reported success and the run continued. Two silent-success holes
 * caused that, both closed here:
 *
 *   1. A per-member fetch error was caught, printed as a warning, and the loop
 *      moved on — and `main()` ended with an unconditional `process.exit(0)`.
 *   2. Pagination stopped on ANY short page, even when upstream's
 *      `pagination.count` said more rows remained. A truncated page therefore
 *      yielded a silently partial bill list written as if it were complete.
 *
 * An incomplete fetch now fails that member and exits non-zero, and NOTHING is
 * written for a member whose fetch did not complete — the rows are accumulated
 * and only committed once the full result set is in hand. A genuine zero-result
 * fetch stays distinguishable as `verified-empty`, mirroring the Senate PTR
 * loader's source-backed empty semantics.
 *
 * Writes are additive (INSERT … ON CONFLICT DO NOTHING); there is no delete or
 * replace step, so pre-existing good rows for the target are never at risk.
 *
 * Source-first artifacts: pfd-cache/cosponsor-probe-2026-05-09/
 *
 * Usage: npx tsx db/load-cosponsored.ts [member-id]   (no arg = all members)
 */
import { readFileSync } from 'node:fs';
import type { DuckDBConnection } from '@duckdb/node-api';
import { getDb } from './init.js';
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

export interface CongressBillItem {
  congress: number;
  type: string;
  number: string | number;
  title?: string;
  introducedDate?: string;
  latestAction?: { text?: string };
}

/** One page of upstream results, plus the total upstream claims exists. */
export interface CosponsoredPage {
  items: CongressBillItem[];
  /** `pagination.count` from the API; undefined when upstream omits it. */
  totalCount?: number;
}

export type FetchPage = (bioguide: string, offset: number) => Promise<CosponsoredPage>;

/** Per-member outcome. Every member in scope gets exactly one of these — a
 *  member is never silently dropped from the report. */
export interface MemberResult {
  memberId: string;
  name: string;
  state: 'loaded' | 'verified-empty' | 'failed' | 'skipped';
  fetched: number;
  inserted: number;
  skipped: number;
  error?: string;
}

export interface CosponsoredResult {
  members: MemberResult[];
  totalInserted: number;
  errored: number;
  exitCode: number;
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

/** The live Congress.gov page fetcher. Injectable so tests never hit network. */
function httpFetchPage(pageSize: number): FetchPage {
  return async (bioguide, offset) => {
    const key = process.env.CONGRESS_API_KEY;
    const url = `https://api.congress.gov/v3/member/${bioguide}/cosponsored-legislation`
      + `?format=json&limit=${pageSize}&offset=${offset}&api_key=${key}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${bioguide} offset=${offset}`);
    const d = await r.json() as any;
    return {
      items: (d.cosponsoredLegislation ?? []) as CongressBillItem[],
      totalCount: d.pagination?.count,
    };
  };
}

/**
 * Paginate to completion, or throw.
 *
 * Completeness is decided by upstream's own `totalCount` when it supplies one:
 * a short page while rows remain is a TRUNCATED response, not end-of-results.
 * Previously that case broke the loop and returned a partial list that the
 * caller then wrote as authoritative.
 */
export async function fetchAllCosponsored(
  bioguide: string, fetchPage: FetchPage, pageSize = PAGE_SIZE,
): Promise<CongressBillItem[]> {
  const out: CongressBillItem[] = [];
  let offset = 0;
  let totalCount: number | undefined;

  while (true) {
    const page = await fetchPage(bioguide, offset);
    if (page.totalCount !== undefined) totalCount = page.totalCount;
    out.push(...page.items);

    if (totalCount !== undefined) {
      if (out.length >= totalCount) break;
      // Upstream says more rows exist but this page came back short — the
      // response was truncated. Refuse to treat it as the complete set.
      if (page.items.length === 0 || page.items.length < pageSize) {
        throw new Error(
          `incomplete result set for ${bioguide}: received ${out.length} of ${totalCount} rows `
          + `(short page of ${page.items.length} at offset=${offset})`);
      }
    } else if (page.items.length < pageSize) {
      // No count from upstream: a short page is the only end-of-results signal
      // available. Unchanged legacy behavior for this case.
      break;
    }

    offset += pageSize;
    await new Promise(r => setTimeout(r, 100)); // be polite
  }
  return out;
}

export interface LoadCosponsoredOpts {
  conn: DuckDBConnection;
  /** Injected page fetcher; defaults to the live Congress.gov API. */
  fetchPage?: FetchPage;
  pageSize?: number;
  /** Restrict to one member_id. Omitted = every member with a bioguide_id. */
  memberId?: string | null;
}

export async function loadCosponsored(opts: LoadCosponsoredOpts): Promise<CosponsoredResult> {
  const { conn, memberId = null } = opts;
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const fetchPage = opts.fetchPage ?? httpFetchPage(pageSize);

  const memberRows = await (await conn.run(
    memberId
      ? `SELECT member_id, bioguide_id, name FROM members WHERE member_id = ?`
      : `SELECT member_id, bioguide_id, name FROM members WHERE bioguide_id IS NOT NULL ORDER BY member_id`,
    memberId ? [memberId] : []
  )).getRowObjects() as any[];

  const fetchedAt = new Date().toISOString();
  const members: MemberResult[] = [];
  let totalInserted = 0;

  for (const m of memberRows) {
    const memberIdStr = String(m.member_id);
    const name = String(m.name ?? '');
    const bio = String(m.bioguide_id ?? '');

    if (!bio) {
      // Reported, never silently skipped: an unfetchable member is an
      // unfulfilled request, not a no-op.
      members.push({ memberId: memberIdStr, name, state: 'skipped', fetched: 0,
        inserted: 0, skipped: 0, error: 'no bioguide_id' });
      continue;
    }

    let bills: CongressBillItem[];
    try {
      bills = await fetchAllCosponsored(bio, fetchPage, pageSize);
    } catch (e) {
      // An incomplete or terminated fetch writes NOTHING for this member and is
      // reported as a failure. Pre-existing rows are untouched.
      members.push({ memberId: memberIdStr, name, state: 'failed', fetched: 0,
        inserted: 0, skipped: 0, error: (e as Error).message });
      continue;
    }

    if (bills.length === 0) {
      // A complete search that legitimately found nothing — corroborated empty,
      // not a silent skip and not a failure.
      members.push({ memberId: memberIdStr, name, state: 'verified-empty',
        fetched: 0, inserted: 0, skipped: 0 });
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
          [memberIdStr, billId]
        )).getRowObjects())[0] as any;

        await conn.run(
          `INSERT INTO bills (member_id, bill_id, title, status, sponsor_role, introduced_at, source_url, fetched_at)
           VALUES (?, ?, ?, ?, 'cosponsor', ?, ?, ?)
           ON CONFLICT (member_id, bill_id) DO NOTHING`,
          [memberIdStr, billId, title, status, introducedAt, sourceUrl, fetchedAt]
        );

        const after = (await (await conn.run(
          `SELECT count(*) AS n FROM bills WHERE member_id = ? AND bill_id = ?`,
          [memberIdStr, billId]
        )).getRowObjects())[0] as any;

        if (Number(after.n) > Number(before.n)) inserted++; else skipped++;
      }
      await conn.run('COMMIT');
    } catch (e) {
      await conn.run('ROLLBACK');
      members.push({ memberId: memberIdStr, name, state: 'failed', fetched: bills.length,
        inserted: 0, skipped: 0, error: `insert failed — ${(e as Error).message}` });
      continue;
    }

    totalInserted += inserted;
    members.push({ memberId: memberIdStr, name, state: 'loaded',
      fetched: bills.length, inserted, skipped });
  }

  const errored = members.filter(m => m.state === 'failed' || m.state === 'skipped').length;
  return { members, totalInserted, errored, exitCode: errored > 0 ? 1 : 0 };
}

async function main() {
  loadEnvOnce();
  if (!process.env.CONGRESS_API_KEY) {
    console.error('CONGRESS_API_KEY missing from CivicLens .env (' + ENV_PATH + ')');
    process.exit(1);
  }

  const conn = await getDb();
  const targetArg = process.argv[2] ?? null;
  const res = await loadCosponsored({ conn, memberId: targetArg });

  console.log(`Loading cosponsors for ${res.members.length} member(s)…\n`);
  for (const m of res.members) {
    switch (m.state) {
      case 'loaded':
        console.log(`  ${m.memberId} (${m.name}): ${m.fetched} fetched, ${m.inserted} inserted, ${m.skipped} dup/skipped`);
        break;
      case 'verified-empty':
        console.log(`  ${m.memberId} (${m.name}): verified-empty — complete search returned 0 cosponsorships`);
        break;
      case 'failed':
        console.error(`  ${m.memberId} (${m.name}): FAILED — ${m.error}`);
        break;
      case 'skipped':
        console.error(`  ${m.memberId} (${m.name}): SKIPPED — ${m.error}`);
        break;
    }
  }

  console.log(`\n${res.errored > 0 ? 'INCOMPLETE' : 'Done.'} ${res.totalInserted} cosponsor rows inserted, ${res.errored} member(s) not loaded.`);

  const total = (await (await conn.run(`SELECT sponsor_role, count(*) AS n FROM bills GROUP BY sponsor_role`)).getRowObjects()) as any[];
  console.log('Bills table now:', total.map(r => ({ ...r, n: Number(r.n) })));
  process.exit(res.exitCode);
}

// Only run the CLI when executed directly, so importing this module for tests
// has no side effects.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
