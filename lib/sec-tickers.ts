/**
 * SEC company_tickers.json universe (~8k issuers). TRAP: the SEC returns 403
 * without a User-Agent header (SOURCES.md §USAspending / SEC ticker universe).
 * Cached to data/caches/sec-cache/company_tickers.json; the cache is the
 * frozen source of record — refetch only with force.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEC_CACHE } from './paths.js';
import type { SecRow } from './recipient-match.js';

const URL = 'https://www.sec.gov/files/company_tickers.json';
const UA = 'CivicLens research tn082097@gmail.com';

export async function fetchSecTickers(opts: { force?: boolean } = {}): Promise<SecRow[]> {
  const cachePath = join(SEC_CACHE, 'company_tickers.json');
  if (!opts.force && existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  }
  const res = await fetch(URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`SEC company_tickers ${res.status} — User-Agent header present?`);
  const raw = await res.json() as Record<string, { cik_str: number; ticker: string; title: string }>;
  const rows: SecRow[] = Object.values(raw).map((r) => ({ ticker: r.ticker, title: r.title }));
  if (rows.length < 5000) throw new Error(`SEC universe suspiciously small (${rows.length}) — refusing to cache`);
  mkdirSync(SEC_CACHE, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(rows));
  return rows;
}
