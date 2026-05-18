/**
 * Bill committee loader.
 *
 * For each bill_id present in `bill_summaries`, fetches the committees that
 * handled it from Congress.gov v3 `/bill/{congress}/{type}/{number}/committees`
 * and upserts into `bill_committees`.
 *
 * Also backfills `committees.committee_canonical` for member committees so the
 * v_trades_near_votes flag JOIN works (matches "Appropriations Committee" on
 * the bill side to "House Committee on Appropriations" on the member side).
 *
 * Usage:
 *   npx tsx db/load-bill-committees.ts
 *   npx tsx db/load-bill-committees.ts --limit 50
 *   npx tsx agents/pipeline.ts --load-bill-committees [--limit N]
 */

import { applySchema, getDb } from './init.js';

const CONGRESS_KEY = process.env.CONGRESS_API_KEY ?? '';
const UA = 'CivicLens/1.0 (research)';

// ─── Committee-name normalization ───────────────────────────────────────────

// "House Committee on Appropriations"     → "appropriations"
// "Senate Committee on Armed Services"    → "armed services"
// "Appropriations Committee"              → "appropriations"
// "Joint Economic Committee"              → "economic"
// Subcommittees ("— Subcom") collapse to the parent canonical so a member
// who sits on a subcommittee inherits the parent's bill-jurisdiction match.
export function committeeCanonical(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).toLowerCase();
  // Drop subcommittee suffix (most reliable signal of parent → subcom).
  s = s.split(/\s*[—-]\s+/)[0];
  // Strip standardized prefixes/suffixes.
  s = s.replace(/^(house|senate|joint)\s+committee\s+on\s+/, '');
  s = s.replace(/^(house|senate|joint)\s+/, '');
  s = s.replace(/\s+committee$/, '');
  // "Senate Committee on the Judiciary" leaves "the judiciary" — drop the article.
  s = s.replace(/^the\s+/, '');
  // Trim punctuation/whitespace.
  s = s.replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  return s || null;
}

// ─── Member committee canonical backfill ────────────────────────────────────

async function backfillMemberCommittees(): Promise<{ filled: number; total: number }> {
  const conn = await getDb();
  const r = await conn.run(`SELECT member_id, committee_name FROM committees WHERE committee_canonical IS NULL`);
  const rows = await r.getRowObjects() as any[];
  for (const row of rows) {
    const canon = committeeCanonical(String(row.committee_name));
    if (!canon) continue;
    await conn.run(
      `UPDATE committees SET committee_canonical = ? WHERE member_id = ? AND committee_name = ?`,
      [canon, String(row.member_id), String(row.committee_name)],
    );
  }
  return { filled: rows.length, total: rows.length };
}

// ─── Bill committees fetcher ────────────────────────────────────────────────

interface BillCommittee {
  name: string;
  chamber: string | null;
  systemCode: string;
  latestActivity: string | null;
  latestActivityDate: string | null;
}

async function fetchBillCommittees(billId: string): Promise<BillCommittee[] | null> {
  const m = billId.match(/^(\d+)-([a-z]+)-(\d+)$/);
  if (!m) return null;
  const [, congress, type, number] = m;
  const url = `https://api.congress.gov/v3/bill/${congress}/${type}/${number}/committees?format=json&api_key=${CONGRESS_KEY}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(15_000) });
  } catch { return null; }
  if (!res.ok) {
    if (res.status === 404) return [];
    return null;
  }
  const data = await res.json();
  const committees: any[] = data?.committees ?? [];
  return committees.map(c => {
    const acts: any[] = c.activities ?? [];
    // Pick the latest activity by date (skip "Unknown" name entries unless
    // they're all we have).
    const named = acts.filter(a => a.name && a.name !== 'Unknown');
    const pool = named.length > 0 ? named : acts;
    pool.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
    const latest = pool[0] ?? {};
    return {
      name: String(c.name ?? ''),
      chamber: c.chamber ?? null,
      systemCode: String(c.systemCode ?? ''),
      latestActivity: latest.name ?? null,
      latestActivityDate: latest.date ? String(latest.date).slice(0, 10) : null,
    };
  }).filter(c => c.systemCode && c.name);
}

async function loadBillCommittees(opts: { limit?: number } = {}): Promise<{ fetched: number; cached: number; skipped: number; rowsWritten: number }> {
  const conn = await getDb();
  const r = await conn.run(`
    SELECT bs.bill_id
    FROM bill_summaries bs
    LEFT JOIN bill_committees bc ON bc.bill_id = bs.bill_id
    WHERE bc.bill_id IS NULL
    GROUP BY bs.bill_id
    ORDER BY bs.bill_id
  `);
  const all = (await r.getRowObjects() as any[]).map(x => String(x.bill_id));
  const todo = opts.limit ? all.slice(0, opts.limit) : all;
  const fetchedAt = new Date().toISOString();
  let fetched = 0, skipped = 0, rowsWritten = 0;

  console.log(`Fetching committees for ${todo.length} bill(s)…\n`);
  for (let i = 0; i < todo.length; i++) {
    const billId = todo[i];
    process.stdout.write(`  [${i + 1}/${todo.length}] ${billId}  `);
    const cs = await fetchBillCommittees(billId);
    if (cs === null) { console.log('✗ fetch failed'); skipped++; continue; }
    if (cs.length === 0) { console.log('· no committees on file'); fetched++; continue; }
    const m = billId.match(/^(\d+)-([a-z]+)-(\d+)$/)!;
    const sourceUrl = `https://www.congress.gov/bill/${m[1]}th-congress/${m[2] === 'hr' ? 'house-bill' : m[2] === 's' ? 'senate-bill' : m[2]}/${m[3]}/committees`;
    for (const c of cs) {
      const canon = committeeCanonical(c.name);
      await conn.run(
        `INSERT OR REPLACE INTO bill_committees
         (bill_id, committee_name, committee_chamber, committee_code, committee_canonical,
          latest_activity, latest_activity_date, source_url, fetched_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [billId, c.name, c.chamber, c.systemCode, canon, c.latestActivity, c.latestActivityDate, sourceUrl, fetchedAt],
      );
      rowsWritten++;
    }
    fetched++;
    console.log(`✓ ${cs.map(c => c.name).slice(0, 3).join(', ')}${cs.length > 3 ? '…' : ''}`);
    await new Promise(r => setTimeout(r, 150));
  }
  return { fetched, cached: all.length - todo.length, skipped, rowsWritten };
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function main(opts: { limit?: number } = {}): Promise<void> {
  await applySchema();

  console.log('Backfilling committees.committee_canonical…');
  const bf = await backfillMemberCommittees();
  console.log(`  ${bf.filled}/${bf.total} member-committee rows updated.\n`);

  if (!CONGRESS_KEY) throw new Error('CONGRESS_API_KEY missing — set in ~/.hermes/.env');
  const r = await loadBillCommittees({ limit: opts.limit });
  console.log(`\nDone: ${r.fetched} bills fetched (${r.rowsWritten} committee rows), ${r.cached} already cached, ${r.skipped} skipped.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? '', 10) : undefined;
  main({ limit }).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
