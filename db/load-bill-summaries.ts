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
 *   npx tsx db/load-bill-summaries.ts --backfill-only  # skip Congress.gov summaries
 *   --official-pass (alias --api-pass) resolves legacy rolls from official Clerk/LIS via pinned collector
 *   --api-limit N caps distinct official rolls
 *   npx tsx agents/pipeline.ts --load-bills [--limit N]
 */

import type { DuckDBConnection } from '@duckdb/node-api';
import { applySchema, getDb } from './init.js';
import type { IngestScope } from '../lib/ingest-scope.js';
import { parseRollKey, isIsoDate, houseSourceUrl, senateSourceUrl } from '../lib/vote-source.js';
import { OfficialVoteFailure, type LegacyRollRequest } from '../lib/official-vote-types.js';
import { OfficialVoteResolutionSchema } from '../lib/schemas.js';
import { resolveOfficialRolls } from '../skills/researcher/official-vote-runtime.js';

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

// ─── Backfill votes.bill_id ─────────────────────────────────────────────────

/** Regex is historical-only. Remaining legacy rolls use official Clerk/LIS
 * resolution through the pinned collector; every resolution precedes any write. */
export async function backfillBillIds(scope: IngestScope, opts: {
  officialPass?: boolean;
  apiPass?: boolean;
  apiLimit?: number;
  conn?: DuckDBConnection;
  resolveRolls?: typeof resolveOfficialRolls;
} = {}): Promise<{
  filled: number;
  skipped: number;
  officialResolved: number;
  apiResolved: number;
  nonBill: number;
  unresolved: number;
  notAttempted: number;
  total: number;
}> {
  const conn = opts.conn ?? await getDb();
  const pred = scopePredicate(scope);
  const rows = await (await conn.run(`SELECT vote_id,member_id,question,source_url,CAST(date AS VARCHAR) AS date
    FROM votes WHERE bill_id IS NULL${pred.sql} ORDER BY vote_id,member_id`, pred.params)).getRowObjects() as any[];
  const updates: Array<{
    member: string;
    key: string;
    bill: string;
  }> = [];
  const remaining: any[] = [];
  let filled = 0, officialResolved = 0, nonBill = 0, unresolved = 0, notAttempted = 0;
  for (const row of rows) {
    // Official rows may mention bills in text but classification owns their linkage.
    if (!String(row.source_url ?? '').startsWith('https://www.govtrack.us/'))
      continue;
    const ref = extractBillRef(String(row.question ?? ''));
    const congress = extractCongress(String(row.source_url ?? ''));
    if (ref && congress) {
      updates.push({ member: String(row.member_id), key: String(row.vote_id), bill: `${congress}-${ref.type}-${ref.number}` });
      filled++;
    }
    else
      remaining.push(row);
  }
  if (opts.officialPass || opts.apiPass) {
    if (opts.apiLimit !== undefined && (!Number.isSafeInteger(opts.apiLimit) || opts.apiLimit < 0))
      throw new OfficialVoteFailure('runtime', 'invalid_limit', 'apiLimit must be a nonnegative safe integer');
    const failures: string[] = [];
    const grouped = new Map<string, any[]>();
    for (const row of remaining) {
      const key = String(row.vote_id);
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    const requests: LegacyRollRequest[] = [];
    for (const [key, group] of grouped) {
      try {
        const id = parseRollKey(key);
        if (new Set(group.map(r => r.date)).size !== 1 || !isIsoDate(group[0].date) || Number(group[0].date.slice(0, 4)) !== id.year)
          throw Error('missing, conflicting or inconsistent stored dates');
        requests.push({ key, date: group[0].date });
      }
      catch (e: any) {
        failures.push(`${key}: ${e.message}`);
      }
    }
    if (failures.length)
      throw new OfficialVoteFailure('identity', 'legacy_roll_resolution_failed', 'invalid stored roll identities', failures);
    const attempted = requests.slice(0, opts.apiLimit ?? requests.length);
    notAttempted = requests.length - attempted.length;
    if (attempted.length) {
      const results = await (opts.resolveRolls ?? resolveOfficialRolls)(attempted, { source: { mode: 'live' } });
      const seen = new Set<string>();
      const expected = new Map(attempted.map(r => [r.key, r]));
      let stage: import('../lib/official-vote-types.js').OfficialVoteStage = 'normalization';
      for (const result of results) {
        const request = expected.get(result.key);
        if (!request || seen.has(result.key)) {
          failures.push(`${result.key}: unexpected or duplicate resolver result`);
          continue;
        }
        seen.add(result.key);
        if (result.ok === false) {
          stage = result.failure.stage;
          failures.push(`${result.key}: ${result.failure.stage}/${result.failure.code}: ${result.failure.message}`);
          continue;
        }
        const id = parseRollKey(result.key);
        const url = id.chamber === 'house' ? houseSourceUrl(id.year, id.roll) : senateSourceUrl(id.congress, id.session, id.roll);
        const parsed = OfficialVoteResolutionSchema.safeParse(result.resolution);
        if (result.date !== request.date || result.sourceUrl !== url || !parsed.success || result.resolution.billId && result.resolution.billId.split('-')[0] !== String(id.congress)) {
          failures.push(`${result.key}: inconsistent official resolution identity or metadata`);
          continue;
        }
        const group = grouped.get(result.key)!;
        if (result.resolution.outcome === 'resolved_bill') {
          for (const row of group)
            updates.push({ member: String(row.member_id), key: result.key, bill: result.resolution.billId! });
          officialResolved += group.length;
        }
        else if (result.resolution.outcome === 'authoritative_non_bill')
          nonBill += group.length;
        else
          unresolved += group.length;
      }
      for (const request of attempted)
        if (!seen.has(request.key))
          failures.push(`${request.key}: missing resolver result`);
      if (failures.length)
        throw new OfficialVoteFailure(stage, 'legacy_roll_resolution_failed', 'official roll resolution failed', failures);
    }
  }
  // Validate the whole resolution batch before changing even regex candidates.
  if (updates.length) {
    await conn.run('BEGIN TRANSACTION');
    try {
      for (const u of updates)
        await conn.run('UPDATE votes SET bill_id=? WHERE member_id=? AND vote_id=? AND bill_id IS NULL', [u.bill, u.member, u.key]);
      await conn.run('COMMIT');
    }
    catch (error) {
      await conn.run('ROLLBACK');
      throw error;
    }
  }
  return { filled, skipped: rows.length - filled - officialResolved, officialResolved, apiResolved: officialResolved, nonBill, unresolved, notAttempted, total: rows.length };
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
  officialPass?: boolean;
  apiPass?: boolean;
  apiLimit?: number;
} = {}): Promise<void> {
  await applySchema();

  console.log('Backfilling legacy votes.bill_id: regex and official Clerk/LIS roll resolution (pinned collector)…');
  const bf = await backfillBillIds(scope, {officialPass: opts.officialPass || opts.apiPass, apiLimit: opts.apiLimit});
  console.log(`  ${bf.filled} filled by regex, ${bf.officialResolved} resolved by official collector, ${bf.nonBill} non-bill, ${bf.unresolved} unresolved, ${bf.notAttempted} rolls not attempted.\n`);

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
    const officialPass = args.includes('--official-pass') || args.includes('--api-pass');
    const scope = await resolveScope(parseScopeArgs(args));
    await main(scope, { limit, backfillOnly, officialPass, apiLimit });
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
}
