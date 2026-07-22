/**
 * Shared trade-vote substrate loader — the single spine both the null scorer
 * (score-anomaly / run-patterns) and the live detectors count from.
 *
 * "One spine, no drift": the observed statistic and every permutation draw must
 * see the SAME trades/votes population. This module owns the SQL that defines
 * that population and the PURE assemble step that shapes it into the _nexus.ts
 * Trade/NexusVote types. Detectors and the scorer both go through here so their
 * dedupe keys and filters cannot diverge.
 *
 * Pre-registered spine reconciliations (spec 2026-07-20-timing-detectors-scoring
 * "Substrate and spine reconciliation"):
 *   1. Broad-market ETF exclusion happens at SQL level (matching the detectors),
 *      so ETF rows never inflate trades.length (basket-dispatch input) nor
 *      contribute dates to the volume-shuffle multiset.
 *   2. Trade identity is filing_id|tx_date|tx_type|UPPER(COALESCE(ticker,asset))
 *      everywhere — the SQL uppercases `instrument`, so the pure key cannot
 *      diverge on ticker-less assets.
 */
import { getDb } from '../../db/init.js';
import { BROAD_MARKET_ETFS, COMMON_WORD_TICKERS, sqlList } from './_filters.js';
import type { Trade, NexusVote } from './_nexus.js';

const COMMON = new Set(COMMON_WORD_TICKERS);
const ETF_LIST = sqlList(BROAD_MARKET_ETFS);

/** The SQL row shape. `instrument` is already UPPER-cased by the query. */
export interface SubstrateRow {
  filing_id: string;
  tx_date: string;
  tx_type: string;
  instrument: string;
  vote_id: string;
  vote_date: string;
  member_on_bill_committee: boolean;
  bill_mentions_ticker: boolean;
}

/**
 * Base substrate query. Source view is v_suspicious_trades; NO window filter on
 * the trade side (the superset is correct for the null substrate). ETF rows are
 * excluded at SQL level; instrument is uppercased for a stable identity key.
 *
 * The total-order ORDER BY is load-bearing: the volume-shuffle null assigns
 * shuffled dates to trades positionally, so a stable trades[] order is required
 * for the seeded result to be reproducible across runs (idempotency guarantee).
 * Must include the full trade identity (a basket trader files many instruments
 * on one date under one filing, which would otherwise tie and reorder freely).
 */
function substrateSql(extraWhere = ''): string {
  return `
SELECT
  trade_filing_id::text           AS filing_id,
  tx_date::text                   AS tx_date,
  tx_type,
  UPPER(COALESCE(ticker, asset))  AS instrument,
  vote_id::text                   AS vote_id,
  vote_date::text                 AS vote_date,
  member_on_bill_committee,
  bill_mentions_ticker
FROM v_suspicious_trades
WHERE member_id = ?${extraWhere}
  AND UPPER(COALESCE(ticker, '')) NOT IN (${ETF_LIST})
ORDER BY filing_id, tx_date, tx_type, instrument, vote_id
`;
}

/**
 * PURE: shape trade-vote rows into distinct trades + votes. Votes carry a
 * committee flag (OR across rows) and common-word-filtered namedTickers. Trade
 * identity is filing_id|tx_date|tx_type|instrument (instrument already upper).
 */
export function assembleTradeVote(rows: SubstrateRow[]): { trades: Trade[]; votes: NexusVote[] } {
  const tradeMap = new Map<string, Trade>();
  const voteMap = new Map<string, NexusVote>();
  for (const r of rows) {
    // Uppercase in the key even though SQL already does — the pure spine must
    // not depend on the caller having uppercased ("one spine, no drift").
    const ticker = r.instrument.toUpperCase();
    const tKey = `${r.filing_id}|${r.tx_date}|${r.tx_type}|${ticker}`;
    if (!tradeMap.has(tKey)) {
      tradeMap.set(tKey, { id: tKey, txDate: r.tx_date, ticker });
    }
    let v = voteMap.get(r.vote_id);
    if (!v) {
      v = { id: r.vote_id, voteDate: r.vote_date, committee: false, namedTickers: [] };
      voteMap.set(r.vote_id, v);
    }
    if (r.member_on_bill_committee) v.committee = true;
    if (
      r.bill_mentions_ticker &&
      !COMMON.has(ticker) &&
      !v.namedTickers.includes(ticker)
    ) {
      v.namedTickers.push(ticker);
    }
  }
  return { trades: [...tradeMap.values()], votes: [...voteMap.values()] };
}

/**
 * PURE: spousal shaping. Committee is the ONLY nexus per spec, so votes always
 * carry namedTickers:[] regardless of bill_mentions_ticker; the committee flag
 * ORs across the rows for each vote.
 */
export function assembleSpousal(rows: SubstrateRow[]): { trades: Trade[]; votes: NexusVote[] } {
  const tradeMap = new Map<string, Trade>();
  const voteMap = new Map<string, NexusVote>();
  for (const r of rows) {
    const ticker = r.instrument.toUpperCase();
    const tKey = `${r.filing_id}|${r.tx_date}|${r.tx_type}|${ticker}`;
    if (!tradeMap.has(tKey)) {
      tradeMap.set(tKey, { id: tKey, txDate: r.tx_date, ticker });
    }
    let v = voteMap.get(r.vote_id);
    if (!v) {
      v = { id: r.vote_id, voteDate: r.vote_date, committee: false, namedTickers: [] };
      voteMap.set(r.vote_id, v);
    }
    if (r.member_on_bill_committee) v.committee = true;
  }
  return { trades: [...tradeMap.values()], votes: [...voteMap.values()] };
}

/** DB query + assembleTradeVote — the trade-vote-alignment spine. */
export async function tradeVoteSubstrate(member: string): Promise<{ trades: Trade[]; votes: NexusVote[] }> {
  const conn = await getDb();
  const res = await conn.run(substrateSql(), [member]);
  const rows = (await res.getRowObjects()) as unknown as SubstrateRow[];
  return assembleTradeVote(rows);
}

/** DB query (spouse/joint holders only) + assembleSpousal — the spousal spine. */
export async function spousalSubstrate(member: string): Promise<{ trades: Trade[]; votes: NexusVote[] }> {
  const conn = await getDb();
  const res = await conn.run(substrateSql(`\n  AND LOWER(holder) IN ('spouse', 'joint')`), [member]);
  const rows = (await res.getRowObjects()) as unknown as SubstrateRow[];
  return assembleSpousal(rows);
}
