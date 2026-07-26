/**
 * PFD ingestion loader. Reads pfd-cache/<year>/*.json (output of
 * skills/pfd-fetcher/extract.ts) and upserts into pfd_transactions, with
 * filer-to-member resolution captured on each row.
 *
 * Usage:
 *   npx tsx db/load-pfd.ts --year 2024
 *   npx tsx db/load-pfd.ts --year 2024 --dry-run
 *   npx tsx agents/pipeline.ts --load-pfd 2024 [--dry-run]
 *
 * Exit codes: 0 if all filers matched a member; 1 if any unmatched (so cron
 * picks it up). Schema additions (match_confidence, match_method, source_year)
 * live in db/schema.sql alongside the table definition.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { applySchema, getDb } from './init.js';
import { PFD_CACHE as PFD_CACHE_ROOT } from '../lib/paths.js';
import type { IngestScope } from '../lib/ingest-scope.js';

/** Injected dependencies (tests pass a temp conn + cache root; prod passes nothing). */
export interface PfdDeps {
  dryRun?: boolean;
  conn?: DuckDBConnection;
  cacheRoot?: string;
}

// ─── Filer-to-member resolution ─────────────────────────────────────────────

const TITLE_RE = /\b(Hon|Mr|Mrs|Ms|Dr|Sen|Rep|Senator|Representative)\.?\b/gi;

interface Resolution {
  memberId: string | null;
  confidence: number | null;
  method: 'exact_state_lastname' | 'state_district_lastname' | 'state_lastname_ambiguous' | 'unmatched' | 'manual';
}

function stripTitles(name: string): string {
  return name.replace(TITLE_RE, '').replace(/\s+/g, ' ').trim();
}

function parseStateDistrict(sd: string | undefined | null): { state: string | null; district: string | null } {
  if (!sd) return { state: null, district: null };
  const m = sd.match(/^([A-Z]{2})(\d{0,3})$/);
  if (!m) return { state: null, district: null };
  return { state: m[1], district: m[2] || null };
}

function lastNameOf(filerName: string): string | null {
  const stripped = stripTitles(filerName);
  if (!stripped) return null;
  const parts = stripped.split(/\s+/).filter(Boolean);
  // Drop generational suffixes so "Donald Sternoff Beyer Jr" → "Beyer".
  while (parts.length > 1 && /^(jr|sr|ii|iii|iv|v)\.?,?$/i.test(parts[parts.length - 1])) {
    parts.pop();
  }
  if (parts.length === 0) return null;
  return parts[parts.length - 1];
}

async function resolveFiler(
  filerName: string,
  stateDistrict: string | undefined | null,
  conn: DuckDBConnection,
): Promise<Resolution> {
  const { state, district } = parseStateDistrict(stateDistrict);
  const lastName = lastNameOf(filerName);
  if (!state || !lastName) {
    return { memberId: null, confidence: null, method: 'unmatched' };
  }

  const r = await conn.run(
    `SELECT member_id, district FROM members
     WHERE state = ? AND LOWER(name) LIKE '%' || LOWER(?) || '%'`,
    [state, lastName],
  );
  const rows = await r.getRowObjects() as any[];

  if (rows.length === 1) {
    return { memberId: String(rows[0].member_id), confidence: 1.0, method: 'exact_state_lastname' };
  }
  if (rows.length === 0) {
    return { memberId: null, confidence: null, method: 'unmatched' };
  }

  // Multiple — try district as tiebreaker.
  if (district) {
    const tied = rows.filter((row: any) => row.district === district);
    if (tied.length === 1) {
      return { memberId: String(tied[0].member_id), confidence: 0.95, method: 'state_district_lastname' };
    }
  }
  return { memberId: String(rows[0].member_id), confidence: 0.70, method: 'state_lastname_ambiguous' };
}

// ─── Loader ─────────────────────────────────────────────────────────────────

interface FilerSummary {
  filerName: string;
  stateDistrict: string;
  resolution: Resolution;
  filingCount: number;
  txCount: number;
}

export async function loadPfdYear(
  year: number,
  scope: IngestScope,
  deps: PfdDeps = {},
): Promise<{ filers: FilerSummary[]; totalTx: number; unmatched: number; targetMatched: number }> {
  const conn = deps.conn ?? (await getDb());
  if (!deps.conn) await applySchema();
  const cacheRoot = deps.cacheRoot ?? PFD_CACHE_ROOT;
  const dir = resolve(cacheRoot, String(year));
  if (!existsSync(dir)) {
    throw new Error(`pfd-cache/${year} not found at ${dir}`);
  }

  const jsonFiles = readdirSync(dir).filter(f => f.endsWith('.json'));
  if (jsonFiles.length === 0) {
    throw new Error(`no *.json files in ${dir} — did you run extract.ts?`);
  }

  // Memoise resolution per (filerName + stateDistrict) — same filer files
  // multiple PTRs in a year, but should only resolve once.
  const resolutionByKey = new Map<string, Resolution>();
  const summaryByKey = new Map<string, FilerSummary>();
  const fetchedAt = new Date().toISOString();
  let totalTx = 0;
  let targetMatched = 0; // filings whose resolved member == the member-scope target

  for (const f of jsonFiles) {
    const fp = resolve(dir, f);
    let rec: any;
    try {
      rec = JSON.parse(readFileSync(fp, 'utf-8'));
    } catch (e: any) {
      console.warn(`  ! skipping malformed ${f}: ${e.message}`);
      continue;
    }
    const filer = rec?.filer ?? {};
    const filerName = String(filer.name ?? '');
    const stateDistrict = String(filer.stateDistrict ?? '');
    const filingId = String(rec?.filingId ?? '');
    const txs: any[] = rec?.transactions ?? [];
    if (!filingId || !filerName || txs.length === 0) {
      // Empty filings are valid PFDs (filer's spouse income only); silent skip.
      continue;
    }

    const key = `${filerName}|${stateDistrict}`;
    let resolution = resolutionByKey.get(key);
    if (!resolution) {
      resolution = await resolveFiler(filerName, stateDistrict, conn);
      resolutionByKey.set(key, resolution);
    }

    // Member scope: metadata may be inspected for every filing (resolution is
    // cheap + memoised), but only filings resolving to the target reach the
    // DELETE/INSERT below. Unrelated / unmatched filers never touch the DB and
    // never fail the run.
    const isTarget = scope.kind === 'all' || resolution.memberId === scope.memberId;

    const summary = summaryByKey.get(key) ?? {
      filerName, stateDistrict, resolution, filingCount: 0, txCount: 0,
    };
    summary.filingCount++;
    if (isTarget) {
      summary.txCount += txs.length;
      totalTx += txs.length;
      targetMatched++;
    }
    summaryByKey.set(key, summary);

    if (!isTarget || deps.dryRun) continue;

    // Wipe + reinsert all transactions for this filing. Cheaper than a
    // diff-and-update and matches the "latest fetch wins" semantics used
    // elsewhere in the schema. Transactional so a mid-write failure can't
    // leave the target's filing half-written (empty).
    await conn.run('BEGIN');
    try {
      await conn.run(`DELETE FROM pfd_transactions WHERE filing_id = ?`, [filingId]);

      let txIndex = 0;
      for (const tx of txs) {
        const sourceUrl = `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${filingId}.pdf`;
        await conn.run(
          `INSERT OR REPLACE INTO pfd_transactions
           (filing_id, tx_index, filer_name, filer_state_district, member_id,
            holder, asset, ticker, asset_type, sub_account, location,
            tx_type, tx_date, notification_date, amount_band, filing_status,
            description, source_url,
            match_confidence, match_method, source_year, fetched_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            filingId, txIndex,
            filerName, stateDistrict, resolution.memberId,
            tx.holder ?? null, tx.asset ?? null, tx.ticker ?? null, tx.assetType ?? null,
            tx.subholding ?? null, tx.location ?? null,
            tx.type ?? null, tx.date ?? null, tx.notificationDate ?? null,
            tx.amountBand ?? null, tx.filingStatus ?? null,
            tx.description ?? null, sourceUrl,
            resolution.confidence, resolution.method, year, fetchedAt,
          ],
        );
        txIndex++;
      }
      await conn.run('COMMIT');
    } catch (e) {
      await conn.run('ROLLBACK');
      throw e;
    }
  }

  // Only target-eligible filers count toward "unmatched": in member mode the
  // target's own filings are always matched (else there'd be no target), so a
  // clean member run reports 0 unmatched regardless of unrelated filers.
  const relevant = scope.kind === 'all'
    ? [...summaryByKey.values()]
    : [...summaryByKey.values()].filter(f => f.resolution.memberId === scope.memberId);
  const unmatched = relevant.filter(f => f.resolution.memberId === null).length;
  return { filers: [...summaryByKey.values()], totalTx, unmatched, targetMatched };
}

// ─── Pretty summary printer ─────────────────────────────────────────────────

function pad(s: string, w: number): string {
  if (s.length >= w) return s;
  return s + ' '.repeat(w - s.length);
}

export function printSummary(
  result: { filers: FilerSummary[]; totalTx: number; unmatched: number },
  opts: { dryRun?: boolean } = {},
): void {
  const { filers, totalTx, unmatched } = result;
  const sorted = filers.slice().sort((a, b) => b.txCount - a.txCount);

  const filerW = Math.max(28, ...sorted.map(f => `${f.filerName} (${f.stateDistrict})`.length));
  const memberW = Math.max(20, ...sorted.map(f => (f.resolution.memberId ?? '—').length));
  const methodW = Math.max(20, ...sorted.map(f => f.resolution.method.length));

  const sep = '─'.repeat(filerW + memberW + methodW + 16);
  console.log(`\n${pad('Filer', filerW)} ${pad('Member', memberW)} Conf  ${pad('Method', methodW)} Tx`);
  console.log(sep);
  for (const f of sorted) {
    const filerLabel = `${f.filerName} (${f.stateDistrict})`;
    const member     = f.resolution.memberId ?? '—';
    const conf       = f.resolution.confidence === null ? ' —  ' : f.resolution.confidence.toFixed(2);
    console.log(
      `${pad(filerLabel, filerW)} ${pad(member, memberW)} ${conf}  ${pad(f.resolution.method, methodW)} ${String(f.txCount).padStart(3)}`,
    );
  }
  console.log(sep);
  const filings = filers.reduce((s, f) => s + f.filingCount, 0);
  const mode = opts.dryRun ? ' (dry-run — DB unchanged)' : '';
  console.log(`Total: ${filers.length} filers, ${filings} filings, ${totalTx} transactions, ${unmatched} unmatched${mode}\n`);
}

// ─── CLI ────────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): { years: number[]; dryRun: boolean } {
  let years: number[] = [];
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--year' || a === '--years') {
      const v = argv[++i] ?? '';
      years = v.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (/^\d{4}(?:,\d{4})*$/.test(a) && years.length === 0) {
      years = a.split(',').map(s => parseInt(s.trim(), 10));
    }
  }
  if (years.length === 0) {
    throw new Error('Usage: load-pfd.ts --years <YYYY[,YYYY,...]> (--member <slug>|--bioguide <id>|--all) [--dry-run]');
  }
  return { years, dryRun };
}

export async function loadPfdYears(
  years: number[],
  scope: IngestScope,
  deps: PfdDeps = {},
): Promise<{ totalTx: number; totalUnmatched: number }> {
  let totalTx = 0;
  let totalUnmatched = 0;
  for (const year of years) {
    console.log(`\nLoading PFDs for ${year}${deps.dryRun ? ' (dry-run)' : ''}…`);
    const result = await loadPfdYear(year, scope, deps);
    printSummary(result, { dryRun: deps.dryRun });
    totalTx += result.totalTx;
    totalUnmatched += result.unmatched;
  }
  if (years.length > 1) {
    console.log(`\nGrand total across ${years.length} years: ${totalTx} transactions, ${totalUnmatched} unmatched.\n`);
  }
  return { totalTx, totalUnmatched };
}

async function main() {
  const { parseScopeArgs, resolveScope } = await import('../lib/ingest-scope.js');
  const { years, dryRun } = parseArgs(process.argv.slice(2));
  const scope = await resolveScope(parseScopeArgs(process.argv.slice(2)));
  const { totalUnmatched } = await loadPfdYears(years, scope, { dryRun });
  process.exit(totalUnmatched > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(2); });
}
