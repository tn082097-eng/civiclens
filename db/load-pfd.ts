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
import { applySchema, getDb } from './init.js';
import { PFD_CACHE as PFD_CACHE_ROOT } from '../lib/paths.js';

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
  if (parts.length === 0) return null;
  return parts[parts.length - 1];
}

async function resolveFiler(
  filerName: string,
  stateDistrict: string | undefined | null,
): Promise<Resolution> {
  const conn = await getDb();
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
  opts: { dryRun?: boolean } = {},
): Promise<{ filers: FilerSummary[]; totalTx: number; unmatched: number }> {
  await applySchema();
  const conn = await getDb();
  const dir = resolve(PFD_CACHE_ROOT, String(year));
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
      resolution = await resolveFiler(filerName, stateDistrict);
      resolutionByKey.set(key, resolution);
    }

    const summary = summaryByKey.get(key) ?? {
      filerName, stateDistrict, resolution, filingCount: 0, txCount: 0,
    };
    summary.filingCount++;
    summary.txCount += txs.length;
    summaryByKey.set(key, summary);
    totalTx += txs.length;

    if (opts.dryRun) continue;

    // Wipe + reinsert all transactions for this filing. Cheaper than a
    // diff-and-update and matches the "latest fetch wins" semantics used
    // elsewhere in the schema.
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
  }

  const filers = [...summaryByKey.values()];
  const unmatched = filers.filter(f => f.resolution.memberId === null).length;
  return { filers, totalTx, unmatched };
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
    throw new Error('Usage: load-pfd.ts --years <YYYY[,YYYY,...]> [--dry-run]');
  }
  return { years, dryRun };
}

export async function loadPfdYears(
  years: number[],
  opts: { dryRun?: boolean } = {},
): Promise<{ totalTx: number; totalUnmatched: number }> {
  let totalTx = 0;
  let totalUnmatched = 0;
  for (const year of years) {
    console.log(`\nLoading PFDs for ${year}${opts.dryRun ? ' (dry-run)' : ''}…`);
    const result = await loadPfdYear(year, opts);
    printSummary(result, opts);
    totalTx += result.totalTx;
    totalUnmatched += result.unmatched;
  }
  if (years.length > 1) {
    console.log(`\nGrand total across ${years.length} years: ${totalTx} transactions, ${totalUnmatched} unmatched.\n`);
  }
  return { totalTx, totalUnmatched };
}

async function main() {
  const { years, dryRun } = parseArgs(process.argv.slice(2));
  const { totalUnmatched } = await loadPfdYears(years, { dryRun });
  process.exit(totalUnmatched > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(2); });
}
