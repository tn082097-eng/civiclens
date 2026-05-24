/**
 * Ticker → sector loader (SEC SIC). Deterministic, key-free.
 *
 * For each distinct ticker traded in `pfd_transactions`, resolve:
 *   1. ticker → CIK via SEC company_tickers.json (one fetch, cached)
 *   2. CIK → sic + sicDescription via SEC submissions API
 * then derive the 2-digit SIC major-group `sector` label.
 *
 * Only the distinct traded tickers are resolved (~108), so this is a short run.
 * ETFs / index funds without a single issuer simply won't resolve → left out.
 * See SOURCES.md "Relevance edge — Source B".
 *
 * Usage:
 *   npx tsx db/load-ticker-sectors.ts
 *   npx tsx db/load-ticker-sectors.ts --limit 20   # cap lookups per run
 *   npx tsx agents/pipeline.ts --load-ticker-sectors
 */

import { applySchema, getDb } from './init.js';

// SEC asks for a descriptive UA with contact. Reuses the project owner's email.
const UA = 'CivicLens research tn082097@gmail.com';
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

// SIC 2-digit major group → coarse sector label. Covers the division ranges
// from the SEC/OSHA SIC manual. This is the only mapping with judgment and it
// is a static, auditable table — no LLM. Granular SIC stays in sic_description.
function sicSector(sic: string | null): string | null {
  if (!sic) return null;
  const n = parseInt(sic.slice(0, 2), 10);
  if (Number.isNaN(n)) return null;
  if (n >= 1 && n <= 9)   return 'Agriculture, Forestry & Fishing';
  if (n >= 10 && n <= 14) return 'Mining & Extraction';
  if (n >= 15 && n <= 17) return 'Construction';
  if (n >= 20 && n <= 39) return 'Manufacturing';
  if (n >= 40 && n <= 49) return 'Transportation & Utilities';
  if (n >= 50 && n <= 51) return 'Wholesale Trade';
  if (n >= 52 && n <= 59) return 'Retail Trade';
  if (n >= 60 && n <= 67) return 'Finance, Insurance & Real Estate';
  if (n >= 70 && n <= 89) return 'Services';
  if (n >= 91 && n <= 99) return 'Public Administration';
  return null;
}

async function getJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function distinctTradedTickers(): Promise<string[]> {
  const conn = await getDb();
  const r = await conn.run(
    `SELECT DISTINCT UPPER(ticker) AS t FROM pfd_transactions
      WHERE ticker IS NOT NULL AND ticker <> '' ORDER BY t`,
  );
  return (await r.getRowObjects()).map((x: any) => String(x.t));
}

// ticker → zero-padded CIK from SEC's bulk file (single fetch).
async function loadTickerCikMap(): Promise<Map<string, string>> {
  const data = await getJson(TICKERS_URL);
  const map = new Map<string, string>();
  if (!data) return map;
  for (const v of Object.values<any>(data)) {
    if (!v?.ticker || v?.cik_str == null) continue;
    map.set(String(v.ticker).toUpperCase(), String(v.cik_str).padStart(10, '0'));
  }
  return map;
}

export async function loadTickerSectors(opts: { limit?: number } = {}): Promise<{ resolved: number; unresolved: string[]; total: number }> {
  await applySchema();
  const conn = await getDb();
  const tickers = await distinctTradedTickers();
  console.log(`${tickers.length} distinct traded tickers to resolve.`);

  const cikMap = await loadTickerCikMap();
  if (cikMap.size === 0) throw new Error('SEC company_tickers.json fetch failed — aborting.');
  console.log(`SEC ticker→CIK map: ${cikMap.size} entries.\n`);

  const fetchedAt = new Date().toISOString();
  const limit = opts.limit ?? Infinity;
  let resolved = 0, calls = 0;
  const unresolved: string[] = [];

  for (const ticker of tickers) {
    const cik = cikMap.get(ticker);
    if (!cik) { unresolved.push(ticker); continue; }
    if (calls >= limit) { unresolved.push(ticker); continue; }

    const sub = await getJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
    calls++;
    await new Promise(r => setTimeout(r, 110)); // SEC ~10 req/s

    if (!sub) { unresolved.push(ticker); continue; }
    const sic = sub.sic ? String(sub.sic) : null;
    const sicDesc = sub.sicDescription ? String(sub.sicDescription) : null;
    const sector = sicSector(sic);

    await conn.run(
      `INSERT OR REPLACE INTO ticker_sectors
       (ticker, cik, sic, sic_description, sector, source_url, fetched_at)
       VALUES (?,?,?,?,?,?,?)`,
      [ticker, cik, sic, sicDesc, sector,
       `https://data.sec.gov/submissions/CIK${cik}.json`, fetchedAt],
    );
    resolved++;
    if (resolved % 25 === 0) console.log(`  …${resolved} resolved`);
  }

  console.log(`\nDone: ${resolved} resolved, ${unresolved.length} unresolved (no CIK / ETF / fetch fail) of ${tickers.length}.`);
  if (unresolved.length) console.log(`  unresolved: ${unresolved.slice(0, 40).join(', ')}${unresolved.length > 40 ? ' …' : ''}`);
  return { resolved, unresolved, total: tickers.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const li = process.argv.indexOf('--limit');
  const limit = li >= 0 ? parseInt(process.argv[li + 1], 10) : undefined;
  loadTickerSectors({ limit })
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}
