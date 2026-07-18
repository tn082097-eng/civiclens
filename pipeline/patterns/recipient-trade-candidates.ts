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
 * BLIND by design: the worklist emits only the fields needed to determine
 * corporate identity (recipient name, parent entity, candidate ticker, match
 * basis). No contract values, district assignments, member identities,
 * overlap statistics, trade dates, or detector outputs are displayed —
 * confirmation must stay independent of the detector statistic, enforced
 * mechanically here rather than by curator discipline. The roster-traded
 * scoping above is applied but never shown.
 *
 * Usage: npx tsx pipeline/patterns/recipient-trade-candidates.ts
 */
import { getDb } from '../../db/init.js';
import { fetchSecTickers } from '../../lib/sec-tickers.js';
import { buildNameIndex, matchTicker } from '../../lib/recipient-match.js';
import { CY_START, CY_END } from './district-contract-trade-alignment.js';

const TRADED_SQL = `
SELECT DISTINCT UPPER(t.ticker) AS ticker
FROM pfd_transactions t
JOIN members m ON m.member_id = t.member_id
WHERE m.chamber = 'house' AND m.in_office
  AND t.ticker IS NOT NULL
  AND t.tx_date BETWEEN ? AND ?
ORDER BY ticker
`;

const RECIPIENTS_SQL = `
SELECT r.recipient_key,
       MIN(r.recipient_name) AS recipient_name,
       MIN(p.parent_name)    AS parent_name
FROM district_contract_recipient r
LEFT JOIN recipient_parent p ON p.recipient_id = r.recipient_id
WHERE r.cy BETWEEN ? AND ?
GROUP BY r.recipient_key
ORDER BY r.recipient_key
`;

async function main() {
  const conn = await getDb();
  const idx = buildNameIndex(await fetchSecTickers());

  const tRes = await conn.run(TRADED_SQL, [`${CY_START}-01-01`, `${CY_END}-12-31`]);
  const rosterTraded = new Set<string>();
  for (const r of (await tRes.getRowObjects()) as any[]) rosterTraded.add(String(r.ticker));

  const rRes = await conn.run(RECIPIENTS_SQL, [CY_START, CY_END]);
  const recips = (await rRes.getRowObjects()) as any[];

  console.log(['recipient_key', 'recipient_name', 'parent_name', 'candidate_ticker', 'basis'].join('\t'));
  let n = 0;
  for (const r of recips) {
    const m = matchTicker(String(r.recipient_name), r.parent_name ? String(r.parent_name) : null, idx);
    if (!m) continue;
    if (!rosterTraded.has(m.ticker)) continue;
    console.log([
      String(r.recipient_key), String(r.recipient_name), r.parent_name ?? '', m.ticker, m.basis,
    ].join('\t'));
    n++;
  }
  console.error(`# ${n} candidate(s) — verify identity evidence, copy accepted rows into data/recipient_ticker.tsv`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
