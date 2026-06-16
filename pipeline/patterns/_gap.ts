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
