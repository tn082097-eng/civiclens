/**
 * Pure gap rule: for each trade, the minimum day-gap to a SAME-THEME vote that
 * falls 0..windowDays AFTER it (trade before vote). Mirrors _nexus.ts: votes are
 * folded ONCE into a per-theme sorted date index so each trade is an O(log V)
 * lookup — a per-pair permutation re-runs this thousands of times cheaply.
 */
export interface ThemeTrade {
  id: string;
  txDate: string; // ISO yyyy-mm-dd
  theme: string;
}
export interface ThemeVote {
  id: string;
  voteDate: string; // ISO yyyy-mm-dd
  theme: string;
}
export interface IndexedTrade {
  id: string;
  theme: string;
  txMs: number;
}

/** theme -> ascending epoch-ms of that theme's vote dates. */
export type ThemeVoteIndex = Map<string, number[]>;

const MS_PER_DAY = 86_400_000;

export function buildThemeVoteIndex(votes: ThemeVote[]): ThemeVoteIndex {
  const byTheme: ThemeVoteIndex = new Map();
  for (const v of votes) {
    let arr = byTheme.get(v.theme);
    if (!arr) {
      arr = [];
      byTheme.set(v.theme, arr);
    }
    arr.push(Date.parse(v.voteDate));
  }
  for (const arr of byTheme.values()) arr.sort((a, b) => a - b);
  return byTheme;
}

/** First index with value >= lo via binary search, or -1 if none. */
function firstAtLeast(sorted: number[], lo: number): number {
  let a = 0;
  let b = sorted.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (sorted[m] < lo) a = m + 1;
    else b = m;
  }
  return a < sorted.length ? a : -1;
}

/** Min gap (whole days) to a same-theme vote in [txMs, txMs + window], or undefined. */
export function minGapIndexed(
  t: IndexedTrade,
  index: ThemeVoteIndex,
  windowDays: number,
): number | undefined {
  const arr = index.get(t.theme);
  if (!arr) return undefined;
  const hi = t.txMs + windowDays * MS_PER_DAY;
  const i = firstAtLeast(arr, t.txMs);
  if (i === -1 || arr[i] > hi) return undefined;
  return Math.round((arr[i] - t.txMs) / MS_PER_DAY);
}

/** Canonical entry point: trade id -> min same-theme day-gap (only trades with a match). */
export function minGapsByTrade(
  trades: ThemeTrade[],
  votes: ThemeVote[],
  windowDays: number,
): Map<string, number> {
  const index = buildThemeVoteIndex(votes);
  const out = new Map<string, number>();
  for (const t of trades) {
    const g = minGapIndexed({ id: t.id, theme: t.theme, txMs: Date.parse(t.txDate) }, index, windowDays);
    if (g !== undefined) out.set(t.id, g);
  }
  return out;
}

const WEEKEND = new Set([0, 6]);
function weekdayPoolMs(start: string, end: string): number[] {
  const pool: number[] = [];
  for (let ms = Date.parse(start); ms <= Date.parse(end); ms += MS_PER_DAY) {
    if (!WEEKEND.has(new Date(ms).getUTCDay())) pool.push(ms);
  }
  return pool;
}

/**
 * Per-pair lower-tail null. For each draw, every trade's date is resampled
 * (calendar: a random market-open day in [windowStart,windowEnd]; volume: a
 * Fisher-Yates permutation of the member's own trade dates), theme matching is
 * re-applied, and each observed trade is credited if its resampled gap <= its
 * observed gap. p_pair = (1 + hits) / (nPerm + 1), one-sided lower tail.
 */
export function perPairLowerTail(opts: {
  trades: ThemeTrade[];
  votes: ThemeVote[];
  windowDays: number;
  observed: Map<string, number>;
  nPerm: number;
  rng: () => number;
  mode: 'calendar' | 'volume-shuffle';
  windowStart?: string;
  windowEnd?: string;
}): Map<string, number> {
  const { trades, votes, windowDays, observed, nPerm, rng, mode } = opts;
  const index = buildThemeVoteIndex(votes);
  const slot: IndexedTrade[] = trades.map(t => ({ id: t.id, theme: t.theme, txMs: 0 }));
  const baseDatesMs = trades.map(t => Date.parse(t.txDate));
  const pool = mode === 'calendar' ? weekdayPoolMs(opts.windowStart!, opts.windowEnd!) : [];
  const hits = new Map<string, number>();
  for (const id of observed.keys()) hits.set(id, 0);

  for (let k = 0; k < nPerm; k++) {
    if (mode === 'calendar') {
      for (let i = 0; i < slot.length; i++) slot[i].txMs = pool[Math.floor(rng() * pool.length)];
    } else {
      const d = baseDatesMs.slice();
      for (let i = d.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [d[i], d[j]] = [d[j], d[i]];
      }
      for (let i = 0; i < slot.length; i++) slot[i].txMs = d[i];
    }
    for (const s of slot) {
      const obs = observed.get(s.id);
      if (obs === undefined) continue;
      const g = minGapIndexed(s, index, windowDays);
      if (g !== undefined && g <= obs) hits.set(s.id, hits.get(s.id)! + 1);
    }
  }

  const p = new Map<string, number>();
  for (const [id, h] of hits) p.set(id, (1 + h) / (nPerm + 1));
  return p;
}
