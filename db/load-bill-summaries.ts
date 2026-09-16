/**
 * Bill summaries loader.
 *
 * Two passes:
 *   1. Backfill `votes.bill_id` from `votes.question` + `votes.source_url`.
 *      Uses regex on the procedural question text to extract "H R 8752" /
 *      "S 4638" / "H Res 1316" / etc., combined with the congress number
 *      pulled from the GovTrack source URL.
 *   2. For each distinct `bill_id` not already in `bill_summaries`, call
 *      Congress.gov v3 `/bill/{congress}/{type}/{number}/summaries` and
 *      upsert the result.
 *
 * Usage:
 *   npx tsx db/load-bill-summaries.ts
 *   npx tsx db/load-bill-summaries.ts --limit 100      # cap fetches per run
 *   npx tsx db/load-bill-summaries.ts --backfill-only  # skip the API calls
 *   npx tsx agents/pipeline.ts --load-bills [--limit N]
 */

import type { DuckDBConnection } from '@duckdb/node-api';
import { applySchema, getDb } from './init.js';
import type { IngestScope } from '../lib/ingest-scope.js';

const CONGRESS_KEY = process.env.CONGRESS_API_KEY ?? '';
const UA = 'CivicLens/1.0 (research)';

/** SQL predicate + params restricting a `votes` query to the scope. */
function scopePredicate(scope: IngestScope, alias = ''): { sql: string; params: string[] } {
  const col = alias ? `${alias}.member_id` : 'member_id';
  if (scope.kind === 'member') return { sql: ` AND ${col} = ?`, params: [scope.memberId] };
  return { sql: '', params: [] };
}

// ─── Bill-ref extraction ────────────────────────────────────────────────────

const BILL_TYPE_MAP: Record<string, string> = {
  HR: 'hr', HRES: 'hres', HJRES: 'hjres', HCONRES: 'hconres',
  S: 's',   SRES: 'sres', SJRES: 'sjres', SCONRES: 'sconres',
};

// GovTrack bill_type strings → our canonical type codes.
const GOVTRACK_TYPE_MAP: Record<string, string> = {
  house_bill:                 'hr',
  house_resolution:           'hres',
  house_joint_resolution:     'hjres',
  house_concurrent_resolution:'hconres',
  senate_bill:                's',
  senate_resolution:          'sres',
  senate_joint_resolution:    'sjres',
  senate_concurrent_resolution:'sconres',
};

// Match references like "H R 8752", "H.R. 8752", "S. 4638", "H Res 1316",
// "H.J.Res. 100", anywhere in the text. Pickier prefixes (HJRES, HCONRES)
// must come before pickier suffixes (HRES) before HR — order matters.
const BILL_RE = /\b(H\s*\.?\s*Con\s*\.?\s*Res|S\s*\.?\s*Con\s*\.?\s*Res|H\s*\.?\s*J\s*\.?\s*Res|S\s*\.?\s*J\s*\.?\s*Res|H\s*\.?\s*Res|S\s*\.?\s*Res|H\s*\.?\s*R|S)\s*\.?\s+(\d+)\b/i;

function extractBillRef(text: string | null | undefined): { type: string; number: string } | null {
  if (!text) return null;
  const m = text.match(BILL_RE);
  if (!m) return null;
  const raw = m[1].toUpperCase().replace(/[\s.]/g, '');
  const type = BILL_TYPE_MAP[raw];
  if (!type) return null;
  return { type, number: m[2] };
}

// GovTrack source URL: https://www.govtrack.us/congress/votes/118-2024/h502
function extractCongress(sourceUrl: string | null | undefined): number | null {
  if (!sourceUrl) return null;
  const m = sourceUrl.match(/\/votes\/(\d+)-/);
  return m ? parseInt(m[1], 10) : null;
}

// Extract vote number + chamber from GovTrack URL so we can call the API.
// "/congress/votes/119-2025/s104" → { congress: 119, session: '2025', chamber: 'senate', number: 104 }
function parseGovtrackUrl(url: string | null | undefined): { congress: number; session: string; chamber: string; number: number } | null {
  if (!url) return null;
  const m = url.match(/\/votes\/(\d+)-(\d+)\/([hs])(\d+)$/);
  if (!m) return null;
  return {
    congress: parseInt(m[1], 10),
    session:  m[2],
    chamber:  m[3] === 's' ? 'senate' : 'house',
    number:   parseInt(m[4], 10),
  };
}

// Call GovTrack /api/v2/vote to get related_bill for a single vote.
// Returns a canonical bill_id string like "119-s-5" or null.
async function fetchGovtrackBillId(sourceUrl: string): Promise<string | null> {
  const parsed = parseGovtrackUrl(sourceUrl);
  if (!parsed) return null;
  const apiUrl = `https://www.govtrack.us/api/v2/vote?congress=${parsed.congress}&session=${parsed.session}&chamber=${parsed.chamber}&number=${parsed.number}&format=json`;
  const res = await fetch(apiUrl, {
    headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`GovTrack bill resolution HTTP ${res.status}`);
  const data: any = await res.json();
  if (!Array.isArray(data?.objects) || data.objects.length !== 1
      || !Object.hasOwn(data.objects[0], 'related_bill')) {
    throw new Error('malformed or ambiguous GovTrack vote response');
  }
  const related = data.objects[0].related_bill;
  if (related === null) return null; // authoritative successful no-bill result
  const bt = GOVTRACK_TYPE_MAP[String(related.bill_type ?? '')];
  if (!bt || !Number.isInteger(related.congress) || !Number.isInteger(related.number)) {
    throw new Error('malformed related bill identity');
  }
  return `${related.congress}-${bt}-${related.number}`;
}

// ─── Backfill votes.bill_id ─────────────────────────────────────────────────

// Pass 1: regex over question text — fast, no network.
// Pass 2: GovTrack API for votes that still have no bill_id — covers votes
//         whose question text is just a bill title with no "H.R. N" reference.
export async function backfillBillIds(
  scope: IngestScope,
  opts: { apiPass?: boolean; apiLimit?: number; conn?: DuckDBConnection } = {},
): Promise<{ filled: number; skipped: number; apiResolved: number; total: number }> {
  const conn = opts.conn ?? await getDb();
  const pred = scopePredicate(scope);
  const r = await conn.run(
    `SELECT vote_id, member_id, question, source_url FROM votes WHERE bill_id IS NULL${pred.sql}`,
    pred.params,
  );
  const rows = await r.getRowObjects() as any[];

  let filled = 0, skipped = 0, apiResolved = 0;

  // Pass 1: regex
  const stillNull: any[] = [];
  for (const row of rows) {
    const ref = extractBillRef(String(row.question ?? ''));
    const congress = extractCongress(String(row.source_url ?? ''));
    if (!ref || !congress) { stillNull.push(row); continue; }
    const billId = `${congress}-${ref.type}-${ref.number}`;
    await conn.run(
      `UPDATE votes SET bill_id = ? WHERE member_id = ? AND vote_id = ?`,
      [billId, String(row.member_id), String(row.vote_id)],
    );
    filled++;
  }

  if (!opts.apiPass) {
    skipped = stillNull.length;
    return { filled, skipped, apiResolved, total: rows.length };
  }

  // Pass 2: GovTrack API for remaining nulls.
  // Deduplicate by source_url — many members share the same vote URL,
  // so we resolve each unique URL once and apply to all matching rows.
  const urlToId = new Map<string, string | null>();
  const limit = opts.apiLimit ?? Infinity;
  let apiCalls = 0;

  for (const row of stillNull) {
    const url = String(row.source_url ?? '');
    if (!url) { skipped++; continue; }

    if (!urlToId.has(url)) {
      if (apiCalls >= limit) { skipped++; continue; }
      const billId = await fetchGovtrackBillId(url);
      urlToId.set(url, billId);
      apiCalls++;
      if (apiCalls % 50 === 0) process.stdout.write(`  GovTrack API: ${apiCalls} calls, ${apiResolved} resolved…\n`);
      await new Promise(r => setTimeout(r, 120)); // ~8 req/s
    }

    const billId = urlToId.get(url) ?? null;
    if (!billId) { skipped++; continue; }

    await conn.run(
      `UPDATE votes SET bill_id = ? WHERE member_id = ? AND vote_id = ?`,
      [billId, String(row.member_id), String(row.vote_id)],
    );
    apiResolved++;
  }

  return { filled, skipped, apiResolved, total: rows.length };
}

// ─── Congress.gov fetch ─────────────────────────────────────────────────────

// Fallback: when /summaries is empty (common for current-Congress bills CRS
// hasn't summarized yet), hit /bill/{id} to at least pick up the official
// `title`. Some titles are procedural (HRES) but a real bill name beats null.
async function fetchBillTitleFallback(billId: string): Promise<string | null> {
  const m = billId.match(/^(\d+)-([a-z]+)-(\d+)$/);
  if (!m) return null;
  const [, congress, type, number] = m;
  const url = `https://api.congress.gov/v3/bill/${congress}/${type}/${number}?format=json&api_key=${CONGRESS_KEY}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Congress bill detail HTTP ${res.status} for ${billId}`);
  const data: any = await res.json();
  if (typeof data?.bill?.title !== 'string' || !data.bill.title.trim()) throw new Error(`missing authoritative bill title for ${billId}`);
  return data.bill.title;
}

export async function fetchSummary(billId: string): Promise<{
  title: string | null;
  summaryHtml: string;
  summaryText: string;
  versionCode: string;
  actionDate: string | null;
} | null> {
  const m = billId.match(/^(\d+)-([a-z]+)-(\d+)$/);
  if (!m) return null;
  const [, congress, type, number] = m;
  const url = `https://api.congress.gov/v3/bill/${congress}/${type}/${number}/summaries?format=json&api_key=${CONGRESS_KEY}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(15_000) });
  } catch (e: any) {
    throw new Error(`Congress summary fetch failed for ${billId}: ${e.message}`);
  }
  if (!res.ok) {
    if (res.status === 404) {
      const fallbackTitle = await fetchBillTitleFallback(billId);
      return { title: fallbackTitle, summaryHtml: '', summaryText: '', versionCode: '', actionDate: null };
    }
    throw new Error(`Congress summaries HTTP ${res.status} for ${billId}`);
  }
  const data = await res.json();
  if (!Array.isArray(data?.summaries)) throw new Error(`malformed summaries for ${billId}`);
  const summaries: any[] = data.summaries;
  if (summaries.length === 0) {
    // No CRS summary published yet — fall back to the bill endpoint title.
    const fallbackTitle = await fetchBillTitleFallback(billId);
    return { title: fallbackTitle, summaryHtml: '', summaryText: '', versionCode: '', actionDate: null };
  }

  // Prefer the latest version (highest versionCode by string sort, since codes
  // are zero-padded numerics). "53" (passed) > "07" (reported) > "00" (intro).
  summaries.sort((a, b) => String(b.versionCode ?? '').localeCompare(String(a.versionCode ?? '')));
  const top = summaries[0];
  const html: string = String(top?.text ?? '');
  // Title: extract from first <strong>...</strong> in the HTML.
  const titleMatch = html.match(/<strong>([^<]+)<\/strong>/);
  const title = titleMatch ? titleMatch[1].trim() : null;
  // Plain text: strip tags, collapse whitespace.
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    title,
    summaryHtml: html,
    summaryText: text,
    versionCode: String(top?.versionCode ?? ''),
    actionDate: top?.actionDate ?? null,
  };
}

// Refill: bills already in DB without a title — get the title from the bill
// endpoint, no summary work. Used when re-running this loader after the
// fallback was added.
async function refillTitles(): Promise<{ filled: number; missed: number; total: number }> {
  const conn = await getDb();
  const r = await conn.run(`SELECT bill_id FROM bill_summaries WHERE title IS NULL ORDER BY bill_id`);
  const rows = await r.getRowObjects() as any[];
  let filled = 0, missed = 0;
  for (const row of rows) {
    const billId = String(row.bill_id);
    const title = await fetchBillTitleFallback(billId);
    if (title) {
      await conn.run(`UPDATE bill_summaries SET title = ? WHERE bill_id = ?`, [title, billId]);
      filled++;
    } else {
      missed++;
    }
    await new Promise(r => setTimeout(r, 120));
  }
  return { filled, missed, total: rows.length };
}

/**
 * Distinct bill_ids referenced by the scope's votes that we don't already have a
 * summary for. In member mode the worklist ORIGINATES ONLY from the target's
 * votes (a shared bill_summaries row may still be upserted because it's keyed by
 * bill, but a member run never enumerates the whole roster's bills).
 */
export async function distinctBillWorklist(
  scope: IngestScope,
  conn: DuckDBConnection,
): Promise<string[]> {
  const pred = scopePredicate(scope, 'v');
  const r = await conn.run(`
    SELECT DISTINCT v.bill_id
    FROM votes v
    LEFT JOIN bill_summaries bs ON bs.bill_id = v.bill_id
    WHERE v.bill_id IS NOT NULL
      AND bs.bill_id IS NULL${pred.sql}
    ORDER BY v.bill_id
  `, pred.params);
  return (await r.getRowObjects() as any[]).map(x => String(x.bill_id));
}

async function loadSummaries(
  scope: IngestScope,
  opts: { limit?: number; conn?: DuckDBConnection } = {},
): Promise<{ fetched: number; cached: number; skipped: number }> {
  const conn = opts.conn ?? await getDb();
  const all = await distinctBillWorklist(scope, conn);
  const todo = opts.limit ? all.slice(0, opts.limit) : all;
  const fetchedAt = new Date().toISOString();

  let fetched = 0, skipped = 0;
  console.log(`Fetching summaries for ${todo.length} distinct bill(s)…\n`);
  for (let i = 0; i < todo.length; i++) {
    const billId = todo[i];
    const m = billId.match(/^(\d+)-([a-z]+)-(\d+)$/);
    if (!m) { skipped++; continue; }
    const [, congress, type, number] = m;
    process.stdout.write(`  [${i + 1}/${todo.length}] ${billId}  `);
    const s = await fetchSummary(billId);
    if (!s) {
      console.log('✗ fetch failed');
      skipped++;
      continue;
    }
    const sourceUrl = `https://www.congress.gov/bill/${congress}th-congress/${type === 'hr' ? 'house-bill' : type === 's' ? 'senate-bill' : type}/${number}`;
    await conn.run(
      `INSERT OR REPLACE INTO bill_summaries
       (bill_id, congress, bill_type, bill_number, title, summary_text, summary_html, summary_version, action_date, source_url, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        billId, parseInt(congress, 10), type, parseInt(number, 10),
        s.title, s.summaryText, s.summaryHtml, s.versionCode, s.actionDate,
        sourceUrl, fetchedAt,
      ],
    );
    fetched++;
    console.log(s.title ? `✓ ${s.title.slice(0, 60)}` : '✓ (no summary)');
    // Be nice to the API.
    await new Promise(r => setTimeout(r, 150));
  }
  return { fetched, cached: all.length - todo.length, skipped };
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function main(scope: IngestScope, opts: {
  limit?: number;
  backfillOnly?: boolean;
  apiPass?: boolean;
  apiLimit?: number;
} = {}): Promise<void> {
  await applySchema();

  console.log('Pass 1: backfilling votes.bill_id from question text (regex)…');
  const bf = await backfillBillIds(scope, { apiPass: false });
  console.log(`  ${bf.filled} filled by regex, ${bf.skipped} unparseable, ${bf.total} total NULL rows scanned.\n`);

  if (opts.apiPass) {
    console.log(`Pass 2: GovTrack API resolution for remaining NULL bill_ids${opts.apiLimit ? ` (limit ${opts.apiLimit} API calls)` : ''}…`);
    const bf2 = await backfillBillIds(scope, { apiPass: true, apiLimit: opts.apiLimit });
    console.log(`  ${bf2.filled} filled by regex, ${bf2.apiResolved} resolved via GovTrack API, ${bf2.skipped} still unresolvable.\n`);
  }

  if (opts.backfillOnly) return;
  if (!CONGRESS_KEY) {
    throw new Error('CONGRESS_API_KEY missing — set in the CivicLens .env');
  }
  const r = await loadSummaries(scope, { limit: opts.limit });
  console.log(`\nDone: ${r.fetched} fetched, ${r.cached} already cached, ${r.skipped} skipped.`);

  // Global NULL-title refill is a roster-wide pass — it does not originate from
  // the target's votes, so it runs ONLY in all mode. Member onboarding never
  // triggers it (guide B.5 / adversarial check).
  if (scope.kind === 'all') {
    console.log(`\nRefilling titles for bills with NULL title…`);
    const tr = await refillTitles();
    console.log(`  ${tr.filled} titles filled, ${tr.missed} still NULL out of ${tr.total} candidates.`);
  } else {
    console.log(`\n(member scope: skipping global NULL-title refill — not target-originated.)`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const { parseScopeArgs, resolveScope } = await import('../lib/ingest-scope.js');
    const args = process.argv.slice(2);
    const limitIdx    = args.indexOf('--limit');
    const apiLimitIdx = args.indexOf('--api-limit');
    const limit       = limitIdx    >= 0 ? parseInt(args[limitIdx    + 1] ?? '', 10) : undefined;
    const apiLimit    = apiLimitIdx >= 0 ? parseInt(args[apiLimitIdx + 1] ?? '', 10) : undefined;
    const backfillOnly = args.includes('--backfill-only');
    const apiPass      = args.includes('--api-pass');
    const scope = await resolveScope(parseScopeArgs(args));
    await main(scope, { limit, backfillOnly, apiPass, apiLimit });
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
}
