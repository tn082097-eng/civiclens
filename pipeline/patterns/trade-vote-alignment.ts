/**
 * Detector: trade-vote-alignment
 *
 * Pattern: a discretionary trade placed shortly BEFORE the member voted on a
 * bill that touches the same company — "touches" meaning either the member
 * sat on a committee that handled the bill, or the bill text names the traded
 * ticker. Named-pattern envelope around the trade-analyst rubric
 * (agents/trade-analyst.ts) + the v_suspicious_trades view.
 *
 * Correctness guards (see pipeline/patterns/_filters.ts):
 *   - Broad-market ETFs (SPY, QQQ...) excluded: no single-company vote nexus.
 *     v_suspicious_trades misses them when typed 'ST' (SPY = "DR S&P 500").
 *   - Common-word tickers (NOW, ALL...) excluded from the bill-text path only.
 *   - v_suspicious_trades is trade×vote exploded; counts are over DISTINCT
 *     trades, not view rows. One SPY purchase is one trade, not 15.
 *
 * Threshold rationale (baseline, expect tuning):
 *   - Proximity: trade within 14 days BEFORE the vote (before-vote-only is
 *     already enforced by the view; 14d is the tight advance-knowledge window).
 *   - A hit requires a real nexus: member_on_bill_committee OR (guarded)
 *     bill_mentions_ticker. Proximity alone is coincidence.
 *   - Score mirrors trade-analyst's committee×proximity CASE, +5 if the bill
 *     text names the ticker. intensity = best score / 100.
 *
 * Editorial: finding is one neutral sentence of true counts + date span.
 */

import { getDb } from '../../db/init.js';
import type { PatternDetector, PatternHit, CitedRow } from './types.js';
import { BROAD_MARKET_ETFS, COMMON_WORD_TICKERS, sqlList } from './_filters.js';

const NAME = 'trade-vote-alignment';
const WINDOW_DAYS = 14;
const ETF_LIST = sqlList(BROAD_MARKET_ETFS);
const WORD_LIST = sqlList(COMMON_WORD_TICKERS);

/**
 * Trade identity for dedupe. Instrument is UPPER-cased so a ticker-less asset
 * disclosed under mixed case collapses to one trade — the same identity the
 * null-scorer substrate uses (spec "one spine, no drift"). Pure + exported so
 * the reconciliation is characterization-tested without touching SQL.
 */
export function tradeIdentityKey(r: {
  filing_id: string;
  tx_date: string;
  tx_type: string;
  instrument: string;
}): string {
  return `${r.filing_id}|${r.tx_date}|${r.tx_type}|${r.instrument.toUpperCase()}`;
}

/** intensity = best score / 100, capped at 1. Pure + exported for tests. */
export function tradeIntensity(maxScore: number): number {
  return Math.min(1, maxScore / 100);
}

const SQL = `
SELECT
  trade_filing_id::text                       AS filing_id,
  tx_date::text                               AS tx_date,
  tx_type,
  COALESCE(ticker, asset)                     AS instrument,
  vote_id::text                               AS vote_id,
  vote_date::text                             AS vote_date,
  vote_question,
  bill_title,
  days_before_vote,
  member_on_bill_committee,
  (bill_mentions_ticker
    AND UPPER(COALESCE(ticker, '')) NOT IN (${WORD_LIST})) AS ticker_named,
  CASE
    WHEN days_before_vote = 0  AND member_on_bill_committee THEN 100
    WHEN days_before_vote = 0                               THEN 90
    WHEN days_before_vote <= 3 AND member_on_bill_committee  THEN 85
    WHEN days_before_vote <= 3                               THEN 80
    WHEN member_on_bill_committee                            THEN 70
    ELSE 60
  END AS base_score
FROM v_suspicious_trades
WHERE member_id = ?
  AND days_before_vote <= ${WINDOW_DAYS}
  AND UPPER(COALESCE(ticker, '')) NOT IN (${ETF_LIST})
  AND (
    member_on_bill_committee
    OR (bill_mentions_ticker
        AND UPPER(COALESCE(ticker, '')) NOT IN (${WORD_LIST}))
  )
ORDER BY base_score DESC, days_before_vote ASC
`;

interface Row {
  filing_id: string;
  tx_date: string;
  tx_type: string;
  instrument: string;
  vote_id: string;
  vote_date: string;
  vote_question: string;
  bill_title: string | null;
  days_before_vote: number;
  member_on_bill_committee: boolean;
  ticker_named: boolean;
  base_score: number;
}

interface Trade {
  bestScore: number;
  days: number;
  committee: boolean;
  tickerNamed: boolean;
  tradeLabel: string;
  filing_id: string;
  vote_id: string;
  vote_label: string;
}

export const tradeVoteAlignment: PatternDetector = {
  name: NAME,
  description:
    'Discretionary trade within 14 days before a vote on a bill the member ' +
    'had committee jurisdiction over, or whose text names the traded company.',

  async detect(memberSlug: string): Promise<PatternHit[]> {
    const conn = await getDb();
    const res = await conn.run(SQL, [memberSlug]);
    const rows = (await res.getRowObjects()) as unknown as Row[];
    if (rows.length === 0) return [];

    // Collapse trade×vote rows to distinct trades, keeping each trade's
    // best-scoring vote. Trade identity = filing+date+type+instrument.
    const byTrade = new Map<string, Trade>();
    for (const r of rows) {
      const key = tradeIdentityKey(r);
      const score = Number(r.base_score) + (r.ticker_named ? 5 : 0);
      const cur = byTrade.get(key);
      if (!cur || score > cur.bestScore) {
        byTrade.set(key, {
          bestScore: score,
          days: Number(r.days_before_vote),
          committee: !!r.member_on_bill_committee,
          tickerNamed: !!r.ticker_named,
          tradeLabel: `${r.tx_type} ${r.instrument} (${r.tx_date})`,
          filing_id: r.filing_id,
          vote_id: r.vote_id,
          vote_label: `Vote ${r.vote_date}: ${(r.bill_title ?? r.vote_question).slice(0, 80)}`,
        });
      }
    }
    const trades = [...byTrade.values()];

    const citing: CitedRow[] = [];
    const dateSet = new Set<string>();
    const seenVotes = new Set<string>();
    let sameDay = 0;
    let committeeLinked = 0;
    let tickerNamed = 0;
    let maxScore = 0;

    for (const t of trades) {
      maxScore = Math.max(maxScore, t.bestScore);
      if (t.days === 0) sameDay++;
      if (t.committee) committeeLinked++;
      else if (t.tickerNamed) tickerNamed++;
      dateSet.add(t.tradeLabel.slice(t.tradeLabel.lastIndexOf('(') + 1, -1));
      dateSet.add(t.vote_label.slice(5, 15));
      citing.push({ kind: 'trade', id: t.filing_id, label: t.tradeLabel });
      if (!seenVotes.has(t.vote_id)) {
        seenVotes.add(t.vote_id);
        citing.push({ kind: 'vote', id: t.vote_id, label: t.vote_label });
      }
    }

    const n = trades.length;
    const dates = [...dateSet].filter(Boolean).sort();
    const parts: string[] = [
      `${n} trade${n === 1 ? '' : 's'} placed within ${WINDOW_DAYS} days before a vote on a related bill`,
    ];
    if (committeeLinked > 0)
      parts.push(`${committeeLinked} where the member sat on a committee that handled the bill`);
    if (tickerNamed > 0)
      parts.push(`${tickerNamed} where the bill text names the traded company`);
    if (sameDay > 0) parts.push(`${sameDay} on the same day as the vote`);

    return [
      {
        pattern: NAME,
        member: memberSlug,
        finding: parts.join('; ') + '.',
        intensity: tradeIntensity(maxScore),
        citing,
        dates,
        detectedAt: new Date().toISOString(),
      },
    ];
  },
};

export default tradeVoteAlignment;
