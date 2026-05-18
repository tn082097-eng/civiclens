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
  const r = await conn.run(`SELECT member_id, name FROM members ORDER BY name`);
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
  const r    = await conn.run(
    `SELECT * FROM v_suspicious_trades
     WHERE member_id = ? AND days_before_vote <= ?
     ORDER BY days_before_vote ASC, tx_date DESC`,
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
       tx_date DESC
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
  const r = await conn.run(`SELECT * FROM v_member_trade_summary ORDER BY total_trades DESC`);
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
