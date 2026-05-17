/**
 * Detector: spousal-trade-timing
 *
 * Pattern: a trade held by the member's SPOUSE or JOINTLY, placed in a tight
 * window before the member voted on a bill the member's own committee handled.
 * Distinct from trade-vote-alignment because spousal/joint disclosure rules
 * differ and the relevant timing window is the question.
 *
 * Substrate caveat (per spec testing rule): CivicLens has no committee
 * hearing/markup calendar source. "Committee activity" is anchored to bills
 * the member's committee handled that the member then voted on
 * (member_on_bill_committee). Faithful proxy, not a hearing calendar.
 *
 * Correctness guards (pipeline/patterns/_filters.ts):
 *   - Broad-market ETFs excluded (no single-company nexus; SPY etc. are typed
 *     'ST' and slip the view's ETF-name filter).
 *   - v_suspicious_trades is trade×vote exploded; counts are over DISTINCT
 *     trades (one SPY purchase is one trade, not 15).
 *
 * Threshold rationale (baseline, expect tuning):
 *   - holder = 'spouse' (data only has self/spouse; 'joint' never materialized;
 *     LOWER(holder) IN ('spouse','joint') stays future-proof).
 *   - Window: 14 days. Calibrated, NOT assumed: spouse + committee proximity
 *     is empirically EMPTY at <=7d across all 36 members (tightest = 9d). A 7d
 *     window disables the detector corpus-wide.
 *   - Requires member_on_bill_committee = TRUE. Committee jurisdiction is the
 *     nexus; no ticker-text path — the bar for a household-trade claim is
 *     committee jurisdiction.
 *   - intensity scales with tightness + distinct-trade volume.
 */

import { getDb } from '../../db/init.js';
import type { PatternDetector, PatternHit, CitedRow } from './types.js';
import {
  BROAD_MARKET_ETFS,
  sqlList,
  dedupeTrades,
  type TradeVoteRow,
} from './_filters.js';

const NAME = 'spousal-trade-timing';
const WINDOW_DAYS = 14;
const ETF_LIST = sqlList(BROAD_MARKET_ETFS);

const SQL = `
SELECT
  trade_filing_id::text AS filing_id,
  tx_date::text         AS tx_date,
  tx_type,
  holder,
  COALESCE(ticker, asset) AS instrument,
  vote_id::text         AS vote_id,
  vote_date::text       AS vote_date,
  vote_question,
  bill_title,
  days_before_vote,
  -- closer to the vote scores higher, so dedupe keeps the tightest vote
  (${WINDOW_DAYS} - days_before_vote) AS score
FROM v_suspicious_trades
WHERE member_id = ?
  AND LOWER(holder) IN ('spouse', 'joint')
  AND member_on_bill_committee
  AND days_before_vote <= ${WINDOW_DAYS}
  AND UPPER(COALESCE(ticker, '')) NOT IN (${ETF_LIST})
ORDER BY days_before_vote ASC
`;

interface Row extends TradeVoteRow {
  holder: string;
}

export const spousalTradeTiming: PatternDetector = {
  name: NAME,
  description:
    'Spouse- or jointly-held trade within 14 days before a vote on a bill the ' +
    "member's own committee handled.",

  async detect(memberSlug: string): Promise<PatternHit[]> {
    const conn = await getDb();
    const res = await conn.run(SQL, [memberSlug]);
    const rows = (await res.getRowObjects()) as unknown as Row[];
    if (rows.length === 0) return [];

    // holder is constant per trade (a filing line is one holder), so tracking
    // spouse/joint split by distinct trade: rebuild after dedupe.
    const holderByKey = new Map<string, string>();
    for (const r of rows) {
      holderByKey.set(
        `${r.filing_id}|${r.tx_date}|${r.tx_type}|${r.instrument}`,
        r.holder.toLowerCase(),
      );
    }

    const trades = dedupeTrades(rows);

    const citing: CitedRow[] = [];
    const dateSet = new Set<string>();
    const seenVotes = new Set<string>();
    let spouse = 0;
    let joint = 0;
    let sameDay = 0;
    let tightest = WINDOW_DAYS;

    for (const t of trades) {
      const holder =
        holderByKey.get(
          `${t.filing_id}|${t.tx_date}|${t.tx_type}|${t.instrument}`,
        ) ?? 'spouse';
      if (holder === 'spouse') spouse++;
      else joint++;
      tightest = Math.min(tightest, t.minDays);
      if (t.minDays === 0) sameDay++;
      dateSet.add(t.tx_date);
      dateSet.add(t.vote_date);
      citing.push({
        kind: 'trade',
        id: t.filing_id,
        label: `${holder} ${t.tx_type} ${t.instrument} (${t.tx_date})`,
      });
      if (!seenVotes.has(t.vote_id)) {
        seenVotes.add(t.vote_id);
        citing.push({ kind: 'vote', id: t.vote_id, label: t.vote_label });
      }
    }

    const n = trades.length;
    const dates = [...dateSet].sort();
    const plural = n === 1 ? '' : 's';
    let subject: string;
    if (spouse > 0 && joint > 0) {
      subject = `${n} household trade${plural} (${spouse} spouse-held, ${joint} jointly-held)`;
    } else if (joint > 0) {
      subject = `${n} jointly-held trade${plural}`;
    } else {
      subject = `${n} spouse-held trade${plural}`;
    }
    let finding =
      `${subject} placed within ${WINDOW_DAYS} days before a vote on a bill ` +
      `the member's committee handled`;
    if (sameDay > 0) finding += `; ${sameDay} on the same day as the vote`;
    finding += '.';

    const proximity = 1 - tightest / WINDOW_DAYS;
    const volume = Math.min(1, n / 5);
    const intensity = Math.min(1, 0.5 + 0.3 * proximity + 0.2 * volume);

    return [
      {
        pattern: NAME,
        member: memberSlug,
        finding,
        intensity,
        citing,
        dates,
        detectedAt: new Date().toISOString(),
      },
    ];
  },
};

export default spousalTradeTiming;
