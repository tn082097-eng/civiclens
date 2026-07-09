/**
 * Public query layer over the CivicLens DB.
 *
 * Every function takes plain JS values and returns plain JS rows. Callers
 * don't touch DuckDB directly — keeps the storage swap surface small.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './init.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const Q_DIR = resolve(__dirname, 'queries');

function loadSql(name: string): string {
  return readFileSync(resolve(Q_DIR, `${name}.sql`), 'utf-8');
}

export interface SharedDonorPeer {
  peer_id: string;
  peer_name: string;
  shared_count: number;
  combined_amount: number;
  donor_canonicals: string[];
}

export async function findSharedDonors(memberId: string): Promise<SharedDonorPeer[]> {
  const conn = await getDb();
  const sql  = loadSql('shared-donors');
  const r    = await conn.run(sql, [memberId]);
  const rows = await r.getRowObjects();
  return rows.map((row: any) => ({
    peer_id: String(row.peer_id),
    peer_name: String(row.peer_name),
    shared_count: Number(row.shared_count),
    combined_amount: Number(row.combined_amount),
    donor_canonicals: Array.isArray(row.donor_canonicals)
      ? row.donor_canonicals.map((x: any) => String(x))
      : [],
  }));
}

export async function listMembers(): Promise<{ member_id: string; name: string }[]> {
  const conn = await getDb();
  const r = await conn.run(`SELECT member_id, name FROM members ORDER BY name, member_id`);
  const rows = await r.getRowObjects();
  return rows.map((row: any) => ({ member_id: String(row.member_id), name: String(row.name) }));
}

export async function donorCount(memberId: string): Promise<number> {
  const conn = await getDb();
  const r = await conn.run(`SELECT COUNT(*) AS n FROM donors WHERE member_id = ?`, [memberId]);
  const rows = await r.getRowObjects();
  return Number((rows[0] as any).n);
}

// ─── PFD trade-vs-vote queries ──────────────────────────────────────────────

export interface TradeNearVote {
  member_id: string;
  member_name: string;
  holder: string | null;
  tx_date: string | null;
  tx_type: string | null;
  asset: string | null;
  ticker: string | null;
  asset_type: string | null;
  amount_band: string | null;
  trade_filing_id: string;
  trade_source_url: string | null;
  source_year: number | null;
  vote_date: string | null;
  vote_question: string | null;
  vote_position: string | null;
  vote_id: string;
  vote_source_url: string | null;
  bill_id: string | null;
  bill_title: string | null;
  bill_summary: string | null;
  bill_source_url: string | null;
  bill_committees: string | null;
  member_on_bill_committee: boolean;
  member_committee_role: string | null;
  days_from_trade_to_vote: number;
  days_abs: number;
  days_before_vote: number;
  days_after_vote: number;
  match_confidence: number | null;
  match_method: string | null;
  bill_mentions_ticker?: boolean;  // only present on v_suspicious_trades rows
  window_vote_count?: number;      // true per-trade pair count when the query caps rows per trade
}

function rowsToTradeNearVote(rows: any[]): TradeNearVote[] {
  return rows.map(r => ({
    member_id: String(r.member_id),
    member_name: String(r.member_name ?? ''),
    holder: r.holder ?? null,
    tx_date: r.tx_date ? String(r.tx_date) : null,
    tx_type: r.tx_type ?? null,
    asset: r.asset ?? null,
    ticker: r.ticker ?? null,
    asset_type: r.asset_type ?? null,
    amount_band: r.amount_band ?? null,
    trade_filing_id: String(r.trade_filing_id),
    trade_source_url: r.trade_source_url ?? null,
    source_year: r.source_year !== null && r.source_year !== undefined ? Number(r.source_year) : null,
    vote_date: r.vote_date ? String(r.vote_date) : null,
    vote_question: r.vote_question ?? null,
    vote_position: r.vote_position ?? null,
    vote_id: String(r.vote_id),
    vote_source_url: r.vote_source_url ?? null,
    bill_id: r.bill_id ?? null,
    bill_title: r.bill_title ?? null,
    bill_summary: r.bill_summary ?? null,
    bill_source_url: r.bill_source_url ?? null,
    bill_committees: r.bill_committees ?? null,
    member_on_bill_committee: Boolean(r.member_on_bill_committee),
    member_committee_role: r.member_committee_role ?? null,
    days_from_trade_to_vote: Number(r.days_from_trade_to_vote),
    days_abs: Number(r.days_abs),
    days_before_vote: Number(r.days_before_vote),
    days_after_vote: Number(r.days_after_vote),
    match_confidence: r.match_confidence !== null && r.match_confidence !== undefined ? Number(r.match_confidence) : null,
    match_method: r.match_method ?? null,
    ...(r.bill_mentions_ticker !== undefined ? { bill_mentions_ticker: Boolean(r.bill_mentions_ticker) } : {}),
    ...(r.window_vote_count !== undefined ? { window_vote_count: Number(r.window_vote_count) } : {}),
  }));
}

export async function findTradesNearVotes(memberId: string, windowDays = 14): Promise<TradeNearVote[]> {
  const conn = await getDb();
  const sql  = loadSql('trades-near-votes');
  const r    = await conn.run(sql, [memberId, windowDays]);
  return rowsToTradeNearVote(await r.getRowObjects() as any[]);
}

// Filtered view: discretionary equities only, trade-before-vote direction only.
// Drops T-bills, ETFs, index funds, munis, bonds.  See schema v_suspicious_trades.
export async function findSuspiciousTrades(memberId: string, windowDays = 90): Promise<TradeNearVote[]> {
  const conn = await getDb();
  // Per-trade cap mirrors trades-near-votes.sql: heavy traders otherwise
  // return 100k+ exploded rows that OOM the JS heap. window_vote_count
  // carries the true pair count for the collapsed card.
  const r    = await conn.run(
    `SELECT * FROM (
       SELECT v.*,
         COUNT(*) OVER (PARTITION BY trade_filing_id, tx_date, tx_type, asset, ticker) AS window_vote_count,
         ROW_NUMBER() OVER (PARTITION BY trade_filing_id, tx_date, tx_type, asset, ticker
           ORDER BY days_before_vote ASC, tx_date DESC, trade_filing_id ASC, vote_id ASC,
                    ticker ASC, asset ASC, tx_type ASC, amount_band ASC, holder ASC) AS rn_close,
         ROW_NUMBER() OVER (PARTITION BY trade_filing_id, tx_date, tx_type, asset, ticker
           ORDER BY member_on_bill_committee DESC, days_before_vote ASC, vote_id ASC,
                    tx_type ASC, amount_band ASC, holder ASC) AS rn_cmte
       FROM v_suspicious_trades v
       WHERE member_id = ? AND days_before_vote <= ?
     )
     WHERE rn_close <= 6 OR (member_on_bill_committee AND rn_cmte = 1)
     ORDER BY days_before_vote ASC, tx_date DESC,
              trade_filing_id ASC, vote_id ASC, ticker ASC, asset ASC,
              tx_type ASC, amount_band ASC, holder ASC`,
    [memberId, windowDays],
  );
  return rowsToTradeNearVote(await r.getRowObjects() as any[]);
}

// Corpus-wide suspicious trades feed (for index page).
export async function suspiciousTradesCorpus(windowDays = 30, limit = 2000): Promise<TradeNearVote[]> {
  const conn = await getDb();
  const r    = await conn.run(
    `SELECT * FROM v_suspicious_trades
     WHERE days_before_vote <= ?
     ORDER BY
       member_on_bill_committee DESC,
       days_before_vote ASC,
       tx_date DESC,
       trade_filing_id ASC, vote_id ASC, ticker ASC, asset ASC,
       tx_type ASC, amount_band ASC, holder ASC
     LIMIT ?`,
    [windowDays, limit],
  );
  return rowsToTradeNearVote(await r.getRowObjects() as any[]);
}

export async function closestTradesAcrossCorpus(windowDays = 14, limit = 50): Promise<TradeNearVote[]> {
  const conn = await getDb();
  const sql  = loadSql('closest-trades-corpus');
  const r    = await conn.run(sql, [windowDays, limit]);
  return rowsToTradeNearVote(await r.getRowObjects() as any[]);
}

export interface MemberTradeSummary {
  member_id: string;
  name: string;
  total_trades: number;
  distinct_assets: number;
  purchase_count: number;
  sale_count: number;
  first_trade_date: string | null;
  last_trade_date: string | null;
  avg_match_confidence: number | null;
}

export async function memberTradeSummary(): Promise<MemberTradeSummary[]> {
  const conn = await getDb();
  const r = await conn.run(`SELECT * FROM v_member_trade_summary ORDER BY total_trades DESC, member_id ASC`);
  const rows = await r.getRowObjects() as any[];
  return rows.map(row => ({
    member_id: String(row.member_id),
    name: String(row.name),
    total_trades: Number(row.total_trades),
    distinct_assets: Number(row.distinct_assets),
    purchase_count: Number(row.purchase_count),
    sale_count: Number(row.sale_count),
    first_trade_date: row.first_trade_date ? String(row.first_trade_date) : null,
    last_trade_date: row.last_trade_date ? String(row.last_trade_date) : null,
    avg_match_confidence: row.avg_match_confidence !== null && row.avg_match_confidence !== undefined ? Number(row.avg_match_confidence) : null,
  }));
}

// ─── Co-sponsorship network ─────────────────────────────────────────────────

export interface CosponsorEdge {
  source_id: string;
  source_name: string;
  source_party: string | null;
  target_id: string;
  target_name: string;
  target_party: string | null;
  shared_bills: number;
  bill_ids: string[];
  bill_titles: string[];
}

export async function cosponsorNetwork(): Promise<CosponsorEdge[]> {
  const conn = await getDb();
  const sql  = loadSql('cosponsor-network');
  const r    = await conn.run(sql);
  const rows = await r.getRowObjects() as any[];
  return rows.map(row => ({
    source_id:    String(row.source_id),
    source_name:  String(row.source_name),
    source_party: row.source_party ?? null,
    target_id:    String(row.target_id),
    target_name:  String(row.target_name),
    target_party: row.target_party ?? null,
    shared_bills: Number(row.shared_bills),
    bill_ids:     Array.isArray(row.bill_ids)    ? row.bill_ids.map(String)    : [],
    bill_titles:  Array.isArray(row.bill_titles) ? row.bill_titles.map(String) : [],
  }));
}

export interface NexusRow {
  member_id: string;
  member_name: string;
  tx_date: string | null;
  tx_type: string | null;
  ticker: string;
  asset: string | null;
  amount_band: string | null;
  sic_description: string | null;
  theme: string;
  bill_id: string;
  bill_title: string;
  vote_date: string | null;
  vote_question: string | null;
  vote_position: string | null;
  days_before_vote: number;
  trade_source_url: string | null;
  vote_source_url: string | null;
  bill_source_url: string | null;
}

// Every qualifying trade↔bill nexus pair, ranked by trade-to-vote proximity.
// Reads the deterministic v_trade_bill_nexus view — no scoring, no LLM.
export async function tradeBillNexus(): Promise<NexusRow[]> {
  const conn = await getDb();
  const sql  = loadSql('trade-bill-nexus');
  const r    = await conn.run(sql);
  const rows = await r.getRowObjects() as any[];
  return rows.map(row => ({
    member_id:        String(row.member_id),
    member_name:      String(row.member_name),
    tx_date:          row.tx_date ? String(row.tx_date) : null,
    tx_type:          row.tx_type ?? null,
    ticker:           String(row.ticker),
    asset:            row.asset ?? null,
    amount_band:      row.amount_band ?? null,
    sic_description:  row.sic_description ?? null,
    theme:            String(row.theme),
    bill_id:          String(row.bill_id),
    bill_title:       String(row.bill_title),
    vote_date:        row.vote_date ? String(row.vote_date) : null,
    vote_question:    row.vote_question ?? null,
    vote_position:    row.vote_position ?? null,
    days_before_vote: Number(row.days_before_vote),
    trade_source_url: row.trade_source_url ?? null,
    vote_source_url:  row.vote_source_url ?? null,
    bill_source_url:  row.bill_source_url ?? null,
  }));
}

// ─── Revolving door (LDA former-staff → lobbyist) ───────────────────────────
// Deterministic matcher, ported verbatim from the former agents/revolving-door.ts.
// Recomputed at render time from the LDA corpus — no agent run, no LLM, no stored
// state. "recencyTier" is filing recency only (NOT a judgment): active = filed this
// year or last, recent = within 3 years, historical = older.

export type RevolvingMatchType = 'direct' | 'committee';
export type RevolvingRecencyTier = 'active' | 'recent' | 'historical';

export interface RevolvingConnection {
  lobbyistId:         number;
  lobbyistName:       string;
  formerRole:         string;          // verbatim covered_position excerpt
  currentEmployer:    string | null;   // registrant_name
  latestClient:       string | null;
  generalIssues:      string | null;
  governmentEntities: string | null;
  latestFilingYear:   number;
  latestFilingPeriod: string | null;
  matchType:          RevolvingMatchType;
  recencyTier:        RevolvingRecencyTier;
  sourceUrl:          string | null;
}

function recencyTier(latestFilingYear: number): RevolvingRecencyTier {
  const yearsAgo = new Date().getUTCFullYear() - latestFilingYear;
  if (yearsAgo <= 1) return 'active';
  if (yearsAgo <= 3) return 'recent';
  return 'historical';
}

// Last token of "First Middle Last [Suffix]" → surname (skips JR/SR/II…).
function extractLastName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const last = parts[parts.length - 1].replace(/[.,]/g, '');
  if (/^(JR|SR|II|III|IV|ESQ|PHD|MD)$/i.test(last) && parts.length >= 2) {
    return parts[parts.length - 2].replace(/[.,]/g, '');
  }
  return last;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Require a chamber-aware title before the surname. Crucially, when name tokens
// appear between the title and the surname they must START with this member's own
// first name — otherwise "Rep. Adam Smith" wrongly matches member "Jason Smith"
// (surname collision). So we accept bare "Rep. Smith" or "Rep. Jason [A.] Smith",
// but reject "Rep. <other-first> Smith". RE2-compatible (DuckDB regexp_matches).
// Known residual (accepted): bare "Rep. Smith" with no first name still matches; for
// surnames shared across Congress this can misattribute. Inherent to the free-text
// covered_position field — see docs/superpowers/specs/2026-06-08-revolving-door-wiring-design.md.
function buildDirectMatchPattern(memberName: string, chamber: string | null): string {
  const last = escapeRe(extractLastName(memberName));
  if (!last) return '';
  const first = escapeRe(memberName.trim().split(/\s+/).filter(Boolean)[0] ?? '');
  const titles = chamber === 'senate'
    ? ['Sen\\.?', 'Senator']
    : chamber === 'house'
      ? ['Rep\\.?', 'Congressman', 'Congresswoman']
      : ['Sen\\.?', 'Senator', 'Rep\\.?', 'Congressman', 'Congresswoman'];
  // After the title: either the surname directly, or the member's first name
  // followed by up to two middle/initial tokens, then the surname.
  const namePart = first
    ? `(?:${last}|${first}(?:\\s+[A-Z][\\w\\.\\-]*){0,2}\\s+${last})`
    : last;
  return `(?i)(${titles.join('|')})\\s+${namePart}\\b`;
}

function mapConnection(row: any, matchType: RevolvingMatchType): RevolvingConnection {
  const year = Number(row.latest_year);
  return {
    lobbyistId:         Number(row.lobbyist_id),
    lobbyistName:       String(row.full_name ?? ''),
    formerRole:         String(row.covered_position ?? ''),
    currentEmployer:    row.registrant_name ? String(row.registrant_name) : null,
    latestClient:       row.client_name ? String(row.client_name) : null,
    generalIssues:      row.general_issues ? String(row.general_issues) : null,
    governmentEntities: row.government_entities ? String(row.government_entities) : null,
    latestFilingYear:   year,
    latestFilingPeriod: row.latest_period ? String(row.latest_period) : null,
    matchType,
    recencyTier:        recencyTier(year),
    sourceUrl:          row.source_url ? String(row.source_url) : null,
  };
}

const COMMITTEE_STOP = new Set(['committee', 'subcommittee', 'on', 'and', 'the', 'of', 'house', 'senate', 'select', 'joint']);

// Pick each matched lobbyist's LATEST MATCHING filing and take every field from that
// one filing. Fully deterministic: the ROW_NUMBER window breaks ties on filing_uuid
// (PRIMARY KEY, unique), and the outer sort is a total order. This replaces an earlier
// ANY_VALUE/GROUP BY form that mixed fields across a lobbyist's filings and reordered
// run-to-run — breaking the reproducible-build guarantee. The WHERE runs inside the
// window so rn=1 is the most recent filing that actually matched.
function rdQuery(whereClause: string): string {
  return `
    SELECT lobbyist_id, full_name, covered_position, general_issues, government_entities,
           filing_year AS latest_year, filing_period AS latest_period,
           registrant_name, client_name, source_url
      FROM (
        SELECT l.lobbyist_id, l.full_name, l.covered_position, l.general_issues,
               l.government_entities, f.filing_year, f.filing_period,
               f.registrant_name, f.client_name, f.source_url,
               ROW_NUMBER() OVER (
                 PARTITION BY l.lobbyist_id
                 ORDER BY f.filing_year DESC, f.posted_at DESC, f.filing_uuid
               ) AS rn
          FROM lda_lobbyists l JOIN lda_filings f USING (filing_uuid)
         WHERE ${whereClause}
      )
     WHERE rn = 1
     ORDER BY latest_year DESC, lobbyist_id`;
}

/**
 * Registered lobbyists whose disclosed former role (covered_position) names this
 * member (direct) or one of their committees (committee). Direct leads; committee
 * de-duped against direct. Deterministic. Returns [] when LDA tables are absent or no
 * matches.
 */
export async function revolvingDoorConnections(
  memberId: string,
  name: string,
  chamber: string | null,
): Promise<RevolvingConnection[]> {
  const conn = await getDb();

  // Graceful degrade if LDA not ingested.
  try { await conn.run(`SELECT 1 FROM lda_lobbyists LIMIT 1`); }
  catch { return []; }

  // ── Direct: covered_position names this specific member ──
  let direct: RevolvingConnection[] = [];
  const pattern = buildDirectMatchPattern(name, chamber);
  if (pattern) {
    const r = await conn.run(rdQuery(`regexp_matches(l.covered_position, ?)`), [pattern]);
    direct = (await r.getRowObjects() as any[]).map(row => mapConnection(row, 'direct'));
  }

  // ── Committee: ex-committee staff (distinctive committee keyword in covered_position) ──
  // ORDER BY committee_name so the keyword set (and the slice below) is stable run-to-run.
  let committee: RevolvingConnection[] = [];
  const cR = await conn.run(`SELECT DISTINCT committee_name FROM committees WHERE member_id = ? ORDER BY committee_name`, [memberId]);
  const committees = (await cR.getRowObjects() as any[]).map(r => String(r.committee_name ?? '')).filter(Boolean);
  const keywords = new Set<string>();
  for (const cn of committees) {
    for (const tok of cn.split(/[\s,]+/)) {
      const w = tok.toLowerCase().replace(/[^a-z]/g, '');
      if (w.length >= 5 && !COMMITTEE_STOP.has(w)) keywords.add(w);
    }
  }
  if (keywords.size > 0) {
    const kws = [...keywords].slice(0, 8);
    const clause = kws.map(() => 'l.covered_position ILIKE ?').join(' OR ');
    const r = await conn.run(
      rdQuery(`(${clause}) AND l.covered_position ILIKE '%cmte%'`),
      kws.map(k => `%${k}%`),
    );
    const directIds = new Set(direct.map(c => c.lobbyistId));
    committee = (await r.getRowObjects() as any[])
      .map(row => mapConnection(row, 'committee'))
      .filter(c => !directIds.has(c.lobbyistId));
  }

  return [...direct, ...committee];
}

// ─── CLI smoke ──────────────────────────────────────────────────────────────

function fmtTrade(t: TradeNearVote): string {
  const proximity =
    t.days_before_vote > 0 ? `${t.days_before_vote}d before vote` :
    t.days_after_vote  > 0 ? `${t.days_after_vote}d after vote`   : 'same day';
  const ticker = t.ticker ? `(${t.ticker})` : '';
  return `${t.tx_date}  ${t.member_name.padEnd(24)} ${(t.tx_type ?? '?').padEnd(8)} ${(t.asset ?? '').slice(0, 32).padEnd(32)} ${ticker.padEnd(8)} ${proximity.padEnd(18)} vote: "${(t.vote_question ?? '').slice(0, 40)}"`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const cmd = process.argv[2];
    if (cmd === 'trades') {
      const id = process.argv[3];
      const win = parseInt(process.argv[4] ?? '14', 10);
      if (!id) { console.error('Usage: queries.ts trades <member-id> [window-days]'); process.exit(1); }
      const rows = await findTradesNearVotes(id, win);
      console.log(`${rows.length} trade(s) by ${id} within ${win} days of a vote\n`);
      for (const t of rows) console.log('  ' + fmtTrade(t));
    } else if (cmd === 'closest-trades') {
      const win = parseInt(process.argv[3] ?? '14', 10);
      const lim = parseInt(process.argv[4] ?? '50', 10);
      const rows = await closestTradesAcrossCorpus(win, lim);
      console.log(`Top ${rows.length} trades within ${win} days of a same-member vote (corpus-wide)\n`);
      for (const t of rows) console.log('  ' + fmtTrade(t));
    } else if (cmd === 'member-trades') {
      const rows = await memberTradeSummary();
      console.log(`${rows.length} member(s) with trades:\n`);
      for (const m of rows) {
        console.log(`  ${m.name.padEnd(26)} trades=${String(m.total_trades).padStart(3)}  assets=${String(m.distinct_assets).padStart(3)}  buy=${m.purchase_count} sell=${m.sale_count}  ${m.first_trade_date}–${m.last_trade_date}  conf=${m.avg_match_confidence}`);
      }
    } else if (cmd === 'shared-donors') {
      const id = process.argv[3];
      if (!id) { console.error('Usage: queries.ts shared-donors <member-id>'); process.exit(1); }
      const peers = await findSharedDonors(id);
      console.log(`shared donors for ${id}: ${peers.length} peer(s)`);
      for (const p of peers) {
        console.log(`  ${p.peer_name.padEnd(26)} shared=${p.shared_count}  combined=$${Math.round(p.combined_amount).toLocaleString()}`);
      }
    } else if (cmd && !['trades', 'closest-trades', 'member-trades', 'shared-donors'].includes(cmd)) {
      // Back-compat: bare `queries.ts <member-id>` still runs shared donors.
      const peers = await findSharedDonors(cmd);
      console.log(`shared donors for ${cmd}: ${peers.length} peer(s)`);
      for (const p of peers) {
        console.log(`  ${p.peer_name.padEnd(26)} shared=${p.shared_count}  combined=$${Math.round(p.combined_amount).toLocaleString()}`);
      }
    } else {
      const ms = await listMembers();
      console.log(`${ms.length} members loaded. Subcommands: trades | closest-trades | member-trades | shared-donors\n`);
      for (const m of ms) console.log(`  ${m.member_id.padEnd(28)} ${m.name}`);
    }
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
}
