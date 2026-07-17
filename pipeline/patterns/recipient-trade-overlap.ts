/**
 * Pure spine of the recipient-trade detector
 * (docs/2026-07-17-recipient-trade-detector.md). Shared verbatim by the
 * observed statistic, the member↔district permutation null, and the
 * ticker-identity negative control — one decision procedure, no drift
 * (the district-contract-baseline lesson).
 *
 * S1 (breadth): count of distinct tickers both traded in-window and confirmed
 * as district-contract recipients — a $500 contract weighs the same as $5B by
 * design. S2 (exposure): Σ district contract dollars of those tickers. Both
 * must clear the gate.
 */

export interface ConfirmRow { recipientKey: string; ticker: string }
export interface RecipientAmount { recipientKey: string; amount: number }

/**
 * Pre-registered ubiquity exclusion: a ticker whose confirmed recipients
 * appear in strictly more than 1/3 of roster districts carries no district
 * information (design criterion, not a tuned constant — see spec).
 */
export function excludedTickers(
  confirms: ConfirmRow[],
  districtRows: Map<string, RecipientAmount[]>,
  nDistricts: number,
): Set<string> {
  const byKey = new Map(confirms.map((c) => [c.recipientKey, c.ticker]));
  const tickerDistricts = new Map<string, Set<string>>();
  for (const [district, rows] of districtRows) {
    for (const r of rows) {
      const t = byKey.get(r.recipientKey);
      if (!t) continue;
      let s = tickerDistricts.get(t);
      if (!s) { s = new Set(); tickerDistricts.set(t, s); }
      s.add(district);
    }
  }
  const out = new Set<string>();
  for (const [t, ds] of tickerDistricts) if (ds.size > nDistricts / 3) out.add(t);
  return out;
}

/** One district's confirmed, non-excluded contract dollars per ticker. */
export function districtTickerDollars(
  rows: RecipientAmount[],
  confirms: Map<string, string>,
  excluded: Set<string>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const t = confirms.get(r.recipientKey);
    if (!t || excluded.has(t)) continue;
    out.set(t, (out.get(t) ?? 0) + Number(r.amount));
  }
  return out;
}

/**
 * Roster-level S1/S2 for one member↔district assignment. assignment[i] is the
 * district (keyed by its member_id) that member memberIds[i] is scored
 * against; identity assignment = observed. Permutations preserve each
 * member's trade set and each district's dollars map unchanged — only the
 * pairing varies (spec §Exchangeability).
 */
export function rosterStats(
  memberIds: string[],
  assignment: string[],
  traded: Map<string, Set<string>>,
  dollars: Map<string, Map<string, number>>,
): { s1: number; s2: number } {
  let s1 = 0, s2 = 0;
  for (let i = 0; i < memberIds.length; i++) {
    const t = traded.get(memberIds[i]);
    if (!t || t.size === 0) continue;
    for (const [tick, amt] of dollars.get(assignment[i]) ?? []) {
      if (t.has(tick)) { s1++; s2 += amt; }
    }
  }
  return { s1, s2 };
}

/**
 * Negative control (pre-registered): permute confirmed ticker identities
 * across the confirm table. Recipient keys — and therefore each district's
 * recipient count and dollars — stay fixed; each member's trade set is
 * untouched; only WHICH ticker each confirmed recipient is, is scrambled.
 * A detector that fires on this is reading marginals, not pairings.
 */
export function scrambleConfirmTickers(confirms: ConfirmRow[], rng: () => number): ConfirmRow[] {
  const tickers = confirms.map((c) => c.ticker);
  for (let i = tickers.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [tickers[i], tickers[j]] = [tickers[j], tickers[i]];
  }
  return confirms.map((c, i) => ({ recipientKey: c.recipientKey, ticker: tickers[i] }));
}
