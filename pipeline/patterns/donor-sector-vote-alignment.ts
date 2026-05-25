/**
 * Detector: donor-sector-vote-alignment
 *
 * Pattern: a member sponsors legislation in the same economic-sector theme that
 * their campaign donors are concentrated in. The donor analogue of the trade↔
 * bill nexus. Reuses the SAME theme space and theme_bill_match crosswalk.
 *
 * Spine (sponsorship — the tightest reading): a hit requires the member to be
 * the SPONSOR (not merely a cosponsor or floor-voter) of ≥1 focused bill in a
 * theme that is among their TOP donor themes by dollars. Sponsoring is a
 * deliberate act; everyone votes on everything, few author bills — so this is
 * the hardest signal to dismiss as coincidence, consistent with Phase 1's
 * "credible patterns are sparse" finding.
 *
 * Donor side (v_member_donor_theme): money is mapped to economic-sector themes
 * via donor_industry_theme. UNMAPPED money (Labor, Ideology, Lawyers, Retired,
 * Education, public-sector) is excluded by construction, so "top donor theme"
 * means top among tradable-industry themes only — stated plainly in the finding.
 *
 * Thresholds (tightened 2026-05-25 after the sponsored-bill loader gave the
 * detector complete policy-area coverage — see db/load-sponsored.ts. The 0.10/
 * top-3 baseline was set when only ~52 sponsored bills carried subjects; with
 * full coverage it fired on 35/37 members and stopped discriminating):
 *   - A theme qualifies as "top" if it ranks in the member's top 3 mapped themes
 *     AND accounts for ≥20% of their mapped industry dollars (genuine donor
 *     concentration, above the observed roster median of ~21%).
 *   - The member must SPONSOR ≥3 focused bills in that theme — sustained
 *     legislative engagement, not a one-off anecdote.
 *   - Bills are FOCUSED only: the same broad-vehicle exclusions and ≤25-subject
 *     guard as v_trade_bill_nexus (appropriations/omnibus/NDAA etc. carry dozens
 *     of incidental subjects and are not evidence of sector intent).
 *   Known confound (future refinement, not yet handled): a prolific member who
 *   sponsors hundreds of bills will clear the count floor in many themes; a
 *   share-of-sponsored-output measure would discriminate better than a raw count.
 *
 * Editorial: finding is one neutral sentence — dollars, share, sponsored count,
 * cycle span. No moralizing words.
 */

import { getDb } from '../../db/init.js';
import type { PatternDetector, PatternHit, CitedRow } from './types.js';

const NAME = 'donor-sector-vote-alignment';
const TOP_N = 3;
const MIN_SHARE = 0.20;
const MIN_BILLS = 3;

// Member's donor money rolled up to mapped themes, across all loaded cycles.
const DONOR_SQL = `
SELECT theme,
       SUM(theme_total) AS theme_total,
       MIN(cycle)       AS min_cycle,
       MAX(cycle)       AS max_cycle
FROM v_member_donor_theme
WHERE member_id = ?
GROUP BY theme
ORDER BY theme_total DESC
`;

// Focused bills the member SPONSORED, matched to themes. Mirrors the
// theme_bill_match join + focused-bill guards in v_trade_bill_nexus.
//
// bill_id convention mismatch: the `bills` table uses slash ids ("119/hr/3223")
// while `bill_subjects`/`votes` use dash ids ("119-hr-3223"). Normalize bills'
// slashes to dashes for the join, else it silently returns zero. The type guard
// regex is already separator-agnostic.
const SPONSORED_SQL = `
SELECT DISTINCT b.bill_id, b.title, b.introduced_at::text AS introduced_at, m.theme
FROM bills b
JOIN bill_subjects bs ON bs.bill_id = REPLACE(b.bill_id, '/', '-')
JOIN theme_bill_match m ON (
      (m.policy_area IS NOT NULL AND bs.policy_area = m.policy_area)
   OR (m.subject_pattern IS NOT NULL AND bs.subject ILIKE m.subject_pattern
        AND (SELECT COUNT(*) FROM bill_subjects b2 WHERE b2.bill_id = REPLACE(b.bill_id, '/', '-')) <= 25)
)
WHERE b.member_id = ?
  AND b.sponsor_role = 'sponsor'
  AND b.title IS NOT NULL
  AND LENGTH(b.title) >= 6
  AND b.title NOT ILIKE 'Providing for consideration%'
  AND b.title NOT ILIKE '%appropriations%'
  AND b.title NOT ILIKE '%consolidated%'
  AND b.title NOT ILIKE '%continuing%'
  AND b.title NOT ILIKE '%relief act%'
  AND b.title NOT ILIKE '%reconciliation%'
  AND b.title NOT ILIKE '%omnibus%'
  AND b.title NOT ILIKE '%national defense authorization%'
  AND b.title NOT ILIKE '%rescissions act%'
  AND b.title NOT ILIKE '%concurrent resolution%'
  AND b.title NOT ILIKE '%congressional budget for%'
  AND regexp_extract(b.bill_id, '[-/](hr|s|hjres|sjres)[-/]', 1) <> ''
`;

// Top contributing industries within a theme, for citation.
const TOP_INDUSTRIES_SQL = `
SELECT di.industry, SUM(di.total) AS total
FROM donor_industry di
JOIN donor_industry_theme t ON di.industry ILIKE t.industry_pattern
WHERE di.member_id = ? AND t.theme = ?
GROUP BY di.industry
ORDER BY total DESC
LIMIT 3
`;

interface DonorTheme { theme: string; theme_total: number; min_cycle: number; max_cycle: number; }
interface SponsoredBill { bill_id: string; title: string; introduced_at: string | null; theme: string; }

const usd = (n: number) => '$' + Math.round(n).toLocaleString();

export const donorSectorVoteAlignment: PatternDetector = {
  name: NAME,
  description:
    'Member sponsored focused legislation in an economic-sector theme that is ' +
    'among the top themes their campaign donors are concentrated in.',

  async detect(memberSlug: string): Promise<PatternHit[]> {
    const conn = await getDb();

    const dRes = await conn.run(DONOR_SQL, [memberSlug]);
    const donorThemes = (await dRes.getRowObjects()) as unknown as DonorTheme[];
    if (donorThemes.length === 0) return [];

    const mappedTotal = donorThemes.reduce((a, t) => a + Number(t.theme_total), 0);
    if (mappedTotal <= 0) return [];

    // Top donor themes: top-N by dollars AND ≥ MIN_SHARE of mapped money.
    const topThemes = donorThemes
      .slice(0, TOP_N)
      .filter(t => Number(t.theme_total) / mappedTotal >= MIN_SHARE);
    if (topThemes.length === 0) return [];

    const sRes = await conn.run(SPONSORED_SQL, [memberSlug]);
    const sponsored = (await sRes.getRowObjects()) as unknown as SponsoredBill[];
    if (sponsored.length === 0) return [];

    const sponsoredByTheme = new Map<string, SponsoredBill[]>();
    for (const b of sponsored) {
      const arr = sponsoredByTheme.get(b.theme) ?? [];
      arr.push(b);
      sponsoredByTheme.set(b.theme, arr);
    }

    const hits: PatternHit[] = [];
    for (const dt of topThemes) {
      const bills = sponsoredByTheme.get(dt.theme);
      if (!bills || bills.length < MIN_BILLS) continue;

      const share = Number(dt.theme_total) / mappedTotal;
      const themeTotal = Number(dt.theme_total);
      const cycleSpan = dt.min_cycle === dt.max_cycle
        ? `${dt.min_cycle}` : `${dt.min_cycle}–${dt.max_cycle}`;

      const citing: CitedRow[] = [];
      const iRes = await conn.run(TOP_INDUSTRIES_SQL, [memberSlug, dt.theme]);
      const inds = (await iRes.getRowObjects()) as unknown as Array<{ industry: string; total: number }>;
      for (const ind of inds) {
        citing.push({
          kind: 'donor',
          id: `${memberSlug}|${dt.theme}|${ind.industry}`,
          label: `${ind.industry} (${usd(Number(ind.total))})`,
        });
      }

      const dates = new Set<string>();
      const billTitles: string[] = [];
      for (const b of bills) {
        citing.push({ kind: 'bill', id: b.bill_id, label: b.title.slice(0, 90) });
        if (b.introduced_at) dates.add(b.introduced_at);
        billTitles.push(b.title);
      }

      const n = bills.length;
      const titlePreview = billTitles.slice(0, 2).map(t => `"${t.slice(0, 70)}"`).join(', ');
      const finding =
        `Donors in ${dt.theme} gave ${usd(themeTotal)} (${Math.round(share * 100)}% of the member's ` +
        `mapped industry contributions, ${cycleSpan}); the member sponsored ${n} focused bill` +
        `${n === 1 ? '' : 's'} in that policy area${titlePreview ? `: ${titlePreview}` : ''}.`;

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

export default donorSectorVoteAlignment;
