/**
 * Senate EFDS PTR Fetcher
 *
 * Fetches Periodic Transaction Reports for US Senators from:
 *   https://efdsearch.senate.gov
 *
 * Flow:
 *   1. GET /search/home/ → extract CSRF token
 *   2. POST disclaimer agreement → session cookie
 *   3. POST /search/report/data/ → paginate PTR index for senator
 *   4. GET /search/view/ptr/{id}/ → parse HTML transaction table
 *   5. Write JSON to senate-ptr-cache/<year>/<slug>-<id>.json
 *
 * Usage:
 *   npx tsx skills/senate-ptr/fetch.ts --name "Susan Collins"
 *   npx tsx skills/senate-ptr/fetch.ts --names names.txt [--from-year 2022] [--to-year 2026]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT      = resolve(__dirname, '..', '..');
const CACHE_DIR = resolve(ROOT, 'senate-ptr-cache');
const UA        = 'CivicLens/1.0 (public interest research; civiclens.org)';
const BASE      = 'https://efdsearch.senate.gov';
const DELAY_MS  = 1500;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SenateTransaction {
  transactionDate: string;
  owner: string;             // self | spouse | dependent-child | joint
  ticker: string | null;
  asset: string;
  assetType: string | null;
  type: string;              // purchase | sale | sale-partial | exchange
  amountBand: string;
  comment: string;
}

export interface SenatePTR {
  filingId: string;
  source: 'senate-efds-ptr';
  filer: { firstName: string; lastName: string };
  dateReceived: string;
  ptrUrl: string;
  transactions: SenateTransaction[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function usToIso(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
}

function normalizeOwner(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s.includes('spouse'))    return 'spouse';
  if (s.includes('dependent')) return 'dependent-child';
  if (s.includes('joint'))     return 'joint';
  return 'self';
}

function normalizeTxType(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s.includes('partial'))  return 'sale-partial';
  if (s.includes('sale'))     return 'sale';
  if (s.includes('purchase')) return 'purchase';
  if (s.includes('exchange')) return 'exchange';
  return s;
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .trim();
}

// ─── Session ──────────────────────────────────────────────────────────────────

interface Session { csrfToken: string; cookie: string; }

async function getSession(): Promise<Session> {
  const r1 = await fetch(`${BASE}/search/home/`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r1.ok) throw new Error(`home page: HTTP ${r1.status}`);
  const html1 = await r1.text();
  const csrf1 = html1.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/)?.[1];
  if (!csrf1) throw new Error('CSRF token not found on home page');
  const setCookie1 = r1.headers.get('set-cookie') ?? '';
  const csrfCookie = setCookie1.match(/csrftoken=([^;]+)/)?.[1] ?? csrf1;

  const body = new URLSearchParams({
    csrfmiddlewaretoken: csrf1,
    prohibition_agreement: '1',
  });
  const r2 = await fetch(`${BASE}/search/home/`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': `${BASE}/search/home/`,
      'Cookie': `csrftoken=${csrfCookie}`,
    },
    body: body.toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  const setCookie2 = r2.headers.get('set-cookie') ?? '';
  const sessionId  = setCookie2.match(/sessionid=([^;]+)/)?.[1] ?? '';
  const csrfFinal  = setCookie2.match(/csrftoken=([^;]+)/)?.[1] ?? csrfCookie;

  return {
    csrfToken: csrfFinal,
    cookie: `csrftoken=${csrfFinal}${sessionId ? `; sessionid=${sessionId}` : ''}`,
  };
}

// ─── Search ───────────────────────────────────────────────────────────────────

interface PtrRef { id: string; firstName: string; lastName: string; dateReceived: string; }

async function searchPtrs(
  session: Session,
  firstName: string,
  lastName: string,
  fromDate: string,
  toDate: string,
): Promise<PtrRef[]> {
  const results: PtrRef[] = [];
  let start = 0;

  while (true) {
    const body = new URLSearchParams({
      start: String(start),
      length: '100',
      submitted_start_date: fromDate,
      submitted_end_date: toDate,
      first_name: firstName,
      last_name: lastName,
      senator_state: '',
      csrfmiddlewaretoken: session.csrfToken,
    });
    // Array params need to be appended separately
    body.append('report_types[]', '11');
    body.append('filer_types[]', '1');

    const r = await fetch(`${BASE}/search/report/data/`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `${BASE}/search/home/`,
        'Cookie': session.cookie,
        'X-CSRFToken': session.csrfToken,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`search: HTTP ${r.status}`);
    const d = await r.json() as any;
    if (d.result !== 'ok') throw new Error(`search: ${JSON.stringify(d)}`);

    const rows: any[][] = d.data ?? [];
    if (rows.length === 0) break;

    for (const row of rows) {
      // Response columns: [firstName, lastName, office, linkHtml, dateReceived]
      // Find the column that contains a PTR link (search all columns)
      let linkHtml = '';
      let dateRaw  = '';
      for (let i = 0; i < row.length; i++) {
        const cell = String(row[i] ?? '');
        if (cell.includes('/search/view/ptr/')) linkHtml = cell;
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(cell.trim())) dateRaw = cell.trim();
      }
      const idMatch = linkHtml.match(/\/search\/view\/ptr\/([a-f0-9-]{36})\//i);
      if (!idMatch) continue;
      // dateReceived may also be the last column
      if (!dateRaw) dateRaw = String(row[row.length - 1] ?? '');
      results.push({
        id:           idMatch[1],
        firstName:    stripHtml(String(row[0] ?? '')),
        lastName:     stripHtml(String(row[1] ?? '')),
        dateReceived: usToIso(dateRaw) ?? dateRaw,
      });
    }

    if (rows.length < 100) break;
    start += 100;
    await sleep(DELAY_MS);
  }

  return results;
}

// ─── Parse PTR HTML ───────────────────────────────────────────────────────────

async function fetchPtr(session: Session, ptrId: string): Promise<SenateTransaction[]> {
  const url = `${BASE}/search/view/ptr/${ptrId}/`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Referer': `${BASE}/search/home/`,
      'Cookie': session.cookie,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`PTR fetch: HTTP ${r.status}`);
  const html = await r.text();

  const transactions: SenateTransaction[] = [];
  const rowRe  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const cells: string[] = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(stripHtml(cellMatch[1]).replace(/\s+/g, ' ').trim());
    }
    // Need at least 8 cells and a parseable date in cell[1]
    if (cells.length < 8) continue;
    const date = usToIso(cells[1]);
    if (!date) continue;

    const ticker = cells[3] && !['--','n/a',''].includes(cells[3].toLowerCase())
      ? cells[3] : null;

    transactions.push({
      transactionDate: date,
      owner:      normalizeOwner(cells[2]),
      ticker,
      asset:      cells[4] || 'Unknown',
      assetType:  cells[5] || null,
      type:       normalizeTxType(cells[6]),
      amountBand: cells[7] || '',
      comment:    cells[8] ?? '',
    });
  }

  return transactions;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchSenatePtrs(
  names: string[],
  opts: { fromYear?: number; toYear?: number } = {},
): Promise<{ fetched: number; cached: number; errors: number }> {
  const fromYear = opts.fromYear ?? 2022;
  const toYear   = opts.toYear   ?? new Date().getFullYear();
  const fromDate = `01/01/${fromYear} 00:00:00`;
  const toDate   = `12/31/${toYear} 23:59:59`;

  mkdirSync(CACHE_DIR, { recursive: true });
  console.log(`Fetching Senate PTRs for ${names.length} senator(s) (${fromYear}–${toYear})…`);

  let fetched = 0, cached = 0, errors = 0;
  const session = await getSession();
  await sleep(DELAY_MS);

  for (const fullName of names) {
    const parts     = fullName.trim().split(/\s+/);
    const lastName  = parts[parts.length - 1];
    const firstName = parts.slice(0, -1).join(' ');

    process.stdout.write(`  [${fullName}] searching…\r`);
    let refs: PtrRef[] = [];
    try {
      refs = await searchPtrs(session, firstName, lastName, fromDate, toDate);
    } catch (e: any) {
      console.log(`\n  ✗ ${fullName}: search failed: ${e.message}`);
      errors++; continue;
    }

    if (refs.length === 0) {
      console.log(`  — ${fullName}: no PTRs found (${fromYear}–${toYear})`);
      continue;
    }

    const slug = fullName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    let memberFetched = 0, memberCached = 0;

    for (const ref of refs) {
      const year    = ref.dateReceived.slice(0, 4);
      const dir     = resolve(CACHE_DIR, year);
      mkdirSync(dir, { recursive: true });
      const jsonPath = resolve(dir, `${slug}-${ref.id}.json`);

      if (existsSync(jsonPath)) { memberCached++; cached++; continue; }

      await sleep(DELAY_MS);
      try {
        const transactions = await fetchPtr(session, ref.id);
        const record: SenatePTR = {
          filingId:     ref.id,
          source:       'senate-efds-ptr',
          filer:        { firstName: ref.firstName, lastName: ref.lastName },
          dateReceived: ref.dateReceived,
          ptrUrl:       `${BASE}/search/view/ptr/${ref.id}/`,
          transactions,
        };
        writeFileSync(jsonPath, JSON.stringify(record, null, 2));
        memberFetched++;
        fetched++;
      } catch (e: any) {
        console.log(`\n  ✗ ${fullName} ${ref.id}: ${e.message}`);
        errors++;
      }
    }

    console.log(`  ✓ ${fullName}: ${refs.length} PTR(s) (${memberFetched} new, ${memberCached} cached)`);
  }

  return { fetched, cached, errors };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args  = process.argv.slice(2);
  const get   = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : null; };

  const namesArg = get('--name') ?? get('--names');
  if (!namesArg) {
    console.error('Usage:');
    console.error('  npx tsx skills/senate-ptr/fetch.ts --name "Susan Collins"');
    console.error('  npx tsx skills/senate-ptr/fetch.ts --names names.txt [--from-year 2022] [--to-year 2026]');
    process.exit(1);
  }

  const names: string[] = existsSync(namesArg)
    ? readFileSync(namesArg, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean)
    : [namesArg];

  const fromYear = get('--from-year') ? parseInt(get('--from-year')!) : undefined;
  const toYear   = get('--to-year')   ? parseInt(get('--to-year')!)   : undefined;

  const { fetched, cached, errors } = await fetchSenatePtrs(names, { fromYear, toYear });
  console.log(`\nDone: ${fetched} new, ${cached} cached, ${errors} errors`);
  console.log(`Cache: ${CACHE_DIR}`);
  process.exit(errors > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
