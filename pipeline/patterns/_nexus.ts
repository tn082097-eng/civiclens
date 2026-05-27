/**
 * Pure nexus rule, extracted from trade-vote-alignment.ts so the live
 * observation and every permutation draw count with the IDENTICAL rule.
 *
 * A trade has a nexus if some vote falls 0..windowDays AFTER it (trade before
 * vote) AND (the member sat on the bill's committee OR the bill text names the
 * trade's ticker). Broad-market ETF tickers never count. Each qualifying trade
 * is counted once regardless of how many votes it matches.
 */
import { BROAD_MARKET_ETFS } from './_filters.js';

export interface Trade {
  id: string;
  txDate: string; // ISO yyyy-mm-dd
  ticker: string; // upper-case ticker symbol
}

export interface NexusVote {
  id: string;
  voteDate: string; // ISO yyyy-mm-dd
  committee: boolean; // member sat on a committee that handled the bill
  namedTickers: string[]; // tickers the bill text names (common-word filtered upstream)
}

const ETF = new Set(BROAD_MARKET_ETFS);
const MS_PER_DAY = 86_400_000;

function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(later) - Date.parse(earlier)) / MS_PER_DAY);
}

/** Count distinct trades that have a nexus vote within `windowDays` after them. */
export function countNexus(trades: Trade[], votes: NexusVote[], windowDays: number): number {
  let count = 0;
  for (const t of trades) {
    if (ETF.has(t.ticker)) continue;
    const hit = votes.some(v => {
      const d = daysBetween(t.txDate, v.voteDate); // >=0 means trade before vote
      if (d < 0 || d > windowDays) return false;
      return v.committee || v.namedTickers.includes(t.ticker);
    });
    if (hit) count++;
  }
  return count;
}
