/**
 * Curation worklist for the recipient_ticker confirm table. Emits every
 * auto-candidate (recipient → SEC ticker, own name then SAM.gov parent)
 * whose ticker is traded IN-WINDOW by ANY in-office House roster member.
 *
 * Roster-wide on purpose: under the member↔district shuffle every member is
 * scored against every district, so confirms curated only for own-member
 * overlaps would correlate the confirmed set with the observed pairing and
 * bias the null downward (anti-conservative). See the build plan's
 * spec-operationalization note.
 *
 * Output is a WORKLIST, not confirms — a human verifies identity evidence
 * and copies accepted rows into data/recipient_ticker.tsv.
 *
 * Usage: npx tsx pipeline/patterns/recipient-trade-candidates.ts
 */
import { getDb } from '../../db/init.js';
import { fetchSecTickers } from '../../lib/sec-tickers.js';
import { buildNameIndex, matchTicker } from '../../lib/recipient-match.js';
import { CY_START, CY_END } from './district-contract-trade-alignment.js';

const TRADED_SQL = `
SELECT DISTINCT UPPER(t.ticker) AS ticker, t.member_id
FROM pfd_transactions t
JOIN members m ON m.member_id = t.member_id
WHERE m.chamber = 'house' AND m.in_office
  AND t.ticker IS NOT NULL
  AND t.tx_date BETWEEN ? AND ?
ORDER BY ticker, t.member_id
`;

const RECIPIENTS_SQL = `
SELECT r.recipient_key,
       MIN(r.recipient_name) AS recipient_name,
       MIN(p.parent_name)    AS parent_name,
       SUM(r.amount)               AS total_dollars,
       LIST(DISTINCT r.member_id ORDER BY r.member_id) AS district_members
FROM district_contract_recipient r
LEFT JOIN recipient_parent p ON p.recipient_id = r.recipient_id
WHERE r.cy BETWEEN ? AND ?
GROUP BY r.recipient_key
ORDER BY total_dollars DESC, r.recipient_key
`;

// DuckDB's node API returns LIST(...) aggregates as a DuckDBListValue
// (items live under `.items`, not directly iterable), OR as a plain JS
// array depending on driver version — Array.from() on the wrapper object
// silently yields [] rather than throwing, so coerce explicitly and sort
// in JS as a deterministic backstop regardless of which shape comes back.
function toStringArray(v: unknown): string[] {
  const raw: unknown[] = Array.isArray(v) ? v : Array.isArray((v as any)?.items) ? (v as any).items : [];
  return raw.map(String).sort();
}

async function main() {
  const conn = await getDb();
  const idx = buildNameIndex(await fetchSecTickers());

  const tRes = await conn.run(TRADED_SQL, [`${CY_START}-01-01`, `${CY_END}-12-31`]);
  const tradedBy = new Map<string, string[]>();
  for (const r of (await tRes.getRowObjects()) as any[]) {
    const arr = tradedBy.get(String(r.ticker)) ?? [];
    arr.push(String(r.member_id));
    tradedBy.set(String(r.ticker), arr);
  }

  const rRes = await conn.run(RECIPIENTS_SQL, [CY_START, CY_END]);
  const recips = (await rRes.getRowObjects()) as any[];

  console.log(['recipient_key', 'recipient_name', 'parent_name', 'candidate_ticker', 'basis',
    'district_members', 'total_dollars', 'traded_by', 'own_member_overlap'].join('\t'));
  let n = 0;
  for (const r of recips) {
    const m = matchTicker(String(r.recipient_name), r.parent_name ? String(r.parent_name) : null, idx);
    if (!m) continue;
    const traders = tradedBy.get(m.ticker);
    if (!traders) continue;
    const districts: string[] = toStringArray(r.district_members);
    const own = districts.some((d) => traders.includes(d));
    console.log([
      String(r.recipient_key), String(r.recipient_name), r.parent_name ?? '',
      m.ticker, m.basis, districts.join(','), String(Math.round(Number(r.total_dollars))),
      traders.join(','), own ? 'YES' : 'no',
    ].join('\t'));
    n++;
  }
  console.error(`# ${n} candidate(s) — verify identity evidence, copy accepted rows into data/recipient_ticker.tsv`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
