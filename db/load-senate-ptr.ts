/**
 * Senate PTR loader. Reads senate-ptr-cache/<year>/*.json (output of
 * skills/senate-ptr/fetch.ts) and upserts into pfd_transactions.
 *
 * Senate filings use the same pfd_transactions table as House filings.
 * source_url points to efdsearch.senate.gov instead of disclosures-clerk.house.gov.
 * filing_id is the EFDS UUID; tx_index is position within the filing.
 *
 * Usage:
 *   npx tsx db/load-senate-ptr.ts [--dry-run]
 *   npx tsx agents/pipeline.ts --load-senate-ptr [--dry-run]
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { applySchema, getDb } from './init.js';
import { SENATE_CACHE } from '../lib/paths.js';
import type { IngestScope } from '../lib/ingest-scope.js';

/** Injected deps: tests pass a temp conn + cache root; prod passes nothing. */
export interface SenateDeps {
  dryRun?: boolean;
  conn?: DuckDBConnection;
  cacheRoot?: string;
}

// ─── Member resolution ────────────────────────────────────────────────────────
// Senate filings have first + last name. Match by last name against members table
// (chamber=senate). Single match → confident; multiple → use first name to narrow.

interface Resolution {
  memberId: string | null;
  confidence: number;
  method: string;
}

async function resolveSenator(firstName: string, lastName: string, conn: DuckDBConnection): Promise<Resolution> {
  // Strip punctuation, then generational suffixes: EFDS filer lastName can be
  // "McConnell, Jr." which must resolve as "McConnell".
  const last = lastName.replace(/[^a-zA-Z\s]/g, '').trim()
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').trim();
  if (!last) return { memberId: null, confidence: 0, method: 'unmatched' };

  const r = await conn.run(
    `SELECT member_id, name FROM members
     WHERE chamber = 'senate' AND LOWER(name) LIKE '%' || LOWER(?) || '%'`,
    [last],
  );
  const rows = await r.getRowObjects() as any[];

  if (rows.length === 0) return { memberId: null, confidence: 0, method: 'unmatched' };
  if (rows.length === 1) return { memberId: String(rows[0].member_id), confidence: 1.0, method: 'exact_senate_lastname' };

  // Multiple — narrow by first name
  const fn = firstName.trim().toLowerCase();
  const matched = rows.filter((row: any) =>
    fn && String(row.name).toLowerCase().includes(fn.split(/\s+/)[0])
  );
  if (matched.length === 1) return { memberId: String(matched[0].member_id), confidence: 0.95, method: 'senate_firstname_lastname' };

  return { memberId: String(rows[0].member_id), confidence: 0.70, method: 'senate_lastname_ambiguous' };
}

// ─── Loader ───────────────────────────────────────────────────────────────────

interface FilerSummary {
  name: string;
  memberId: string | null;
  method: string;
  confidence: number;
  txCount: number;
}

export async function loadSenatePtrs(
  scope: IngestScope,
  deps: SenateDeps = {},
): Promise<{ filers: FilerSummary[]; totalTx: number; unmatched: number; targetMatched: number }> {
  const conn = deps.conn ?? (await getDb());
  if (!deps.conn) await applySchema();
  const cacheRoot = deps.cacheRoot ?? SENATE_CACHE;

  if (!existsSync(cacheRoot)) {
    throw new Error(`senate-ptr-cache not found at ${cacheRoot} — run skills/senate-ptr/fetch.ts first`);
  }

  const years = readdirSync(cacheRoot).filter(d => /^\d{4}$/.test(d)).sort();
  if (years.length === 0) throw new Error('No year directories in senate-ptr-cache');

  const fetchedAt = new Date().toISOString();
  const resolutionCache = new Map<string, Resolution>();
  const summaryMap = new Map<string, FilerSummary>();
  let totalTx = 0;
  let targetMatched = 0;

  for (const year of years) {
    const dir      = resolve(cacheRoot, year);
    const jsonFiles = readdirSync(dir).filter(f => f.endsWith('.json'));

    for (const f of jsonFiles) {
      let rec: any;
      try { rec = JSON.parse(readFileSync(resolve(dir, f), 'utf-8')); }
      catch { continue; }

      const firstName  = String(rec?.filer?.firstName ?? '');
      const lastName   = String(rec?.filer?.lastName  ?? '');
      const fullName   = `${firstName} ${lastName}`.trim();
      const filingId   = String(rec?.filingId ?? '');
      const ptrUrl     = String(rec?.ptrUrl ?? '');
      const txs: any[] = rec?.transactions ?? [];

      if (!filingId || !fullName || txs.length === 0) continue;

      const key = fullName.toLowerCase();
      let resolution = resolutionCache.get(key);
      if (!resolution) {
        resolution = await resolveSenator(firstName, lastName, conn);
        resolutionCache.set(key, resolution);
      }

      // Member scope: only the resolved target's filings reach DELETE/INSERT.
      // The cache is arranged by YEAR, not by senator, so we must filter per
      // filing — never write another senator merely because their file is in a
      // scanned year dir.
      const isTarget = scope.kind === 'all' || resolution.memberId === scope.memberId;

      const summary = summaryMap.get(key) ?? {
        name: fullName, memberId: resolution.memberId,
        method: resolution.method, confidence: resolution.confidence, txCount: 0,
      };
      if (isTarget) {
        summary.txCount += txs.length;
        totalTx += txs.length;
        targetMatched++;
      }
      summaryMap.set(key, summary);

      if (!isTarget || deps.dryRun) continue;

      await conn.run('BEGIN');
      try {
        await conn.run(`DELETE FROM pfd_transactions WHERE filing_id = ?`, [filingId]);

        let txIndex = 0;
        for (const tx of txs) {
          await conn.run(
            `INSERT OR REPLACE INTO pfd_transactions
             (filing_id, tx_index, filer_name, filer_state_district, member_id,
              holder, asset, ticker, asset_type, sub_account, location,
              tx_type, tx_date, notification_date, amount_band, filing_status,
              description, source_url, match_confidence, match_method, source_year, fetched_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              filingId, txIndex,
              fullName, null, resolution.memberId,
              tx.owner ?? null, tx.asset ?? null, tx.ticker ?? null, tx.assetType ?? null,
              null, null,
              tx.type ?? null, tx.transactionDate ?? null, null,
              tx.amountBand ?? null, 'New',
              tx.comment ?? null, ptrUrl,
              resolution.confidence, resolution.method,
              parseInt(year), fetchedAt,
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
  }

  const relevant = scope.kind === 'all'
    ? [...summaryMap.values()]
    : [...summaryMap.values()].filter(f => f.memberId === scope.memberId);
  const unmatched = relevant.filter(f => !f.memberId).length;
  return { filers: [...summaryMap.values()], totalTx, unmatched, targetMatched };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { parseScopeArgs, resolveScope } = await import('../lib/ingest-scope.js');
  const scope = await resolveScope(parseScopeArgs(process.argv.slice(2)));

  console.log(`Loading Senate PTRs${dryRun ? ' (dry-run)' : ''}…\n`);
  const { filers, totalTx, unmatched } = await loadSenatePtrs(scope, { dryRun });

  const nameW = Math.max(20, ...filers.map(f => f.name.length));
  const memberW = Math.max(20, ...filers.map(f => (f.memberId ?? 'unmatched').length));
  const line = '─'.repeat(nameW + memberW + 30);
  console.log(line);
  console.log(`${'Filer'.padEnd(nameW)}  ${'Member'.padEnd(memberW)}  Conf  Method              Tx`);
  console.log(line);
  for (const f of filers) {
    const conf   = f.confidence ? f.confidence.toFixed(2) : ' — ';
    const member = f.memberId ?? 'UNMATCHED';
    console.log(`${f.name.padEnd(nameW)}  ${member.padEnd(memberW)}  ${conf}  ${f.method.padEnd(20)}  ${f.txCount}`);
  }
  console.log(line);
  console.log(`Total: ${filers.length} filer(s), ${totalTx} transactions, ${unmatched} unmatched`);
  process.exit(unmatched > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
