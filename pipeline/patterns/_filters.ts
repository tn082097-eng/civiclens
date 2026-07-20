/**
 * Shared instrument filters + distinct-trade dedup for Pattern Discovery.
 *
 * Two correctness guards both Phase-1 detectors need:
 *
 * 1. Broad-market ETF / index tickers. v_suspicious_trades only strips ETF
 *    *names* for asset_type IN ('OT','Stock'); broad-market funds typed 'ST'
 *    (e.g. SPY = "DR S&P 500", asset_type ST) slip through. These have no
 *    single-company vote nexus — the view's own stated editorial intent — so
 *    detectors exclude them by ticker.
 *
 * 2. Common-English-word tickers (NOW, ALL, IT...). bill_mentions_ticker is a
 *    whole-word text search; "NOW" matches "Energy Access Now Act". Excluded
 *    from the ticker-text path only.
 *
 * 3. v_suspicious_trades is trade×vote exploded — one trade matched to N votes
 *    is N rows. Counting rows overstates trade volume ("15 trades" for 1 SPY
 *    purchase). dedupeTrades collapses to distinct trades, keeping the
 *    best-scoring vote per trade.
 */

export const BROAD_MARKET_ETFS = [
  'SPY', 'QQQ', 'VOO', 'VTI', 'IVV', 'DIA', 'IWM', 'VEA', 'VWO', 'BND',
  'AGG', 'VUG', 'VTV', 'VIG', 'VYM', 'VXUS', 'VEU', 'VO', 'VB', 'SCHB',
  'SCHD', 'SCHX', 'SCHF', 'SCHA', 'ITOT', 'IJR', 'IJH', 'EFA', 'EEM',
  'TLT', 'IEF', 'SHY', 'LQD', 'HYG', 'GLD', 'SLV', 'XLF', 'XLK', 'XLE',
  'XLV', 'XLI', 'XLP', 'XLY', 'XLU', 'XLB', 'XLRE', 'RSP', 'MDY', 'SDY',
];

export const COMMON_WORD_TICKERS = [
  'NOW', 'ALL', 'IT', 'ON', 'A', 'AN', 'ARE', 'BE', 'BY', 'FOR', 'GO', 'OR',
  'SO', 'TO', 'UP', 'US', 'WE', 'AT', 'DO', 'IS', 'IN', 'OF', 'AS', 'NO',
  'ONE', 'OUT', 'ANY', 'KEY', 'MAIN', 'WELL', 'OPEN', 'REAL', 'FREE', 'SAFE',
  'CARE', 'LOVE', 'LIFE', 'PLAY', 'HOPE', 'NICE', 'GOOD', 'TRUE', 'FUN',
];

/** SQL `'A', 'B', ...` literal list from a static, trusted string array. */
export function sqlList(arr: string[]): string {
  return arr.map(s => `'${s.replace(/'/g, "''")}'`).join(', ');
}

export interface TradeVoteRow {
  filing_id: string;
  tx_date: string;
  tx_type: string;
  instrument: string;
  vote_id: string;
  vote_date: string;
  vote_question: string;
  bill_title: string | null;
  days_before_vote: number;
  score: number;
}

export interface DistinctTrade {
  filing_id: string;
  tx_date: string;
  tx_type: string;
  instrument: string;
  bestScore: number;
  minDays: number;
  // the single best-scoring vote this trade aligns with
  vote_id: string;
  vote_date: string;
  vote_label: string;
}

/**
 * Collapse trade×vote rows to distinct trades, keeping the best-scoring vote
 * per trade. Trade identity = filing_id + tx_date + tx_type + UPPER(instrument)
 * (tx_index isn't exposed by the view; this is the finest available key). The
 * instrument is uppercased in the KEY ONLY so a mixed-case ticker-less asset
 * dedupes to one trade — the same spine the null scorer uses ("one spine, no
 * drift"). The `instrument` field keeps its original case for rendered labels.
 */
export function dedupeTrades(rows: TradeVoteRow[]): DistinctTrade[] {
  const byTrade = new Map<string, DistinctTrade>();
  for (const r of rows) {
    const key = `${r.filing_id}|${r.tx_date}|${r.tx_type}|${r.instrument.toUpperCase()}`;
    const days = Number(r.days_before_vote);
    const score = Number(r.score);
    const voteLabel = `Vote ${r.vote_date}: ${(r.bill_title ?? r.vote_question).slice(0, 80)}`;
    const existing = byTrade.get(key);
    if (!existing || score > existing.bestScore) {
      byTrade.set(key, {
        filing_id: r.filing_id,
        tx_date: r.tx_date,
        tx_type: r.tx_type,
        instrument: r.instrument,
        bestScore: score,
        minDays: existing ? Math.min(existing.minDays, days) : days,
        vote_id: r.vote_id,
        vote_date: r.vote_date,
        vote_label: voteLabel,
      });
    } else {
      existing.minDays = Math.min(existing.minDays, days);
    }
  }
  return [...byTrade.values()];
}
