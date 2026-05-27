/**
 * Pure nexus rule, extracted from trade-vote-alignment.ts so the live
 * observation and every permutation draw count with the IDENTICAL rule.
 *
 * A trade has a nexus if some vote falls 0..windowDays AFTER it (trade before
 * vote) AND (the member sat on the bill's committee OR the bill text names the
 * trade's ticker). Broad-market ETF tickers never count. Each qualifying trade
 * is counted once regardless of how many votes it matches.
 *
 * Hot-path shape: votes are folded ONCE into a NexusIndex (sorted committee
 * vote dates + sorted per-ticker named-bill dates). Each trade is then an
 * O(log V) binary search instead of an O(V) scan — so a permutation test that
 * re-counts thousands of times reuses one index and stays fast.
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

/** A trade with its date pre-parsed to epoch-ms — the hot-loop representation. */
export interface IndexedTrade {
  ticker: string;
  txMs: number;
}

/** Sorted vote-date index: the committee path + the per-ticker named-bill path. */
export interface NexusIndex {
  committee: number[]; // sorted ascending epoch-ms of committee votes
  byTicker: Map<string, number[]>; // ticker -> sorted ascending epoch-ms of named-bill votes
}

const ETF = new Set(BROAD_MARKET_ETFS);
const MS_PER_DAY = 86_400_000;

/** Fold votes into the sorted index. O(V log V), done once per member. */
export function buildNexusIndex(votes: NexusVote[]): NexusIndex {
  const committee: number[] = [];
  const byTicker = new Map<string, number[]>();
  for (const v of votes) {
    const ms = Date.parse(v.voteDate);
    if (v.committee) committee.push(ms);
    for (const t of v.namedTickers) {
      let arr = byTicker.get(t);
      if (!arr) {
        arr = [];
        byTicker.set(t, arr);
      }
      arr.push(ms);
    }
  }
  committee.sort((a, b) => a - b);
  for (const arr of byTicker.values()) arr.sort((a, b) => a - b);
  return { committee, byTicker };
}

/** True if `sorted` contains a value in [lo, hi]. Binary search, O(log n). */
function anyInRange(sorted: number[], lo: number, hi: number): boolean {
  let a = 0;
  let b = sorted.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (sorted[m] < lo) a = m + 1;
    else b = m;
  }
  return a < sorted.length && sorted[a] <= hi;
}

/** Count distinct trades with a nexus vote within `windowDays`, via the index. */
export function countNexusIndexed(
  trades: IndexedTrade[],
  index: NexusIndex,
  windowDays: number,
): number {
  const w = windowDays * MS_PER_DAY;
  let count = 0;
  for (const t of trades) {
    if (ETF.has(t.ticker)) continue;
    const lo = t.txMs;
    const hi = t.txMs + w;
    if (anyInRange(index.committee, lo, hi)) {
      count++;
      continue;
    }
    const tk = index.byTicker.get(t.ticker);
    if (tk && anyInRange(tk, lo, hi)) count++;
  }
  return count;
}

/**
 * Canonical entry point: count distinct trades that have a nexus vote within
 * `windowDays` after them. Builds the index then delegates, so there is exactly
 * one rule shared by the observation, the tests, and every permutation draw.
 */
export function countNexus(trades: Trade[], votes: NexusVote[], windowDays: number): number {
  const index = buildNexusIndex(votes);
  const indexed = trades.map(t => ({ ticker: t.ticker, txMs: Date.parse(t.txDate) }));
  return countNexusIndexed(indexed, index, windowDays);
}
