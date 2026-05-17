/**
 * FEC Independent Expenditure (Super PAC) fetcher.
 *
 * Pulls Schedule E filings against a candidate (committees spending FOR or
 * AGAINST them) and Schedule A funders for those committees.
 *
 * See SOURCES.md → "FEC OpenFEC API" for endpoint shapes, sample payloads,
 * and known quirks.
 *
 * Usage:
 *   import { fetchSuperPacIE } from '../lib/fec-ie.js';
 *   const report = await fetchSuperPacIE('H0GA06192', 2024, { itemized: true, topFunders: 5 });
 *
 * CLI smoke test:
 *   npx tsx lib/fec-ie.ts H0GA06192 2024
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  IEFiling,
  SuperPacFunder,
  SuperPacIE,
  SuperPacIEReport,
  SupportOppose,
} from './types.js';

const BASE = 'https://api.open.fec.gov/v1';
const UA = 'CivicLens/1.0 (research; civiclens.org)';
const REQUEST_DELAY_MS = 250;          // ~4 req/sec; key ceiling is 1000/hour
const PAGE_SIZE = 100;                 // FEC max for most endpoints

// pfd-cache lives at <repo-root>/pfd-cache. This file is at <root>/lib/fec-ie.ts.
const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = join(__dirname, '..', 'pfd-cache', 'fec-ie');

// Mirror of researcher/fetch.ts loadEnvOnce — required for callers that don't
// boot through the pipeline (e.g. render/build.ts, smoke tests).
let envLoaded = false;
function loadEnvOnce() {
  if (envLoaded) return;
  envLoaded = true;
  if (process.env.OPENFEC_API_KEY) return;
  try {
    const raw = readFileSync(join(homedir(), '.hermes', '.env'), 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) continue;
      if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* file missing — keys may come from shell env */ }
}

function apiKey(): string {
  loadEnvOnce();
  const k = process.env.OPENFEC_API_KEY;
  if (!k) throw new Error('OPENFEC_API_KEY not set in environment');
  return k;
}

// ─── HTTP helper with retry/backoff ─────────────────────────────────────────
async function get<T = any>(path: string, params: Record<string, string | number>, timeoutMs = 30_000, maxAttempts = 4): Promise<T> {
  const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), api_key: apiKey() });
  const url = `${BASE}${path}?${qs.toString()}`;
  const safeUrl = url.replace(/api_key=[^&]+/, 'api_key=<redacted>');

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.ok) return (await r.json()) as T;
      const retryable = r.status === 429 || r.status === 503 || r.status >= 500;
      if (!retryable || attempt === maxAttempts) {
        throw new Error(`HTTP ${r.status} ${safeUrl}`);
      }
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e: any) {
      lastErr = e;
      if (attempt === maxAttempts) break;
    }
    await new Promise(res => setTimeout(res, 500 * Math.pow(3, attempt - 1)));
  }
  throw lastErr!;
}

async function pause() { await new Promise(r => setTimeout(r, REQUEST_DELAY_MS)); }

// ─── Cache helpers ───────────────────────────────────────────────────────────
function cachePath(...parts: string[]): string { return join(CACHE_ROOT, ...parts); }
function readCache<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}
function writeCache(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// ─── Passthrough detection ──────────────────────────────────────────────────
// ActBlue / WinRed earmark contributions show up as huge top-line donations
// from the conduit, not the underlying donor. Tag them so the dashboard can
// label or filter them.
const PASSTHROUGH_NAMES = new Set(['ACTBLUE', 'WINRED']);
const PASSTHROUGH_MEMO_RE = /earmarked through this organization/i;

function isPassthrough(name: string | null | undefined, memo: string | null | undefined): boolean {
  const n = (name ?? '').trim().toUpperCase();
  if (PASSTHROUGH_NAMES.has(n)) return true;
  if (memo && PASSTHROUGH_MEMO_RE.test(memo)) return true;
  return false;
}

// ─── Public API ─────────────────────────────────────────────────────────────
export interface FetchOptions {
  itemized?: boolean;          // also fetch per-filing detail (default: false)
  topFunders?: number;         // fetch top-N funders for top-N supporting+opposing PACs (default: 0 = none)
  refresh?: boolean;           // bypass cache (default: false)
}

export async function fetchSuperPacIE(
  candidateId: string,
  cycle: number,
  opts: FetchOptions = {},
): Promise<SuperPacIEReport> {
  const { itemized = false, topFunders = 0, refresh = false } = opts;

  // Normalize candidateId — FEC uses uppercase prefixes (H0GA06192, S2NY00012).
  candidateId = candidateId.trim().toUpperCase();

  const cacheFile = cachePath(candidateId, `${cycle}${itemized ? '-itemized' : ''}${topFunders ? `-funders${topFunders}` : ''}.json`);
  if (!refresh) {
    const cached = readCache<SuperPacIEReport>(cacheFile);
    if (cached) return cached;
  }

  const aggregates = await fetchAggregateIE(candidateId, cycle);
  const supporting = aggregates.filter(a => a.supportOppose === 'S').sort((a, b) => b.totalAmount - a.totalAmount);
  const opposing = aggregates.filter(a => a.supportOppose === 'O').sort((a, b) => b.totalAmount - a.totalAmount);

  // Enrich with committee metadata (committeeType, designation, party).
  await enrichCommittees([...supporting, ...opposing]);

  const report: SuperPacIEReport = {
    candidateId,
    cycle,
    fetchedAt: new Date().toISOString(),
    supporting,
    opposing,
    totalSupporting: supporting.reduce((s, x) => s + x.totalAmount, 0),
    totalOpposing: opposing.reduce((s, x) => s + x.totalAmount, 0),
  };

  if (itemized) {
    report.filings = await fetchItemizedIE(candidateId, cycle);
  }

  if (topFunders > 0) {
    const topCommittees = [...supporting.slice(0, topFunders), ...opposing.slice(0, topFunders)];
    const fundersByCommittee: Record<string, SuperPacFunder[]> = {};
    for (const c of topCommittees) {
      if (isUnenrichable(c.committeeId)) continue;  // null/C9 — no funder list available
      fundersByCommittee[c.committeeId] = await fetchTopFunders(c.committeeId, cycle, topFunders);
      await pause();
    }
    report.topFunders = fundersByCommittee;
  }

  writeCache(cacheFile, report);
  return report;
}

// ─── Internal: aggregate IE per (committee, S/O) ─────────────────────────────
async function fetchAggregateIE(candidateId: string, cycle: number): Promise<SuperPacIE[]> {
  // /schedules/schedule_e/by_candidate/ returns one row per (committee_id, cycle, support_oppose_indicator).
  // Page through in case high-IE candidates have >20 committees per side.
  const out: SuperPacIE[] = [];
  let page = 1;
  while (true) {
    const data = await get<any>('/schedules/schedule_e/by_candidate/', {
      candidate_id: candidateId,
      cycle,
      per_page: PAGE_SIZE,
      page,
    });
    for (const r of (data.results ?? [])) {
      const so: SupportOppose = r.support_oppose_indicator === 'S' ? 'S' : 'O';
      out.push({
        committeeId: r.committee_id,
        committeeName: r.committee_name,
        committeeType: null,
        designation: null,
        party: null,
        cycle: r.cycle,
        supportOppose: so,
        totalAmount: Number(r.total ?? 0),
        count: Number(r.count ?? 0),
      });
    }
    const pages = data.pagination?.pages ?? 1;
    if (page >= pages) break;
    page += 1;
    await pause();
  }
  return out;
}

// ─── Internal: enrich aggregates with committee metadata ─────────────────────
// Skips null/empty/C9-prefix committee IDs — see SOURCES.md "FEC OpenFEC API"
// quirks. C9 are non-committee IE filers; null comes from FEC by_candidate rows
// that don't carry a committee_id. /committee/{id}/ 422s or returns empty for
// these — leave metadata null rather than fail the whole request.
function isUnenrichable(committeeId: string | null | undefined): boolean {
  if (!committeeId) return true;
  if (committeeId.startsWith('C9')) return true;
  return false;
}

async function enrichCommittees(rows: SuperPacIE[]): Promise<void> {
  const seen = new Map<string, { type: string | null; designation: string | null; party: string | null }>();
  for (const r of rows) {
    if (isUnenrichable(r.committeeId)) {
      r.committeeType = null;
      r.designation = null;
      r.party = null;
      continue;
    }
    if (seen.has(r.committeeId)) {
      const meta = seen.get(r.committeeId)!;
      r.committeeType = meta.type;
      r.designation = meta.designation;
      r.party = meta.party;
      continue;
    }
    const meta = await fetchCommitteeMeta(r.committeeId);
    seen.set(r.committeeId, meta);
    r.committeeType = meta.type;
    r.designation = meta.designation;
    r.party = meta.party;
    await pause();
  }
}

async function fetchCommitteeMeta(committeeId: string): Promise<{ type: string | null; designation: string | null; party: string | null }> {
  const cacheFile = cachePath('committees', `${committeeId}.json`);
  const cached = readCache<{ type: string | null; designation: string | null; party: string | null }>(cacheFile);
  if (cached) return cached;

  const data = await get<any>(`/committee/${committeeId}/`, {});
  const r = (data.results ?? [])[0] ?? {};
  const meta = {
    type: r.committee_type_full ?? null,
    designation: r.designation_full ?? null,
    party: r.party ?? null,
  };
  writeCache(cacheFile, meta);
  return meta;
}

// ─── Internal: itemized filings ──────────────────────────────────────────────
async function fetchItemizedIE(candidateId: string, cycle: number): Promise<IEFiling[]> {
  const out: IEFiling[] = [];
  let page = 1;
  let lastIndex: string | null = null;
  let lastAmount: number | null = null;

  while (true) {
    const params: Record<string, string | number> = {
      candidate_id: candidateId,
      cycle,
      per_page: PAGE_SIZE,
      sort: '-expenditure_amount',
    };
    if (lastIndex && lastAmount != null) {
      params.last_index = lastIndex;
      params.last_expenditure_amount = lastAmount;
    } else {
      params.page = page;
    }

    const data = await get<any>('/schedules/schedule_e/', params);
    const results = data.results ?? [];
    for (const r of results) {
      const so: SupportOppose = r.support_oppose_indicator === 'S' ? 'S' : 'O';
      out.push({
        committeeId: r.committee_id,
        committeeName: r.committee?.name ?? r.committee_name ?? null,
        candidateId: r.candidate_id,
        supportOppose: so,
        amount: Number(r.expenditure_amount ?? 0),
        expenditureDate: r.expenditure_date ?? null,
        disbursementDate: r.disbursement_dt ?? null,
        description: r.expenditure_description ?? null,
        payeeName: r.payee_name ?? null,
        pdfUrl: r.pdf_url ?? null,
        reportYear: r.report_year ?? null,
        electionType: r.election_type ?? null,
        transactionId: r.transaction_id,
      });
    }
    if (!results.length) break;
    const pages = data.pagination?.pages ?? 1;
    if (page >= pages && !data.pagination?.last_indexes) break;

    // Prefer cursor pagination (FEC enforces it past page 100).
    const li = data.pagination?.last_indexes;
    if (li?.last_index && li?.last_expenditure_amount != null) {
      lastIndex = String(li.last_index);
      lastAmount = Number(li.last_expenditure_amount);
    } else {
      page += 1;
    }
    await pause();
  }
  return out;
}

// ─── Internal: top funders for a committee ───────────────────────────────────
async function fetchTopFunders(committeeId: string, cycle: number, n: number): Promise<SuperPacFunder[]> {
  // Schedule A is huge (hundreds of pages per PAC per cycle). For "top N
  // funders" we just need the first page, sorted by amount descending.
  // Pull ~3x N to leave room after passthroughs are deduped.
  const data = await get<any>('/schedules/schedule_a/', {
    committee_id: committeeId,
    two_year_transaction_period: cycle,
    per_page: Math.max(n * 3, 10),
    sort: '-contribution_receipt_amount',
  });
  const out: SuperPacFunder[] = [];
  for (const r of (data.results ?? [])) {
    out.push({
      contributorName: r.contributor_name ?? '',
      contributorEmployer: r.contributor_employer ?? null,
      contributorOccupation: r.contributor_occupation ?? null,
      contributorState: r.contributor_state ?? null,
      entityType: r.entity_type ?? null,
      amount: Number(r.contribution_receipt_amount ?? 0),
      date: r.contribution_receipt_date ?? null,
      isPassthrough: isPassthrough(r.contributor_name, r.memo_text),
    });
  }
  return out;
}

// ─── CLI smoke test ──────────────────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [, , candidateId, cycleStr] = process.argv;
  if (!candidateId || !cycleStr) {
    console.error('usage: tsx lib/fec-ie.ts <candidate_id> <cycle>');
    process.exit(1);
  }
  const cycle = Number(cycleStr);
  fetchSuperPacIE(candidateId, cycle, { itemized: false, topFunders: 3, refresh: true })
    .then(report => {
      console.log(`\n=== ${report.candidateId} cycle ${report.cycle} ===`);
      console.log(`fetched at: ${report.fetchedAt}`);
      console.log(`\nSupporting (${report.supporting.length} committees, $${report.totalSupporting.toLocaleString()}):`);
      for (const c of report.supporting.slice(0, 5)) {
        console.log(`  $${c.totalAmount.toLocaleString().padStart(12)} | ${c.committeeName} [${c.committeeType ?? '?'}] (${c.party ?? '?'})`);
      }
      console.log(`\nOpposing (${report.opposing.length} committees, $${report.totalOpposing.toLocaleString()}):`);
      for (const c of report.opposing.slice(0, 5)) {
        console.log(`  $${c.totalAmount.toLocaleString().padStart(12)} | ${c.committeeName} [${c.committeeType ?? '?'}] (${c.party ?? '?'})`);
      }
      if (report.topFunders) {
        console.log(`\nTop funders (top-3 committees per side):`);
        for (const [cid, funders] of Object.entries(report.topFunders)) {
          console.log(`  ${cid}:`);
          for (const f of funders.slice(0, 3)) {
            const tag = f.isPassthrough ? ' [PASSTHROUGH]' : '';
            console.log(`    $${f.amount.toLocaleString().padStart(10)} | ${f.contributorName}${tag}`);
          }
        }
      }
    })
    .catch(e => { console.error(e); process.exit(1); });
}
