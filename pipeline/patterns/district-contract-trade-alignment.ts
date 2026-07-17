/**
 * Detector: district-contract-trade-alignment
 *
 * Pattern: federal contract dollars flowing into the member's district are
 * concentrated in an economic-sector theme, and the member personally trades
 * in that same theme. Personal financial exposure to an industry that is
 * simultaneously a dominant recipient of federal contracts performed in the
 * district they represent. Design: docs/2026-07-15-district-contracts-detector.md.
 *
 * Spine — two-sided concentration, ALL required for a hit:
 *   1. Theme is a TOP district-contract theme: top-3 by mapped transaction
 *      dollars AND ≥20% of mapped district contract dollars in the window
 *      (the donor detector's TOP_N/MIN_SHARE shape).
 *   2. The member reported ≥3 PFD transactions in that theme in the window.
 *   3. Theme is also among the member's top-3 traded themes by transaction
 *      count — the basket-trader guard: for a member trading dozens of tickers
 *      a day, SOME trades land in every theme, so mere presence is noise;
 *      concentration on both sides is what makes the overlap a pattern.
 *
 * Substrate: district_contract_naics (USAspending, district_original filter,
 * transactions spending level — House only, so senators return [] by
 * construction) mapped via naics_theme (longest-prefix-wins); trades mapped
 * via the canonical ticker_sectors → sic_theme + ticker_theme_override join
 * from v_trade_bill_nexus. Unmapped NAICS money is excluded by construction —
 * findings say "of mapped district contract dollars".
 *
 * Thresholds are provisional until the permutation null baseline is recorded
 * in the design doc (Step-0 rule: null baseline before hand-tracing).
 *
 * Editorial: finding is one neutral sentence — dollars, share, counts, window.
 * No moralizing words.
 */

import { getDb } from '../../db/init.js';
import type { PatternDetector, PatternHit, CitedRow } from './types.js';

const NAME = 'district-contract-trade-alignment';
const TOP_N = 3;
const MIN_SHARE = 0.20;
const MIN_TRADES = 3;
const TRADE_TOP_N = 3;
// District-distinctiveness: the theme's share of this district's mapped
// dollars must be ≥1.5× the roster-median share for that theme. Added after
// the first permutation baseline (2026-07-16, p=0.48): without it the overlap
// is base-rate coupling — Pharma/Tech dominate both federal contracting and
// congressional portfolios EVERYWHERE, so trades matched a random other
// district's mix as often as the member's own. Both baseline runs are
// recorded in the design doc.
const DISTINCT_FACTOR = 1.5;
export const CY_START = 2023;
export const CY_END = 2025;

// District contract dollars rolled up to mapped themes, longest-prefix-wins.
// Exported so the render layer's District contracts section shows exactly the
// substrate this detector reads — one source of truth, no drift.
export const CONTRACT_SQL = `
WITH mapped AS (
  SELECT d.member_id, d.cy, d.naics, d.naics_desc, d.amount,
         (SELECT nt.theme FROM naics_theme nt
           WHERE d.naics LIKE nt.naics_prefix || '%'
           ORDER BY LENGTH(nt.naics_prefix) DESC, nt.naics_prefix
           LIMIT 1) AS theme
  FROM district_contract_naics d
  WHERE d.member_id = ? AND d.cy BETWEEN ? AND ?
)
SELECT theme, SUM(amount) AS theme_total
FROM mapped
WHERE theme IS NOT NULL
GROUP BY theme
ORDER BY theme_total DESC, theme
`;

// Total mapped + unmapped, so the mapped share is statable.
export const CONTRACT_TOTAL_SQL = `
SELECT SUM(amount) AS grand_total
FROM district_contract_naics
WHERE member_id = ? AND cy BETWEEN ? AND ?
`;

// Every loaded district's mapped theme totals — substrate for the roster-
// median distinctiveness condition. Total-order ORDER BY (render-path rule).
export const ROSTER_CONTRACT_SQL = `
WITH mapped AS (
  SELECT d.member_id, d.amount,
         (SELECT nt.theme FROM naics_theme nt
           WHERE d.naics LIKE nt.naics_prefix || '%'
           ORDER BY LENGTH(nt.naics_prefix) DESC, nt.naics_prefix
           LIMIT 1) AS theme
  FROM district_contract_naics d
  WHERE d.cy BETWEEN ? AND ?
)
SELECT member_id, theme, SUM(amount) AS theme_total
FROM mapped
WHERE theme IS NOT NULL
GROUP BY member_id, theme
ORDER BY member_id, theme_total DESC, theme
`;

// Top NAICS rows within a theme, for citation (the clickable substrate rows).
const TOP_NAICS_SQL = `
WITH mapped AS (
  SELECT d.member_id, d.cy, d.naics, d.naics_desc, d.amount,
         (SELECT nt.theme FROM naics_theme nt
           WHERE d.naics LIKE nt.naics_prefix || '%'
           ORDER BY LENGTH(nt.naics_prefix) DESC, nt.naics_prefix
           LIMIT 1) AS theme
  FROM district_contract_naics d
  WHERE d.member_id = ? AND d.cy BETWEEN ? AND ?
)
SELECT cy, naics, naics_desc, amount
FROM mapped
WHERE theme = ?
ORDER BY amount DESC, cy, naics
LIMIT 3
`;

// Member's PFD transactions mapped to themes via the canonical trade-side
// join (ticker_sectors → sic_theme, ticker_theme_override wins) — the same
// mapping v_trade_bill_nexus uses.
export const TRADES_SQL = `
SELECT t.filing_id, t.tx_index, t.ticker, t.tx_type, t.tx_date::text AS tx_date,
       t.amount_band, COALESCE(o.theme, st.theme) AS theme
FROM pfd_transactions t
JOIN ticker_sectors ts ON ts.ticker = UPPER(t.ticker)
LEFT JOIN sic_theme st ON st.sic = ts.sic
LEFT JOIN ticker_theme_override o ON o.ticker = UPPER(t.ticker)
WHERE t.member_id = ?
  AND t.ticker IS NOT NULL
  AND t.tx_date BETWEEN ? AND ?
  AND COALESCE(o.theme, st.theme) IS NOT NULL
ORDER BY t.tx_date, t.filing_id, t.tx_index
`;

export interface ContractTheme { theme: string; theme_total: number }
interface TradeRow {
  filing_id: string; tx_index: number; ticker: string; tx_type: string;
  tx_date: string; amount_band: string | null; theme: string;
}

const usd = (n: number) => '$' + Math.round(n).toLocaleString();

/**
 * Roster-median share per theme: for each theme, the median of (theme dollars /
 * district's mapped dollars) across all loaded districts. Districts where the
 * theme is absent count as share 0 — a theme most districts don't have at all
 * is exactly the kind a high share is distinctive in. Pure so the baseline
 * shares the computation.
 */
export function themeMedianShares(byMember: Map<string, ContractTheme[]>): Map<string, number> {
  const themes = new Set<string>();
  const shares = new Map<string, number[]>();
  for (const rows of byMember.values()) for (const r of rows) themes.add(r.theme);
  for (const rows of byMember.values()) {
    const total = rows.reduce((a, t) => a + Number(t.theme_total), 0);
    const present = new Map(rows.map((r) => [r.theme, Number(r.theme_total)]));
    for (const th of themes) {
      const arr = shares.get(th) ?? [];
      arr.push(total > 0 ? (present.get(th) ?? 0) / total : 0);
      shares.set(th, arr);
    }
  }
  const medians = new Map<string, number>();
  for (const [th, arr] of shares) {
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    medians.set(th, s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
  }
  return medians;
}

/**
 * The pure spine: which themes qualify as hits for a (district, trader) pair.
 * `contractThemes` must be ordered theme_total DESC (CONTRACT_SQL does this);
 * `tradeCounts` is transactions per theme; `medianShares` is the roster-median
 * share per theme (invariant under member↔district shuffling, so the null
 * test is fair). Exported so the permutation baseline exercises EXACTLY the
 * shipped thresholds on shuffled pairs — one decision procedure, no drift.
 */
export function qualifyingThemes(
  contractThemes: ContractTheme[],
  tradeCounts: Map<string, number>,
  medianShares: Map<string, number>,
): string[] {
  const mappedTotal = contractThemes.reduce((a, t) => a + Number(t.theme_total), 0);
  if (mappedTotal <= 0) return [];

  const topContract = contractThemes
    .slice(0, TOP_N)
    .filter((t) => Number(t.theme_total) / mappedTotal >= MIN_SHARE)
    // District-distinctiveness: unusually concentrated vs the roster median,
    // not just big — kills the everywhere-hot base-rate coupling.
    .filter((t) => {
      const share = Number(t.theme_total) / mappedTotal;
      return share >= DISTINCT_FACTOR * (medianShares.get(t.theme) ?? 0);
    });

  const topTraded = [...tradeCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TRADE_TOP_N)
    .map(([theme]) => theme);

  return topContract
    .filter((t) => (tradeCounts.get(t.theme) ?? 0) >= MIN_TRADES)
    .filter((t) => topTraded.includes(t.theme)) // basket-trader guard
    .map((t) => t.theme);
}

export const districtContractTradeAlignment: PatternDetector = {
  name: NAME,
  description:
    'Federal contract dollars into the member\'s district are concentrated in ' +
    'an economic-sector theme the member also personally trades in.',

  async detect(memberSlug: string): Promise<PatternHit[]> {
    const conn = await getDb();
    const window: [number, number] = [CY_START, CY_END];

    const cRes = await conn.run(CONTRACT_SQL, [memberSlug, ...window]);
    const contractThemes = (await cRes.getRowObjects()) as unknown as ContractTheme[];
    if (contractThemes.length === 0) return []; // senators / not-yet-loaded members

    const mappedTotal = contractThemes.reduce((a, t) => a + Number(t.theme_total), 0);
    if (mappedTotal <= 0) return [];

    const tRes = await conn.run(TRADES_SQL, [memberSlug, `${CY_START}-01-01`, `${CY_END}-12-31`]);
    const trades = (await tRes.getRowObjects()) as unknown as TradeRow[];
    if (trades.length === 0) return [];

    const tradesByTheme = new Map<string, TradeRow[]>();
    for (const t of trades) {
      const arr = tradesByTheme.get(t.theme) ?? [];
      arr.push(t);
      tradesByTheme.set(t.theme, arr);
    }
    const tradeCounts = new Map([...tradesByTheme].map(([k, v]) => [k, v.length]));

    const rRes = await conn.run(ROSTER_CONTRACT_SQL, window);
    const rosterRows = (await rRes.getRowObjects()) as unknown as Array<ContractTheme & { member_id: string }>;
    const byMember = new Map<string, ContractTheme[]>();
    for (const r of rosterRows) {
      const arr = byMember.get(r.member_id) ?? [];
      arr.push({ theme: r.theme, theme_total: r.theme_total });
      byMember.set(r.member_id, arr);
    }
    const medianShares = themeMedianShares(byMember);

    const qualifying = new Set(qualifyingThemes(contractThemes, tradeCounts, medianShares));

    const hits: PatternHit[] = [];
    for (const ct of contractThemes) {
      if (!qualifying.has(ct.theme)) continue;
      const themeTrades = tradesByTheme.get(ct.theme)!;

      const themeTotal = Number(ct.theme_total);
      const share = themeTotal / mappedTotal;

      const citing: CitedRow[] = [];
      const nRes = await conn.run(TOP_NAICS_SQL, [memberSlug, ...window, ct.theme]);
      const naicsRows = (await nRes.getRowObjects()) as unknown as Array<{
        cy: number; naics: string; naics_desc: string | null; amount: number;
      }>;
      for (const n of naicsRows) {
        citing.push({
          kind: 'contract',
          id: `${memberSlug}|${n.cy}|${n.naics}`,
          label: `${n.naics} ${n.naics_desc ?? ''} CY${n.cy} (${usd(Number(n.amount))})`.trim(),
        });
      }

      const dates = new Set<string>();
      const tickers = new Set<string>();
      for (const t of themeTrades) {
        citing.push({
          kind: 'trade',
          id: `${t.filing_id}|${t.tx_index}`,
          label: `${t.ticker} ${t.tx_type} ${t.tx_date}${t.amount_band ? ` (${t.amount_band})` : ''}`,
        });
        dates.add(t.tx_date);
        tickers.add(t.ticker.toUpperCase());
      }

      const n = themeTrades.length;
      const tickerList = [...tickers].sort().slice(0, 4).join(', ');
      const finding =
        `Federal contractors in ${ct.theme} transacted ${usd(themeTotal)} in the member's district ` +
        `over CY${CY_START}–${CY_END} (${Math.round(share * 100)}% of mapped district contract dollars); ` +
        `the member reported ${n} trade${n === 1 ? '' : 's'} in that theme (${tickerList}).`;

      hits.push({
        pattern: NAME,
        member: memberSlug,
        finding,
        intensity: Math.min(1, share + 0.1 * Math.min(n, 5)),
        citing,
        dates: [...dates].sort(),
        detectedAt: new Date().toISOString(),
      });
    }

    return hits;
  },
};

export default districtContractTradeAlignment;
