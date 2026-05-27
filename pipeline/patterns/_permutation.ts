/**
 * Monte-Carlo null engine + the two null-model draw factories.
 * RNG is injected so results are reproducible (see _rng.ts seedFrom).
 */
import { countNexus, type Trade, type NexusVote } from './_nexus.js';

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
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Weekday (Mon-Fri) days in [start,end] inclusive — market-open approximation. */
function weekdayPool(start: string, end: string): string[] {
  const pool: string[] = [];
  for (let ms = Date.parse(start); ms <= Date.parse(end); ms += MS_PER_DAY) {
    const dow = new Date(ms).getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) pool.push(iso(ms));
  }
  return pool;
}

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Calendar randomization (low-volume members): each draw reassigns every trade
 * to a random market-open day in [windowStart,windowEnd], ticker fixed, then
 * counts nexus.
 */
export function calendarDraw(
  trades: Trade[],
  votes: NexusVote[],
  windowDays: number,
  windowStart: string,
  windowEnd: string,
  rng: () => number,
): () => number {
  const pool = weekdayPool(windowStart, windowEnd);
  return () => {
    const shuffled = trades.map(t => ({ ...t, txDate: pick(pool, rng) }));
    return countNexus(shuffled, votes, windowDays);
  };
}

/**
 * Volume-preserving date shuffle (basket traders): each draw permutes the
 * multiset of the member's actual trade dates across trades (tickers fixed),
 * then counts nexus. Preserves trading cadence + basket size.
 */
export function volumeShuffleDraw(
  trades: Trade[],
  votes: NexusVote[],
  windowDays: number,
  rng: () => number,
): () => number {
  const dates = trades.map(t => t.txDate);
  return () => {
    const d = dates.slice();
    for (let i = d.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [d[i], d[j]] = [d[j], d[i]];
    }
    const shuffled = trades.map((t, i) => ({ ...t, txDate: d[i] }));
    return countNexus(shuffled, votes, windowDays);
  };
}
