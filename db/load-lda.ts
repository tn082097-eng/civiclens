/**
 * LDA (Lobbying Disclosure Act) loader.
 *
 * Source: https://lda.senate.gov/api/v1/filings/ — paginated REST, no auth.
 * Page size is hard-capped at 25, so a full-year ingest is ~3,800 pages.
 *
 * What gets stored:
 *   - lda_filings  : one row per filing (registrant + client + period)
 *   - lda_lobbyists: one row per (filing × lobbyist), incl. covered_position
 *
 * Filings with NO non-null covered_position across any lobbyist are skipped.
 * Those are commercial lobbyists with no former-government tie — irrelevant
 * to revolving-door analysis and would 10x the table size.
 *
 * Usage:
 *   npx tsx db/load-lda.ts                              # full default range
 *   npx tsx db/load-lda.ts --year 2024                  # single year
 *   npx tsx db/load-lda.ts --year 2024 --period first_quarter
 *   npx tsx db/load-lda.ts --years 2022-2025            # year range
 *   npx tsx db/load-lda.ts --resume                     # skip filings already in DB
 *   npx tsx db/load-lda.ts --limit 200                  # dev cap (pages, not rows)
 */

import { applySchema, getDb } from './init.js';

const UA = 'CivicLens/1.0 (research; civiclens.org)';
const BASE = 'https://lda.senate.gov/api/v1/filings/';
const PAGE_SIZE = 25;            // hard cap from the API
const REQUEST_DELAY_MS = 200;    // 5 req/sec — well under any realistic rate limit

// ─── HTTP helper with retry/backoff ──────────────────────────────────────────
async function get(url: string, timeoutMs = 30_000, maxAttempts = 4): Promise<any> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.ok) return await r.json();
      const retryable = r.status === 429 || r.status === 503 || r.status >= 500;
      if (!retryable || attempt === maxAttempts) {
        throw new Error(`HTTP ${r.status} ${url.split('?')[0]}`);
      }
      lastErr = new Error(`HTTP ${r.status}`);
      // 429 = rate limit window (anonymous access is 15 req/min) — the only
      // useful wait is long enough for the window to roll over.
      if (r.status === 429) {
        await new Promise(res => setTimeout(res, 65_000));
        continue;
      }
    } catch (e: any) {
      lastErr = e;
      if (attempt === maxAttempts) break;
    }
    await new Promise(res => setTimeout(res, 500 * Math.pow(3, attempt - 1)));
  }
  throw lastErr!;
}

// ─── Name canonicalization (mirrors normalizeDonorName conventions) ─────────
export function canonicalizeLobbyistName(first: string, middle: string | null, last: string): string {
  const parts = [first, middle, last].filter(Boolean).join(' ');
  return parts
    .toUpperCase()
    .replace(/\b(JR|SR|II|III|IV|ESQ|PHD|MD)\b\.?/g, '')
    .replace(/[.,'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── CLI parsing ─────────────────────────────────────────────────────────────
interface CliOpts {
  years: number[];
  period: string | null;
  resume: boolean;
  limit: number | null;     // max pages per (year,period) — for dev runs
  covered: string | null;   // server-side lobbyist_covered_position text search
  delayMs: number;          // inter-page delay (anonymous rate limit: 15 req/min)
}

function parseCli(): CliOpts {
  const args = process.argv.slice(2);
  let years: number[] = [];
  let period: string | null = null;
  let resume = false;
  let limit: number | null = null;
  let covered: string | null = null;
  let delayMs = REQUEST_DELAY_MS;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--year') {
      years = [parseInt(args[++i], 10)];
    } else if (a === '--years') {
      const m = args[++i].match(/^(\d{4})-(\d{4})$/);
      if (!m) throw new Error('--years expects YYYY-YYYY');
      const lo = parseInt(m[1], 10), hi = parseInt(m[2], 10);
      for (let y = lo; y <= hi; y++) years.push(y);
    } else if (a === '--period') {
      period = args[++i];
    } else if (a === '--resume') {
      resume = true;
    } else if (a === '--limit') {
      limit = parseInt(args[++i], 10);
    } else if (a === '--covered') {
      covered = args[++i];
    } else if (a === '--delay-ms') {
      delayMs = parseInt(args[++i], 10);
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  if (years.length === 0) {
    // Default: current and previous calendar year (covers active lobbyists)
    const now = new Date().getUTCFullYear();
    years = [now, now - 1];
  }
  return { years, period, resume, limit, covered, delayMs };
}

// ─── Filter: keep only filings with at least one non-null covered_position ──
function hasCoveredPosition(filing: any): boolean {
  for (const la of filing.lobbying_activities ?? []) {
    for (const entry of la.lobbyists ?? []) {
      const cp = entry.covered_position;
      if (typeof cp === 'string' && cp.trim() && cp.trim().toUpperCase() !== 'N/A') {
        return true;
      }
    }
  }
  return false;
}

// ─── Per-filing flatten ──────────────────────────────────────────────────────
interface LobbyistRow {
  lobbyist_id:           number;
  first_name:            string;
  last_name:             string;
  middle_name:           string | null;
  full_name:             string;
  full_name_canonical:   string;
  covered_position:      string | null;
  general_issues:        string;
  government_entities:   string;
  is_new:                boolean | null;
}

function flattenLobbyists(filing: any): LobbyistRow[] {
  const byId = new Map<number, LobbyistRow>();
  const allEntities = new Set<string>();
  for (const la of filing.lobbying_activities ?? []) {
    const issue = la.general_issue_code_display ?? la.general_issue_code ?? '';
    for (const ent of la.government_entities ?? []) {
      if (ent?.name) allEntities.add(ent.name);
    }
    for (const entry of la.lobbyists ?? []) {
      const lob = entry.lobbyist;
      if (!lob || typeof lob.id !== 'number') continue;
      const cp = typeof entry.covered_position === 'string' ? entry.covered_position.trim() : '';
      const cpClean = cp && cp.toUpperCase() !== 'N/A' ? cp : null;

      const existing = byId.get(lob.id);
      if (existing) {
        if (issue && !existing.general_issues.includes(issue)) {
          existing.general_issues = existing.general_issues
            ? `${existing.general_issues} / ${issue}`
            : issue;
        }
        if (cpClean && !existing.covered_position) {
          existing.covered_position = cpClean;
        }
      } else {
        const first = String(lob.first_name ?? '').trim();
        const middle = lob.middle_name ? String(lob.middle_name).trim() : null;
        const last = String(lob.last_name ?? '').trim();
        const full = [first, middle, last].filter(Boolean).join(' ');
        byId.set(lob.id, {
          lobbyist_id:         lob.id,
          first_name:          first,
          last_name:           last,
          middle_name:         middle,
          full_name:           full,
          full_name_canonical: canonicalizeLobbyistName(first, middle, last),
          covered_position:    cpClean,
          general_issues:      issue,
          government_entities: '',  // filled below from union
          is_new:              entry.new ?? null,
        });
      }
    }
  }
  const entitiesStr = [...allEntities].sort().join(' / ');
  for (const row of byId.values()) row.government_entities = entitiesStr;
  return [...byId.values()];
}

// ─── Upsert helpers ──────────────────────────────────────────────────────────
async function upsertFiling(conn: any, filing: any, fetchedAt: string): Promise<void> {
  await conn.run(
    `INSERT INTO lda_filings
       (filing_uuid, filing_year, filing_period, filing_type,
        registrant_name, client_name, income, expenses,
        posted_at, filing_url, source_url, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (filing_uuid) DO UPDATE SET
       registrant_name = EXCLUDED.registrant_name,
       client_name     = EXCLUDED.client_name,
       income          = EXCLUDED.income,
       expenses        = EXCLUDED.expenses,
       posted_at       = EXCLUDED.posted_at,
       fetched_at      = EXCLUDED.fetched_at`,
    [
      filing.filing_uuid,
      filing.filing_year ?? null,
      filing.filing_period ?? null,
      filing.filing_type ?? null,
      filing.registrant?.name ?? null,
      filing.client?.name ?? null,
      filing.income ? Number(filing.income) : null,
      filing.expenses ? Number(filing.expenses) : null,
      filing.dt_posted ?? null,
      filing.filing_document_url ?? null,
      filing.url ?? null,
      fetchedAt,
    ],
  );
}

async function upsertLobbyist(
  conn: any,
  filingUuid: string,
  row: LobbyistRow,
  fetchedAt: string,
): Promise<void> {
  await conn.run(
    `INSERT INTO lda_lobbyists
       (filing_uuid, lobbyist_id, first_name, last_name, middle_name,
        full_name, full_name_canonical, covered_position,
        general_issues, government_entities, is_new, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (filing_uuid, lobbyist_id) DO UPDATE SET
       covered_position    = EXCLUDED.covered_position,
       general_issues      = EXCLUDED.general_issues,
       government_entities = EXCLUDED.government_entities,
       fetched_at          = EXCLUDED.fetched_at`,
    [
      filingUuid,
      row.lobbyist_id,
      row.first_name || null,
      row.last_name || null,
      row.middle_name,
      row.full_name || null,
      row.full_name_canonical || null,
      row.covered_position,
      row.general_issues || null,
      row.government_entities || null,
      row.is_new,
      fetchedAt,
    ],
  );
}

// ─── Existing-filing set (for --resume) ──────────────────────────────────────
async function loadExistingUuids(conn: any): Promise<Set<string>> {
  const r = await conn.run(`SELECT filing_uuid FROM lda_filings`);
  const rows = await r.getRowObjects() as any[];
  return new Set(rows.map(x => String(x.filing_uuid)));
}

// ─── Main ingest loop ────────────────────────────────────────────────────────
async function ingest(opts: CliOpts): Promise<void> {
  await applySchema();
  const conn = await getDb();

  const existing = opts.resume ? await loadExistingUuids(conn) : new Set<string>();
  if (opts.resume) console.log(`[resume] ${existing.size} filings already in DB — will skip`);

  let totalFilings = 0, totalKept = 0, totalLobbyists = 0, totalSkipped = 0;
  const periods = opts.period ? [opts.period] : [null]; // null = no period filter

  for (const year of opts.years) {
    for (const period of periods) {
      const params = new URLSearchParams({
        page_size:    String(PAGE_SIZE),
        filing_year:  String(year),
        format:       'json',
      });
      if (period) params.set('filing_period', period);
      if (opts.covered) params.set('lobbyist_covered_position', opts.covered);
      let url: string | null = `${BASE}?${params.toString()}`;
      let pageNum = 0;
      let pageCap: number | null = null;

      while (url) {
        pageNum++;
        if (opts.limit && pageNum > opts.limit) {
          console.log(`[year=${year}${period ? ` period=${period}` : ''}] limit reached at page ${pageNum - 1}`);
          break;
        }
        let payload: any;
        try {
          payload = await get(url);
        } catch (e: any) {
          // Losing one page loses up to PAGE_SIZE filings; say so honestly —
          // this abandons the rest of the year's pagination (no next-url).
          console.error(`[year=${year} page=${pageNum}] fetch failed after retries: ${e.message} — abandoning rest of year`);
          break;
        }
        if (pageCap === null) {
          pageCap = Math.ceil((payload.count ?? 0) / PAGE_SIZE);
          console.log(`[year=${year}${period ? ` period=${period}` : ''}${opts.covered ? ` covered~"${opts.covered}"` : ''}] ${payload.count} filings → ~${pageCap} pages`);
        }

        const fetchedAt = new Date().toISOString();
        for (const filing of payload.results ?? []) {
          totalFilings++;
          const uuid = filing.filing_uuid;
          if (!uuid) continue;
          if (existing.has(uuid)) { totalSkipped++; continue; }
          if (!hasCoveredPosition(filing)) { totalSkipped++; continue; }

          try {
            await upsertFiling(conn, filing, fetchedAt);
            const lobbyists = flattenLobbyists(filing);
            for (const row of lobbyists) {
              await upsertLobbyist(conn, uuid, row, fetchedAt);
              totalLobbyists++;
            }
            existing.add(uuid);
            totalKept++;
          } catch (e: any) {
            console.error(`[filing=${uuid}] upsert failed: ${e.message}`);
          }
        }

        if (pageNum % 20 === 0) {
          process.stdout.write(`  page ${pageNum}/${pageCap ?? '?'}: kept=${totalKept} lob=${totalLobbyists} skip=${totalSkipped}\r`);
        }

        url = payload.next ?? null;
        if (url) await new Promise(res => setTimeout(res, opts.delayMs));
      }
      process.stdout.write('\n');
    }
  }

  console.log('');
  console.log(`done: scanned=${totalFilings} kept=${totalKept} skipped=${totalSkipped} lobbyist_rows=${totalLobbyists}`);
}

// ─── Entry point ─────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseCli();
  ingest(opts).then(() => process.exit(0)).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
