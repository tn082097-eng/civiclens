/**
 * Sector ↔ bill-subject crosswalk seeder. Static, deterministic, no network.
 *
 * Two small auditable tables (the ONLY judgment in the relevance edge — a
 * hand-curated, version-controlled mapping, NOT an LLM):
 *   sic_theme(sic, theme)            — which industry theme each traded SIC is
 *   theme_bill_match(theme, policy_area, subject_pattern)
 *                                    — which Congress.gov bill policy areas /
 *                                      subject keyword patterns mean a bill
 *                                      materially affects that theme's industry
 *
 * A trade↔bill nexus exists when the ticker's SIC → theme matches a bill's
 * policy_area (exact) or any of its subjects (ILIKE pattern). See
 * `v_trade_bill_nexus` in schema.sql and SOURCES.md "Relevance edge".
 *
 * Usage:
 *   npx tsx db/load-sector-crosswalk.ts
 *   npx tsx agents/pipeline.ts --load-sector-crosswalk
 */

import { applySchema, getDb } from './init.js';

// SIC (4-digit) → theme. Covers exactly the SICs present among traded tickers.
const SIC_THEME: Record<string, string> = {
  // Energy
  '1311': 'Energy', '2911': 'Energy', '4922': 'Energy', '4931': 'Energy', '4911': 'Energy',
  // Pharma & Health
  '2834': 'Pharma & Health', '2836': 'Pharma & Health', '6324': 'Pharma & Health',
  '5122': 'Pharma & Health', '5047': 'Pharma & Health', '3841': 'Pharma & Health',
  // Banks & Finance
  '6021': 'Banks & Finance', '6199': 'Banks & Finance', '6211': 'Banks & Finance',
  '6221': 'Banks & Finance', '6282': 'Banks & Finance', '6311': 'Banks & Finance',
  // Defense & Aerospace
  '3721': 'Defense & Aerospace',
  // Tech, Software & Semiconductors
  '3571': 'Tech & Semiconductors', '3577': 'Tech & Semiconductors', '3674': 'Tech & Semiconductors',
  '3679': 'Tech & Semiconductors', '3663': 'Tech & Semiconductors', '3559': 'Tech & Semiconductors',
  '3357': 'Tech & Semiconductors', '7370': 'Tech & Semiconductors', '7372': 'Tech & Semiconductors',
  '7374': 'Tech & Semiconductors', '7389': 'Tech & Semiconductors',
  // Media & Telecom
  '4841': 'Media & Telecom', '7841': 'Media & Telecom', '7990': 'Media & Telecom',
  // Retail & Consumer Goods
  '5331': 'Retail & Consumer', '5200': 'Retail & Consumer', '5211': 'Retail & Consumer',
  '5712': 'Retail & Consumer', '5810': 'Retail & Consumer', '5961': 'Retail & Consumer',
  '2080': 'Retail & Consumer', '2060': 'Retail & Consumer', '2300': 'Retail & Consumer',
  '2320': 'Retail & Consumer', '3021': 'Retail & Consumer', '2840': 'Retail & Consumer',
  '3089': 'Retail & Consumer', '7011': 'Retail & Consumer',
  // Transportation & Logistics
  '4513': 'Transportation', '4210': 'Transportation', '4213': 'Transportation',
  '4011': 'Transportation', '4412': 'Transportation',
  // Industrials & Machinery
  '3531': 'Industrials', '3510': 'Industrials', '3585': 'Industrials', '3600': 'Industrials',
  '3711': 'Industrials', '8700': 'Industrials',
  // Materials, Mining & Chemicals
  '1000': 'Materials & Mining', '2810': 'Materials & Mining',
  // Real Estate
  '6798': 'Real Estate',
};

// theme → bill match rules. policy_area is an exact match on bill_subjects.policy_area;
// subject_pattern is an ILIKE against bill_subjects.subject. Either kind matches.
//
// POLICY-AREA-PRIMARY. Congress.gov's single editorial policy_area is the
// reliable relevance signal. Granular `subject` tags are deliberately NOT used
// as a broad surface: they over-match (a bill carries dozens of tangential tags,
// so '%technology%' fired on 162 unrelated bills) and are sometimes wrong (an
// amended vehicle keeps its original shell's subjects — CHIPS/HR 4346 carries no
// "semiconductor" subject at all). subjectPatterns are kept ONLY as a narrow,
// high-specificity supplement (unambiguous multi-word/technical terms that won't
// appear as incidental tags). Dangerous broad substrings deliberately dropped:
// '%ship%' (relationship/citizenship), '%securit%' (national security),
// '%property%' (intellectual property), '%drug%' (drug enforcement/crime),
// plus the catch-alls '%technolog%/%computer%/%internet%/%data%/%health%/%tax%'.
//
// Media & Telecom has NO policy_area rule on purpose: it shares the coarse
// "Science, Technology, Communications" area with Tech, so matching that area
// would put cable/broadcast names (WBD) on semiconductor bills (CHIPS). It
// matches specific broadcast/telecom subjects only.
const THEME_MATCH: Array<{ theme: string; policyAreas: string[]; subjectPatterns: string[] }> = [
  { theme: 'Energy',
    policyAreas: ['Energy', 'Environmental Protection'],
    subjectPatterns: ['%oil and gas%', '%natural gas%', '%electric power%', '%pipeline%'] },
  { theme: 'Pharma & Health',
    policyAreas: ['Health'],
    subjectPatterns: ['%pharmaceutic%', '%vaccine%'] },
  { theme: 'Banks & Finance',
    policyAreas: ['Finance and Financial Sector', 'Taxation'],
    subjectPatterns: [] },  // %insurance%/%banking%/%securities% dropped — they fire on
                            // incidental tags (gun/sanctions/disaster bills). Finance +
                            // Taxation policy areas cover genuine finance-sector bills.
  { theme: 'Payments',
    policyAreas: ['Finance and Financial Sector'],
    subjectPatterns: ['%payment%', '%credit card%', '%interchange%'] },
  { theme: 'Defense & Aerospace',
    policyAreas: ['Armed Forces and National Security'],
    subjectPatterns: ['%military%', '%aircraft%', '%missile%', '%armed forces%'] },
  { theme: 'Tech & Semiconductors',
    policyAreas: ['Science, Technology, Communications'],
    subjectPatterns: ['%semiconductor%'] },
  { theme: 'Media & Telecom',
    policyAreas: [],
    subjectPatterns: ['%broadcast%', '%television%', '%cable television%', '%film%', '%telecommunications%'] },
  { theme: 'Retail & Consumer',
    policyAreas: ['Commerce'],
    subjectPatterns: ['%consumer protection%', '%food safety%'] },
  { theme: 'Transportation',
    policyAreas: ['Transportation and Public Works'],
    subjectPatterns: ['%aviation%', '%railroad%', '%trucking%'] },
  { theme: 'Industrials',
    policyAreas: ['Commerce', 'Transportation and Public Works'],
    subjectPatterns: ['%motor vehicle%'] },  // %manufacturing% dropped (incidental on
                                             // appliance-standard/NDAA bills); %motor vehicle%
                                             // kept — it surfaces real EV/auto-industry bills.
  { theme: 'Materials & Mining',
    policyAreas: ['Public Lands and Natural Resources', 'Environmental Protection'],
    subjectPatterns: ['%mining%', '%mineral%'] },
  { theme: 'Real Estate',
    policyAreas: ['Housing and Community Development'],
    subjectPatterns: ['%real estate%', '%mortgage%'] },
];

// Per-ticker theme overrides (precedence over SIC→theme). SIC 7389
// "Business Services, NEC" is a grab-bag: it holds card networks / payment
// processors (V, PYPL, WEX) and an e-commerce marketplace (MELI) alongside
// genuine tech-services (AKAM stays Tech). Pin the misfiled ones.
const TICKER_OVERRIDE: Array<{ ticker: string; theme: string; note: string }> = [
  { ticker: 'V',    theme: 'Payments',          note: 'Visa — card network, SIC 7389 grab-bag, not Tech' },
  { ticker: 'PYPL', theme: 'Payments',          note: 'PayPal — payments, SIC 7389 grab-bag, not Tech' },
  { ticker: 'WEX',  theme: 'Payments',          note: 'WEX — fleet/corporate payments, SIC 7389, not Tech' },
  { ticker: 'MELI', theme: 'Retail & Consumer', note: 'MercadoLibre — e-commerce marketplace, SIC 7389, not Tech' },
];

// OpenSecrets industry name → theme (donor side). ILIKE patterns against
// donor_industry.industry, same hand-curated philosophy as theme_bill_match's
// subject_pattern. Maps to the SAME 12 economic-sector themes so donor exposure
// is comparable to the trade/bill theme space. Industries with no pattern here
// (Labor, Ideology, Lawyers, Retired, Education, public sector, single-issue
// groups) are deliberately UNMAPPED — they carry no tradable-industry theme.
//
// v2 crosswalk (2026-07-15) — tuned against the full 45-member 2024 load.
// Patterns must be mutually exclusive ACROSS themes: v_member_donor_theme
// dedupes multiple same-theme matches per industry, but an industry matching
// patterns in two different themes would double-count its dollars in both.
// lib/donor-crosswalk.test.ts trips on every observed collision case — run it
// after any pattern edit. v1 lessons baked in: '%mining%' caught 'Mining
// unions' (Labor money → Materials & Mining) and 'Coal mining' (already
// Energy via '%coal%'); '%real estate%' caught OpenSecrets' FIRE catch-all
// row 'Finance, Insurance & Real Estate' (already Banks & Finance via
// '%insurance%').
export const DONOR_INDUSTRY_THEME: Array<{ pattern: string; theme: string; note?: string }> = [
  // Energy & Natural Resources
  { pattern: '%oil & gas%', theme: 'Energy' },
  { pattern: '%electric utilit%', theme: 'Energy' },
  { pattern: '%natural gas%', theme: 'Energy' },
  { pattern: '%coal%', theme: 'Energy' },
  { pattern: '%alternative energy%', theme: 'Energy' },
  { pattern: '%nuclear energy%', theme: 'Energy' },
  { pattern: '%power utilit%', theme: 'Energy' },
  { pattern: '%petroleum%', theme: 'Energy' },
  // Pharma & Health
  { pattern: '%pharmaceutic%', theme: 'Pharma & Health' },
  { pattern: '%health product%', theme: 'Pharma & Health' },
  { pattern: '%hospital%', theme: 'Pharma & Health' },
  { pattern: '%nursing home%', theme: 'Pharma & Health' },
  { pattern: '%health profession%', theme: 'Pharma & Health' },
  { pattern: '%health services%', theme: 'Pharma & Health' },
  { pattern: '%hmo%', theme: 'Pharma & Health' },
  { pattern: '%medical device%', theme: 'Pharma & Health' },
  { pattern: '%medical suppl%', theme: 'Pharma & Health' },
  { pattern: '%physician%', theme: 'Pharma & Health' },
  { pattern: '%health worker%', theme: 'Pharma & Health' },
  { pattern: 'nurses', theme: 'Pharma & Health', note: 'exact — "Nurses unions" must stay unmapped (Labor)' },
  { pattern: '%psychiatrists%', theme: 'Pharma & Health' },
  // Banks & Finance
  { pattern: '%commercial bank%', theme: 'Banks & Finance' },
  { pattern: '%securities & invest%', theme: 'Banks & Finance' },
  { pattern: '%insurance%', theme: 'Banks & Finance' },
  { pattern: '%security brokers%', theme: 'Banks & Finance' },
  { pattern: 'investors', theme: 'Banks & Finance', note: 'exact — the bare OpenSecrets "Investors" bucket' },
  { pattern: '%finance/credit%', theme: 'Banks & Finance' },
  { pattern: '%hedge fund%', theme: 'Banks & Finance' },
  { pattern: '%private equity%', theme: 'Banks & Finance' },
  { pattern: '%accountant%', theme: 'Banks & Finance' },
  { pattern: '%credit union%', theme: 'Banks & Finance' },
  { pattern: '%savings & loan%', theme: 'Banks & Finance' },
  { pattern: '%mortgage banker%', theme: 'Banks & Finance' },
  { pattern: '%investment firm%', theme: 'Banks & Finance' },
  { pattern: '%venture capital%', theme: 'Banks & Finance' },
  { pattern: '%stock broker%', theme: 'Banks & Finance' },
  // Payments (thin on the donor side; card networks rarely itemized separately)
  { pattern: '%credit card%', theme: 'Payments' },
  // Defense & Aerospace
  { pattern: '%defense aero%', theme: 'Defense & Aerospace' },
  { pattern: '%aerospace%', theme: 'Defense & Aerospace' },
  { pattern: '%defense electron%', theme: 'Defense & Aerospace' },
  { pattern: '%misc defense%', theme: 'Defense & Aerospace' },
  // Tech & Semiconductors
  { pattern: '%computer software%', theme: 'Tech & Semiconductors' },
  { pattern: '%internet%', theme: 'Tech & Semiconductors' },
  { pattern: '%electronics mf%', theme: 'Tech & Semiconductors' },
  { pattern: '%semiconductor%', theme: 'Tech & Semiconductors' },
  { pattern: '%data processing%', theme: 'Tech & Semiconductors' },
  { pattern: '%hosting/cloud%', theme: 'Tech & Semiconductors' },
  { pattern: '%search engine%', theme: 'Tech & Semiconductors' },
  { pattern: '%video game%', theme: 'Tech & Semiconductors' },
  { pattern: '%computers/elect%', theme: 'Tech & Semiconductors' },
  { pattern: '%computer component%', theme: 'Tech & Semiconductors' },
  // Media & Telecom
  { pattern: '%tv/movies/music%', theme: 'Media & Telecom' },
  { pattern: '%telephone util%', theme: 'Media & Telecom' },
  { pattern: '%telecom%', theme: 'Media & Telecom' },
  { pattern: '%motion picture%', theme: 'Media & Telecom' },
  { pattern: '%commercial tv%', theme: 'Media & Telecom' },
  { pattern: '%recorded music%', theme: 'Media & Telecom' },
  { pattern: '%publishing%', theme: 'Media & Telecom' },
  { pattern: '%newspaper%', theme: 'Media & Telecom' },
  { pattern: '%broadcast%', theme: 'Media & Telecom' },
  { pattern: '%entertainment industry%', theme: 'Media & Telecom' },
  // Retail & Consumer
  { pattern: '%retail sales%', theme: 'Retail & Consumer' },
  { pattern: '%restaurant%', theme: 'Retail & Consumer' },
  { pattern: '%food & beverage%', theme: 'Retail & Consumer' },
  { pattern: '%lodging/tourism%', theme: 'Retail & Consumer' },
  { pattern: '%beer, wine & liquor%', theme: 'Retail & Consumer' },
  { pattern: '%casino%', theme: 'Retail & Consumer' },
  { pattern: '%food stores%', theme: 'Retail & Consumer' },
  { pattern: '%online retail%', theme: 'Retail & Consumer' },
  // Transportation
  { pattern: '%air transport%', theme: 'Transportation' },
  { pattern: '%automotive%', theme: 'Transportation' },
  { pattern: '%sea transport%', theme: 'Transportation' },
  { pattern: '%railroad%', theme: 'Transportation' },
  { pattern: '%trucking%', theme: 'Transportation' },
  { pattern: '%auto dealers%', theme: 'Transportation', note: 'OpenSecrets files dealers under its Transportation sector' },
  // Industrials & Construction
  { pattern: '%misc manufactur%', theme: 'Industrials' },
  { pattern: '%general contractor%', theme: 'Industrials' },
  { pattern: '%special trade%', theme: 'Industrials' },
  { pattern: '%construction%', theme: 'Industrials', note: 'broad — covers unclassified/public-works/residential/plant construction' },
  { pattern: '%building material%', theme: 'Industrials' },
  { pattern: '%industrial%', theme: 'Industrials' },
  // Materials, Mining & Chemicals
  // Deliberately NOT the bare '%mining%': it caught 'Mining unions' (Labor)
  // and 'Coal mining' (Energy, via '%coal%' — cross-theme double count).
  { pattern: 'mining', theme: 'Materials & Mining', note: 'exact — the bare OpenSecrets "Mining" bucket' },
  { pattern: '%metal mining%', theme: 'Materials & Mining' },
  { pattern: '%non-metallic mining%', theme: 'Materials & Mining' },
  { pattern: '%mining services%', theme: 'Materials & Mining' },
  { pattern: '%aluminum mining%', theme: 'Materials & Mining' },
  { pattern: '%steel%', theme: 'Materials & Mining' },
  { pattern: '%chemical%', theme: 'Materials & Mining' },
  { pattern: '%forestry%', theme: 'Materials & Mining' },
  { pattern: '%mineral%', theme: 'Materials & Mining' },
  // Real Estate
  // Prefix (not '%real estate%'): the FIRE catch-all row 'Finance, Insurance
  // & Real Estate' belongs to Banks & Finance (via '%insurance%'), not here.
  { pattern: 'real estate%', theme: 'Real Estate' },
  { pattern: '%real estate service%', theme: 'Real Estate', note: '"Other real estate services"' },
  { pattern: '%building operators%', theme: 'Real Estate' },
  { pattern: '%home builder%', theme: 'Real Estate' },
  { pattern: '%mortgage broker%', theme: 'Real Estate' },
  { pattern: '%property management%', theme: 'Real Estate' },
];

// NAICS prefix → theme (district federal contracts, USAspending rollups).
// PREFIX-based, longest-prefix-wins — see naics_theme in schema.sql. Seeded
// from codes observed in frozen probe rollups (NJ-05 + GA-14, SOURCES.md
// §USAspending), generalized to a prefix only where the whole family is
// unambiguous. Unmapped-by-construction families (construction 23, food
// processing 311, rubber/plastics 326, architecture/engineering 5413, R&D
// services 5417, facilities support 5612, remediation 5629) carry no
// tradable-theme meaning; findings state "of mapped district contract dollars".
export const NAICS_THEME: Array<{ prefix: string; theme: string; note?: string }> = [
  { prefix: '2211',   theme: 'Energy',               note: 'electric power generation/transmission/distribution (SIC 4911/4931 precedent)' },
  { prefix: '331',    theme: 'Materials & Mining',   note: 'primary metal manufacturing' },
  { prefix: '33299',  theme: 'Defense & Aerospace',  note: 'ordnance & ammunition — federal awards here are defense procurement' },
  { prefix: '3344',   theme: 'Tech & Semiconductors', note: 'semiconductors & electronic components' },
  { prefix: '3345',   theme: 'Tech & Semiconductors', note: 'navigational/measuring/control instruments' },
  { prefix: '334510', theme: 'Pharma & Health',      note: 'electromedical apparatus — longest-prefix override of 3345 (SIC 3841 precedent)' },
  { prefix: '335',    theme: 'Industrials',          note: 'electrical equipment & components (SIC 3600 precedent)' },
  { prefix: '3364',   theme: 'Defense & Aerospace',  note: 'aerospace products & parts' },
  { prefix: '3391',   theme: 'Pharma & Health',      note: 'medical equipment & supplies (SIC 3841 precedent)' },
  { prefix: '42345',  theme: 'Pharma & Health',      note: 'medical/dental/hospital equipment wholesalers (SIC 5047 precedent)' },
  { prefix: '481',    theme: 'Transportation',       note: 'air transportation (SIC 4513 precedent)' },
  { prefix: '512',    theme: 'Media & Telecom',      note: 'motion picture & sound recording' },
  { prefix: '622',    theme: 'Pharma & Health',      note: 'hospitals (donor %hospital% precedent)' },
  { prefix: '6231',   theme: 'Pharma & Health',      note: 'nursing care facilities (donor %nursing home% precedent)' },
];

// Longest-prefix-wins matcher, the unit-testable mirror of the detector's SQL
// (WHERE code LIKE naics_prefix || '%' ORDER BY LENGTH(naics_prefix) DESC
// LIMIT 1). Returns null for unmapped codes — that null is load-bearing.
export function matchNaicsTheme(code: string): string | null {
  let best: { prefix: string; theme: string } | null = null;
  for (const row of NAICS_THEME) {
    if (code.startsWith(row.prefix) && (!best || row.prefix.length > best.prefix.length)) {
      best = row;
    }
  }
  return best?.theme ?? null;
}

// Pure mirror of DuckDB's ILIKE so the crosswalk is unit-testable without a
// database: case-insensitive, % = any sequence, _ = any single character.
export function ilikeMatch(pattern: string, s: string): boolean {
  const re = pattern
    .split(/([%_])/)
    .map((part) =>
      part === '%' ? '[\\s\\S]*'
      : part === '_' ? '[\\s\\S]'
      : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${re}$`, 'i').test(s);
}

// All distinct themes an industry string maps to. The view dedupes same-theme
// multi-matches, so >1 entry here means cross-theme double counting — a
// crosswalk bug (guarded by lib/donor-crosswalk.test.ts).
export function matchDonorThemes(industry: string): string[] {
  return [
    ...new Set(
      DONOR_INDUSTRY_THEME.filter(({ pattern }) => ilikeMatch(pattern, industry)).map(
        ({ theme }) => theme,
      ),
    ),
  ].sort();
}

export async function loadSectorCrosswalk(): Promise<{ sicRows: number; matchRows: number; overrideRows: number; donorThemeRows: number; naicsRows: number }> {
  await applySchema();
  const conn = await getDb();

  await conn.run(`DELETE FROM sic_theme`);
  let sicRows = 0;
  for (const [sic, theme] of Object.entries(SIC_THEME)) {
    await conn.run(`INSERT OR REPLACE INTO sic_theme (sic, theme) VALUES (?,?)`, [sic, theme]);
    sicRows++;
  }

  await conn.run(`DELETE FROM theme_bill_match`);
  let matchRows = 0;
  for (const { theme, policyAreas, subjectPatterns } of THEME_MATCH) {
    for (const pa of policyAreas) {
      await conn.run(`INSERT INTO theme_bill_match (theme, policy_area, subject_pattern) VALUES (?,?,NULL)`, [theme, pa]);
      matchRows++;
    }
    for (const sp of subjectPatterns) {
      await conn.run(`INSERT INTO theme_bill_match (theme, policy_area, subject_pattern) VALUES (?,NULL,?)`, [theme, sp]);
      matchRows++;
    }
  }

  await conn.run(`DELETE FROM ticker_theme_override`);
  let overrideRows = 0;
  for (const { ticker, theme, note } of TICKER_OVERRIDE) {
    await conn.run(`INSERT OR REPLACE INTO ticker_theme_override (ticker, theme, note) VALUES (?,?,?)`, [ticker, theme, note]);
    overrideRows++;
  }

  await conn.run(`DELETE FROM donor_industry_theme`);
  let donorThemeRows = 0;
  for (const { pattern, theme, note } of DONOR_INDUSTRY_THEME) {
    await conn.run(
      `INSERT INTO donor_industry_theme (industry_pattern, theme, note) VALUES (?,?,?)`,
      [pattern, theme, note ?? null],
    );
    donorThemeRows++;
  }

  await conn.run(`DELETE FROM naics_theme`);
  let naicsRows = 0;
  for (const { prefix, theme, note } of NAICS_THEME) {
    await conn.run(
      `INSERT OR REPLACE INTO naics_theme (naics_prefix, theme, note) VALUES (?,?,?)`,
      [prefix, theme, note ?? null],
    );
    naicsRows++;
  }

  console.log(
    `Seeded crosswalk: ${sicRows} SIC→theme rows, ${matchRows} theme→bill-match rows across ` +
    `${THEME_MATCH.length} themes, ${overrideRows} ticker overrides, ` +
    `${donorThemeRows} donor-industry→theme patterns, ${naicsRows} NAICS→theme prefixes.`,
  );
  return { sicRows, matchRows, overrideRows, donorThemeRows, naicsRows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadSectorCrosswalk().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
