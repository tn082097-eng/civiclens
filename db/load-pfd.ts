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
import { z } from 'zod';
import type { DuckDBConnection } from '@duckdb/node-api';
import { applySchema, getDb } from './init.js';
import { PFD_CACHE as PFD_CACHE_ROOT } from '../lib/paths.js';
import type { IngestScope } from '../lib/ingest-scope.js';

// ─── Validation ─────────────────────────────────────────────────────────────
//
// Runtime gate between the extractor and pfd_transactions. Extraction itself is
// unchanged — this only decides what is allowed to reach production.
//
// Three outcomes per field/row, and they are NOT interchangeable:
//   verified   — present and valid; eligible for insertion
//   unresolved — required value absent (the OCR abstention case)
//   rejected   — value present but invalid (bad date, unknown type, bad band)
//
// "unresolved" exists because a scanned-PTR pipeline must be able to say "I
// could not read this" without that becoming a silent '' or a plausible guess.
// Neither unresolved nor rejected rows are ever inserted. See
// `NoService/Projects/CivicLens/2026-08-21 OCR session reconciliation.md` §7.
//
// Calibration: every rule below was checked against all 4,848 transactions in
// the current cache (285 files). All 4,848 pass. This gate rejects no data that
// is good today — it only blocks new failure modes.

export type FieldState = 'verified' | 'unresolved' | 'rejected';

/** Transaction types observed in the corpus. Anything else is `rejected`. */
export const TX_TYPES = ['purchase', 'sale', 'sale-partial', 'exchange'] as const;

const MIN_TX_YEAR = 2012;

/**
 * Strict ISO date that is also a real calendar date.
 *
 * The regex alone is not enough: `2025-02-30` and `2025-09-31` match
 * `\d{4}-\d{2}-\d{2}` but do not exist. A wrong-but-well-formed date is exactly
 * the silent-corruption class this gate exists to stop, so the round-trip check
 * through Date is load-bearing, not belt-and-braces.
 */
function isRealIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const IsoDate = z.string().refine(isRealIsoDate, 'not a real calendar date (YYYY-MM-DD)');

/** `$1,001 - $15,000`, or a single `$5,000,000`. Range must be ordered. */
const AMOUNT_BAND_RE = /^\$([\d,]+)(?:\s*-\s*\$([\d,]+))?$/;

function isValidAmountBand(s: string): boolean {
  const m = s.match(AMOUNT_BAND_RE);
  if (!m) return false;
  const low = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(low) || low < 0) return false;
  if (m[2] === undefined) return true;
  const high = Number(m[2].replace(/,/g, ''));
  return Number.isFinite(high) && high >= low;
}

/**
 * A transaction that is allowed into pfd_transactions.
 *
 * Fields the public record requires (`date`, `notificationDate`, `type`,
 * `asset`, `holder`, `amountBand`) are mandatory here. Genuinely optional
 * metadata (`ticker`, `location`, …) stays nullable and is not gated.
 */
export const PfdTransactionSchema = z.object({
  holder:           z.string().trim().min(1),
  asset:            z.string().trim().min(1),
  type:             z.enum(TX_TYPES),
  date:             IsoDate,
  notificationDate: IsoDate,
  amountBand:       z.string().refine(isValidAmountBand, 'unrecognised amount band'),
}).passthrough().superRefine((tx, ctx) => {
  // Cross-field invariants. Both hold for 4,848/4,848 current rows.
  if (tx.notificationDate < tx.date) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['notificationDate'],
      message: `notificationDate ${tx.notificationDate} precedes date ${tx.date}` });
  }
  const yr = Number(tx.date.slice(0, 4));
  if (yr < MIN_TX_YEAR || yr > new Date().getUTCFullYear() + 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['date'],
      message: `transaction year ${yr} outside plausible range` });
  }
});

/** Filing identity. A filing without these cannot be attributed to anyone. */
export const PfdFilingIdentitySchema = z.object({
  filingId:  z.string().trim().min(1),
  filerName: z.string().trim().min(1),
});

export interface TxVerdict {
  index: number;
  state: FieldState;
  /** Field paths that failed, for the operator-facing report. */
  problems: string[];
}

export interface FilingVerdict {
  state: FieldState;
  verdicts: TxVerdict[];
  problems: string[];
}

/**
 * Classify one transaction.
 *
 * A required field that is absent/blank is `unresolved` (nothing was read); a
 * field that is present but wrong is `rejected` (something was read and it is
 * not valid). Both are withheld from production; the distinction is what lets
 * an operator tell "OCR abstained" from "OCR produced garbage".
 */
export function classifyTransaction(tx: any, index: number): TxVerdict {
  const REQUIRED = ['holder', 'asset', 'type', 'date', 'notificationDate', 'amountBand'] as const;
  const missing = REQUIRED.filter(k => {
    const v = tx?.[k];
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  });
  if (missing.length > 0) {
    return { index, state: 'unresolved', problems: missing.map(k => `${k}: unresolved (absent or blank)`) };
  }
  const parsed = PfdTransactionSchema.safeParse(tx);
  if (!parsed.success) {
    return {
      index,
      state: 'rejected',
      problems: parsed.error.issues.map(i => `${i.path.join('.') || '(row)'}: ${i.message}`),
    };
  }
  return { index, state: 'verified', problems: [] };
}

/**
 * Classify a whole filing. All-or-nothing.
 *
 * A filing is `verified` only if EVERY transaction in it is verified. One bad
 * row withholds the entire filing, because a partially-loaded filing
 * misrepresents the disclosure record: the missing rows are indistinguishable
 * from trades that never happened. Same misleading-by-omission reasoning that
 * blocks publishing the 14% landscape slice.
 */
export function classifyFiling(rec: any): FilingVerdict {
  const identity = PfdFilingIdentitySchema.safeParse({
    filingId:  String(rec?.filingId ?? ''),
    filerName: String(rec?.filer?.name ?? ''),
  });
  if (!identity.success) {
    return {
      state: 'unresolved',
      verdicts: [],
      problems: identity.error.issues.map(i => `${i.path.join('.')}: unresolved (absent or blank)`),
    };
  }
  const txs: any[] = Array.isArray(rec?.transactions) ? rec.transactions : [];
  const verdicts = txs.map((tx, i) => classifyTransaction(tx, i));
  const rejected = verdicts.filter(v => v.state === 'rejected');
  const unresolved = verdicts.filter(v => v.state === 'unresolved');
  const problems = [...rejected, ...unresolved].flatMap(v => v.problems.map(p => `tx[${v.index}] ${p}`));
  if (rejected.length > 0)   return { state: 'rejected',   verdicts, problems };
  if (unresolved.length > 0) return { state: 'unresolved', verdicts, problems };
  return { state: 'verified', verdicts, problems: [] };
}

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

/** One filing withheld from production, with the reason. */
export interface WithheldFiling {
  filingId: string;
  filerName: string;
  state: 'unresolved' | 'rejected';
  problems: string[];
}

export async function loadPfdYear(
  year: number,
  scope: IngestScope,
  deps: PfdDeps = {},
): Promise<{
  filers: FilerSummary[];
  totalTx: number;
  unmatched: number;
  targetMatched: number;
  withheld: WithheldFiling[];
}> {
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
  const withheld: WithheldFiling[] = [];
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

    // ── Production gate ────────────────────────────────────────────────────
    // Validate BEFORE the DELETE. This ordering is the whole point: the DELETE
    // below is destructive, and an extraction that is empty, partial,
    // unresolved, or invalid must never be the thing that triggers it.
    //
    // Same asymmetry the FEC-IE loader settled (db/load-fec-ie.ts:148) — a
    // stale row set is visibly dated via fetched_at and self-heals on the next
    // good load; a deleted one is gone silently. So: gate the DELETE on the new
    // data actually being good, and preserve on anything less.
    const verdict = classifyFiling(rec);
    if (verdict.state !== 'verified') {
      withheld.push({
        filingId, filerName,
        state: verdict.state === 'rejected' ? 'rejected' : 'unresolved',
        problems: verdict.problems,
      });
      console.warn(
        `  ⚠ ${f} [${verdict.state}] → withheld, existing rows preserved` +
        (verdict.problems.length ? `: ${verdict.problems.slice(0, 3).join('; ')}` : ''),
      );
      continue;
    }

    // Wipe + reinsert all transactions for this filing. Cheaper than a
    // diff-and-update and matches the "latest fetch wins" semantics used
    // elsewhere in the schema. Transactional so a mid-write failure can't
    // leave the target's filing half-written (empty).
    //
    // Reached only when every transaction in this filing is `verified`, so the
    // replacement is always whole-for-whole, never good-for-partial.
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
  return { filers: [...summaryByKey.values()], totalTx, unmatched, targetMatched, withheld };
}

// ─── Pretty summary printer ─────────────────────────────────────────────────

function pad(s: string, w: number): string {
  if (s.length >= w) return s;
  return s + ' '.repeat(w - s.length);
}

export function printSummary(
  result: { filers: FilerSummary[]; totalTx: number; unmatched: number; withheld?: WithheldFiling[] },
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
  console.log(`Total: ${filers.length} filers, ${filings} filings, ${totalTx} transactions, ${unmatched} unmatched${mode}`);

  // Withheld filings are reported, never silently dropped — an operator has to
  // be able to see that a filing did not load and why.
  const withheld = result.withheld ?? [];
  if (withheld.length > 0) {
    const unresolved = withheld.filter(w => w.state === 'unresolved').length;
    const rejected   = withheld.filter(w => w.state === 'rejected').length;
    console.log(
      `Withheld from production: ${withheld.length} filing(s) — ` +
      `${unresolved} unresolved, ${rejected} rejected. Existing rows preserved.`,
    );
    for (const w of withheld) {
      console.log(`  · ${w.filingId} (${w.filerName}) [${w.state}]`);
      for (const p of w.problems.slice(0, 5)) console.log(`      ${p}`);
      if (w.problems.length > 5) console.log(`      … ${w.problems.length - 5} more`);
    }
  }
  console.log('');
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
): Promise<{ totalTx: number; totalUnmatched: number; totalWithheld: number }> {
  let totalTx = 0;
  let totalUnmatched = 0;
  let totalWithheld = 0;
  for (const year of years) {
    console.log(`\nLoading PFDs for ${year}${deps.dryRun ? ' (dry-run)' : ''}…`);
    const result = await loadPfdYear(year, scope, deps);
    printSummary(result, { dryRun: deps.dryRun });
    totalTx += result.totalTx;
    totalUnmatched += result.unmatched;
    totalWithheld += result.withheld.length;
  }
  if (years.length > 1) {
    console.log(
      `\nGrand total across ${years.length} years: ${totalTx} transactions, ` +
      `${totalUnmatched} unmatched, ${totalWithheld} filings withheld.\n`,
    );
  }
  return { totalTx, totalUnmatched, totalWithheld };
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
