/**
 * Monte-Carlo null engine + the two null-model draw factories.
 * RNG is injected so results are reproducible (see _rng.ts seedFrom).
 */
import {
  buildNexusIndex,
  countNexusIndexed,
  type Trade,
  type NexusVote,
  type IndexedTrade,
} from './_nexus.js';

export interface PermResult {
  observed: number;
  expected: number;
  pValue: number;
  zScore: number;
  nPerm: number;
}

export function permutationTest(opts: {
  observed: number;
  nPerm: number;
  seed: number; // recorded for provenance; the draw closure owns the rng
  draw: () => number; // one resampled nexus count under the null
}): PermResult {
  const { observed, nPerm } = opts;
  const samples = new Array<number>(nPerm);
  let sum = 0;
  let atLeast = 0;
  for (let i = 0; i < nPerm; i++) {
    const c = opts.draw();
    samples[i] = c;
    sum += c;
    if (c >= observed) atLeast++;
  }
  const expected = sum / nPerm;
  let varSum = 0;
  for (const c of samples) varSum += (c - expected) ** 2;
  const sd = Math.sqrt(varSum / nPerm);
  const zScore = sd === 0 ? 0 : (observed - expected) / sd;
  const pValue = atLeast / nPerm; // one-sided upper tail
  return { observed, expected, pValue, zScore, nPerm };
}

const MS_PER_DAY = 86_400_000;

/** Weekday (Mon-Fri) epoch-ms in [start,end] inclusive — market-open approximation. */
function weekdayPoolMs(start: string, end: string): number[] {
  const pool: number[] = [];
  for (let ms = Date.parse(start); ms <= Date.parse(end); ms += MS_PER_DAY) {
    const dow = new Date(ms).getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) pool.push(ms);
  }
  return pool;
}

/**
 * Calendar randomization (low-volume members): each draw reassigns every trade
 * to a random market-open day in [windowStart,windowEnd], ticker fixed, then
 * counts nexus. Index + slot buffer are built once; the hot loop is O(trades).
 * One rng() per trade, in trade order — same sequence as a naive shuffle, so
 * results are seed-identical to the unoptimised path.
 */
export function calendarDraw(
  trades: Trade[],
  votes: NexusVote[],
  windowDays: number,
  windowStart: string,
  windowEnd: string,
  rng: () => number,
): () => number {
  const index = buildNexusIndex(votes);
  const pool = weekdayPoolMs(windowStart, windowEnd);
  const slot: IndexedTrade[] = trades.map(t => ({ ticker: t.ticker, txMs: 0 }));
  return () => {
    for (let i = 0; i < slot.length; i++) {
      slot[i].txMs = pool[Math.floor(rng() * pool.length)];
    }
    return countNexusIndexed(slot, index, windowDays);
  };
}

/**
 * Volume-preserving date shuffle (basket traders): each draw permutes the
 * multiset of the member's actual trade dates across trades (tickers fixed),
 * then counts nexus. Preserves trading cadence + basket size. Fisher-Yates
 * consumes rng identically to the unoptimised path -> seed-identical results.
 */
export function volumeShuffleDraw(
  trades: Trade[],
  votes: NexusVote[],
  windowDays: number,
  rng: () => number,
): () => number {
  const index = buildNexusIndex(votes);
  const baseDatesMs = trades.map(t => Date.parse(t.txDate));
  const slot: IndexedTrade[] = trades.map(t => ({ ticker: t.ticker, txMs: 0 }));
  return () => {
    const d = baseDatesMs.slice();
    for (let i = d.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [d[i], d[j]] = [d[j], d[i]];
    }
    for (let i = 0; i < slot.length; i++) slot[i].txMs = d[i];
    return countNexusIndexed(slot, index, windowDays);
  };
}
