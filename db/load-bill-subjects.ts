/**
 * Bill → policy area + legislative subjects loader (Congress.gov).
 *
 * For each distinct `bill_id` referenced by `votes` (dense after the
 * --load-bills backfill) that isn't already in `bill_subjects`, call
 * Congress.gov v3 `/bill/{congress}/{type}/{number}/subjects` and store one row
 * per (bill_id, subject) plus the single policy_area.
 *
 * Deterministic, sourced — feeds the trade↔bill nexus join (ticker sector ∩
 * bill subject). See SOURCES.md "Relevance edge — Source A".
 *
 * Usage:
 *   npx tsx db/load-bill-subjects.ts
 *   npx tsx db/load-bill-subjects.ts --limit 50    # cap fetches per run
 *   npx tsx agents/pipeline.ts --load-bill-subjects
 */

import { applySchema, getDb } from './init.js';

const CONGRESS_KEY = process.env.CONGRESS_API_KEY ?? '';
const UA = 'CivicLens/1.0 (research)';

async function getJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Distinct bill_ids voted on but not yet in bill_subjects.
async function pendingBillIds(): Promise<string[]> {
  const conn = await getDb();
  const r = await conn.run(
    `SELECT DISTINCT v.bill_id AS id FROM votes v
      WHERE v.bill_id IS NOT NULL
        AND v.bill_id NOT IN (SELECT DISTINCT bill_id FROM bill_subjects)
      ORDER BY v.bill_id`,
  );
  return (await r.getRowObjects()).map((x: any) => String(x.id));
}

export async function loadBillSubjects(opts: { limit?: number } = {}): Promise<{ filled: number; empty: number; failed: string[]; total: number }> {
  if (!CONGRESS_KEY) throw new Error('CONGRESS_API_KEY not set — aborting.');
  await applySchema();
  const conn = await getDb();

  const bills = await pendingBillIds();
  console.log(`${bills.length} bill(s) need subjects.`);
  const limit = opts.limit ?? Infinity;
  const fetchedAt = new Date().toISOString();

  let filled = 0, empty = 0, calls = 0;
  const failed: string[] = [];

  for (const billId of bills) {
    if (calls >= limit) break;
    const [congress, type, number] = billId.split('-');
    if (!congress || !type || !number) { failed.push(billId); continue; }

    const url = `https://api.congress.gov/v3/bill/${congress}/${type}/${number}/subjects?format=json&api_key=${CONGRESS_KEY}&limit=250`;
    const data = await getJson(url);
    calls++;
    await new Promise(r => setTimeout(r, 150)); // ~6 req/s, well under 5000/hr

    if (!data) { failed.push(billId); continue; }
    const s = data.subjects ?? {};
    const policyArea: string | null = s.policyArea?.name ?? null;
    const subjects: string[] = (s.legislativeSubjects ?? []).map((x: any) => String(x.name)).filter(Boolean);

    const sourceUrl = `https://www.congress.gov/bill/${congress}th-congress/${type}/${number}`;

    // A bill with a policyArea but no granular subjects still gets one row so we
    // don't re-fetch it forever — use the policyArea as the subject.
    const rows = subjects.length ? subjects : (policyArea ? [policyArea] : []);
    if (rows.length === 0) { empty++; continue; }

    for (const subject of rows) {
      await conn.run(
        `INSERT OR REPLACE INTO bill_subjects (bill_id, policy_area, subject, source_url, fetched_at)
         VALUES (?,?,?,?,?)`,
        [billId, policyArea, subject, sourceUrl, fetchedAt],
      );
    }
    filled++;
    if (filled % 50 === 0) console.log(`  …${filled} bills filled (${calls} calls)`);
  }

  console.log(`\nDone: ${filled} bills with subjects, ${empty} with no subjects, ${failed.length} failed, of ${bills.length} pending.`);
  if (failed.length) console.log(`  failed: ${failed.slice(0, 30).join(', ')}${failed.length > 30 ? ' …' : ''}`);
  return { filled, empty, failed, total: bills.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const li = process.argv.indexOf('--limit');
  const limit = li >= 0 ? parseInt(process.argv[li + 1], 10) : undefined;
  loadBillSubjects({ limit })
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}
