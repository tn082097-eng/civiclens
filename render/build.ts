/**
 * CivicLens static-site generator.
 *
 * Reads from DuckDB (the source of truth post-migration) and writes a small
 * static site to ~/.hermes/civiclens/site/. No framework — single Node entry,
 * inline CSS, XSS-safe by construction (every dynamic value goes through esc()
 * or is built via DOM-style child appends; no string concatenation into HTML).
 *
 * Pages:
 *   site/index.html          — corpus overview + closest-trades feed
 *   site/network.html        — co-sponsorship network (D3 force graph + edge table)
 *   site/members/<id>.html   — per-member: bio, glance, timeline, trades×votes, donors, outside spending, co-sponsorship
 *
 * Usage:
 *   npx tsx render/build.ts
 *   npx tsx agents/pipeline.ts --render
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from '../db/init.js';
import {
  findSharedDonors,
  findTradesNearVotes,
  findSuspiciousTrades,
  suspiciousTradesCorpus,
  memberTradeSummary,
  cosponsorNetwork,
  type TradeNearVote,
} from '../db/queries.js';
import { fetchSuperPacIE } from '../lib/fec-ie.js';
import type { SuperPacIEReport, SuperPacIE, SuperPacFunder } from '../lib/types.js';

const HOME = process.env.HOME!;
const OUT_DIR = resolve(HOME, '.hermes/civiclens/site');
const MEMBERS_DIR = resolve(OUT_DIR, 'members');

// ─── HTML helpers (XSS-safe) ────────────────────────────────────────────────

function esc(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function partyClass(party: string | null): string {
  if (!party) return 'p-none';
  if (party.startsWith('D')) return 'p-d';
  if (party.startsWith('R')) return 'p-r';
  if (party.startsWith('I')) return 'p-i';
  return 'p-none';
}

function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  const v = Math.round(Number(n));
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v}`;
}

// Collapse trade-vote pairs to one row per (member × trade), with a count of
// votes within the window. Surfaces the trade once instead of N times.
interface TradeRow {
  member_id: string;
  member_name: string;
  tx_date: string | null;
  tx_type: string | null;
  asset: string | null;
  ticker: string | null;
  amount_band: string | null;
  holder: string | null;
  trade_filing_id: string;
  trade_source_url: string | null;
  vote_count: number;
  closest: TradeNearVote;                           // smallest days_abs
  closestJurisdiction: TradeNearVote | null;        // smallest days_abs where member_on_bill_committee
  example_votes: TradeNearVote[];                   // up to 3 sample votes
}

// Deterministic 0-100 intensity from the strongest pair in a TradeRow.
// Mirrors the trade-analyst scoring rubric so render weights and agent
// findings stay consistent. Output mapped to low/medium/high CSS classes.
type Intensity = 'low' | 'medium' | 'high';

function rowIntensityScore(row: TradeRow): number {
  const candidates = [row.closest, row.closestJurisdiction, ...row.example_votes].filter(Boolean) as TradeNearVote[];
  let best = 0;
  for (const v of candidates) {
    const onCmte = v.member_on_bill_committee;
    const ticker = (v as any).bill_mentions_ticker === true;
    const days = v.days_before_vote;
    let s = 0;
    if (days === 0 && onCmte) s = 100;
    else if (days === 0)      s = 90;
    else if (days <= 3 && onCmte) s = 85;
    else if (days <= 3)       s = 80;
    else if (onCmte)          s = 70;
    else                      s = 50;
    if (ticker) s += 5;  // small bump for direct ticker mention
    if (s > best) best = s;
  }
  return best;
}

function rowIntensity(row: TradeRow): Intensity {
  const s = rowIntensityScore(row);
  if (s >= 85) return 'high';
  if (s >= 70) return 'medium';
  return 'low';
}

function collapseTrades(pairs: TradeNearVote[]): TradeRow[] {
  const byTrade = new Map<string, TradeRow>();
  for (const p of pairs) {
    const key = `${p.member_id}|${p.trade_filing_id}|${p.tx_date}|${p.asset}|${p.ticker}`;
    const cur = byTrade.get(key);
    if (!cur) {
      byTrade.set(key, {
        member_id: p.member_id,
        member_name: p.member_name,
        tx_date: p.tx_date,
        tx_type: p.tx_type,
        asset: p.asset,
        ticker: p.ticker,
        amount_band: p.amount_band,
        holder: p.holder,
        trade_filing_id: p.trade_filing_id,
        trade_source_url: p.trade_source_url,
        vote_count: 1,
        closest: p,
        closestJurisdiction: p.member_on_bill_committee ? p : null,
        example_votes: [p],
      });
    } else {
      cur.vote_count++;
      if (p.days_abs < cur.closest.days_abs) cur.closest = p;
      if (p.member_on_bill_committee && (!cur.closestJurisdiction || p.days_abs < cur.closestJurisdiction.days_abs)) {
        cur.closestJurisdiction = p;
      }
      if (cur.example_votes.length < 3) cur.example_votes.push(p);
    }
  }
  return [...byTrade.values()].sort((a, b) => {
    // Prefer trades with jurisdiction overlap up top (real signal), then by
    // absolute days_abs. Render-layer ordering — view stays neutral.
    const aJ = a.closestJurisdiction ? 0 : 1;
    const bJ = b.closestJurisdiction ? 0 : 1;
    if (aJ !== bJ) return aJ - bJ;
    if (a.closest.days_abs !== b.closest.days_abs) return a.closest.days_abs - b.closest.days_abs;
    return (b.tx_date ?? '').localeCompare(a.tx_date ?? '');
  });
}

// ─── Layout ─────────────────────────────────────────────────────────────────

const STYLE = `
:root {
  --bg: #14110d;
  --fg: #f5f1e8;
  --fg-dim: #a59f8e;
  --fg-muted: #6b6557;
  --line: #2e2a22;
  --accent: #f5f1e8;
  --p-d: #79b8ff;
  --p-r: #d65a5a;
  --p-i: #9aa0a6;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  background: var(--bg); color: var(--fg);
  font-feature-settings: 'kern' 1;
}
header h1, h2 {
  font-family: 'Charter', 'Source Serif 4', 'Iowan Old Style', Georgia, serif;
  font-weight: 600;
  letter-spacing: -0.015em;
}
.num, td.num, .tc-asset, .tc-vote-row, .vote-count, .pac-totals, .kv .v {
  font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums;
}
header { padding: 24px 32px 12px; border-bottom: 1px solid var(--line); }
header h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: -0.01em; }
header .sub { color: var(--fg-dim); font-size: 13px; }
header a { color: var(--accent); text-decoration: none; }
main { padding: 24px 32px 64px; max-width: 1200px; }
h2 { font-size: 19px; margin: 48px 0 14px; letter-spacing: -0.01em; }
h2:first-child { margin-top: 0; }
.lede { color: var(--fg-dim); margin: 0 0 24px; max-width: 720px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--fg-dim); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
tbody tr:hover { background: rgba(255,255,255,0.02); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.dim { color: var(--fg-dim); }
.muted { color: var(--fg-muted); }
.tag { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; line-height: 1.5; border: 1px solid var(--line); }
.tag.p-d { color: var(--p-d); border-color: var(--p-d); }
.tag.p-r { color: var(--p-r); border-color: var(--p-r); }
.tag.p-i { color: var(--p-i); border-color: var(--p-i); }
.tag.same-day { color: var(--accent); border-color: var(--accent); }
.tag.jurisdiction { color: #f7c948; border-color: #f7c948; background: rgba(247, 201, 72, 0.06); cursor: help; }
.tag.holder-spouse { color: #c585e0; border-color: #c585e0; }
.tag.holder-joint  { color: #79b8ff; border-color: #79b8ff; }
.tag.holder-self   { color: #9aa0a6; }
a.member { color: var(--fg); text-decoration: none; border-bottom: 1px solid var(--line); }
a.member:hover { border-bottom-color: var(--accent); color: var(--accent); }
.kv { display: grid; grid-template-columns: 200px 1fr; gap: 6px 16px; margin: 12px 0 24px; font-size: 13px; }
.kv .k { color: var(--fg-dim); }
.notice { padding: 10px 14px; background: rgba(121, 184, 255, 0.06); border: 1px solid rgba(121, 184, 255, 0.2); border-radius: 4px; font-size: 13px; color: var(--fg-dim); margin-bottom: 24px; }
.trade-activity { margin: 0 0 24px; }
.suspicion-badge { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 500; border: 1px solid var(--line); color: var(--fg-dim); }
.suspicion-badge.medium { border-color: var(--fg-dim); color: var(--fg); font-weight: 600; }
.suspicion-badge.high   { border-color: var(--fg);     color: var(--fg); font-weight: 700; }
.bar { height: 4px; background: var(--line); border-radius: 2px; overflow: hidden; display: inline-block; vertical-align: middle; width: 80px; margin-right: 6px; }
.bar > div { height: 100%; background: var(--accent); }
footer { padding: 24px 32px; color: var(--fg-muted); font-size: 12px; border-top: 1px solid var(--line); }
footer a { color: var(--fg-dim); }
.row-link { color: var(--accent); text-decoration: none; font-size: 11px; }
.row-link:hover { text-decoration: underline; }
.vote-count { display: inline-block; min-width: 22px; padding: 1px 6px; border-radius: 10px; background: var(--line); font-size: 11px; text-align: center; }
.same-day .vote-count { background: rgba(121, 184, 255, 0.15); color: var(--accent); }
.filter-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.filter-input { background: var(--bg); border: 1px solid var(--line); color: var(--fg); border-radius: 4px; padding: 5px 10px; font-size: 13px; width: 280px; outline: none; }
.filter-input:focus { border-color: var(--accent); }
.filter-input::placeholder { color: var(--fg-muted); }
.filter-toggle { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--fg-dim); cursor: pointer; user-select: none; }
.filter-toggle input { accent-color: var(--accent); cursor: pointer; }
.filter-count { font-size: 12px; color: var(--fg-muted); margin-left: auto; }
/* Trade card layout */
.trade-card { border: 1px solid var(--line); border-radius: 4px; padding: 12px 14px; margin-bottom: 10px; transition: border-color .15s; }
.trade-card:hover { border-color: #3a3e45; }
/* Intensity-mapped rendering — weight + density only. No moralizing color.
   Quiet members render quiet pages; loud members render loud pages.
   Per docs/superpowers/specs/2026-05-10-visual-identity-design.md. */
.trade-card.intensity-low    { border-left: 1px solid var(--line);    padding: 6px 12px; }
.trade-card.intensity-low .tc-asset    { font-weight: 400; font-size: 13px; }
.trade-card.intensity-medium { border-left: 2px solid var(--fg-dim);  padding: 10px 14px; padding-left: 12px; }
.trade-card.intensity-medium .tc-asset { font-weight: 500; font-size: 13px; }
.trade-card.intensity-high   { border-left: 3px solid var(--fg);      padding: 12px 16px; padding-left: 13px; }
.trade-card.intensity-high .tc-asset   { font-weight: 600; font-size: 14px; }
.trade-card .tc-header { display: flex; align-items: flex-start; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.trade-card .tc-asset { font-size: 14px; font-weight: 500; flex: 1; min-width: 180px; }
.trade-card .tc-meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--fg-dim); }
.trade-card .tc-votes { margin-top: 6px; border-top: 1px solid var(--line); padding-top: 6px; }
.trade-card .tc-vote-row { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; font-size: 12px; }
.trade-card .tc-vote-row:last-child { margin-bottom: 0; }
.tag.before { color: #f7c948; border-color: rgba(247,201,72,0.4); background: rgba(247,201,72,0.06); }
.tag.same-day { color: var(--accent); border-color: var(--accent); }
.tag.after { color: var(--fg-muted); border-color: var(--fg-muted); opacity: 0.7; }
.tag.bill-match { color: #4caf7d; border-color: rgba(76,175,125,0.4); background: rgba(76,175,125,0.06); cursor: help; }
.section-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--line); margin-bottom: 16px; }
.section-tab { padding: 6px 14px; font-size: 13px; color: var(--fg-dim); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; user-select: none; }
.section-tab.active { color: var(--fg); border-bottom-color: var(--accent); }
.tab-panel { display: none; }
.tab-panel.active { display: block; }
.pac-totals { display: flex; gap: 16px; margin: 8px 0 4px; font-size: 13px; }
.pac-side { padding: 4px 10px; border: 1px solid var(--line); border-radius: 3px; }
.pac-side.support { color: #4caf7d; border-color: rgba(76,175,125,0.4); }
.pac-side.oppose  { color: #e07840; border-color: rgba(224,120,64,0.4); }
.pac-list { display: flex; flex-direction: column; gap: 8px; }
.pac-row { border: 1px solid var(--line); border-radius: 4px; padding: 10px 12px; }
.pac-row .pac-name { margin-bottom: 4px; }
.pac-row .pac-amount { font-size: 13px; }
.glance-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 4px; margin: 8px 0 16px; overflow: hidden; }
.glance-cell { background: var(--bg); padding: 12px 14px; }
.glance-value { font-size: 22px; font-weight: 500; color: var(--fg); line-height: 1.1; }
.glance-label { font-size: 11px; color: var(--fg-dim); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.04em; }
`;

function layout(title: string, breadcrumb: string, body: string): string {
  const fetchedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>CivicLens</h1>
  <div class="sub">${breadcrumb} · generated ${esc(fetchedAt)}Z</div>
</header>
<main>
${body}
</main>
<footer>
Built from primary sources: Congress.gov, GovTrack, OpenFEC, House Clerk PFDs.
Every claim links to its source. Voice rules: evidence before opinion — no editorial scoring.
</footer>
</body>
</html>`;
}

// ─── Index page ─────────────────────────────────────────────────────────────

interface MemberOverview {
  member_id: string;
  name: string;
  party: string;
  chamber: string;
  state: string;
  donor_count: number;
  vote_count: number;
  trade_count: number;
}

async function fetchOverview(): Promise<MemberOverview[]> {
  const conn = await getDb();
  const r = await conn.run(`
    SELECT m.member_id, m.name, m.party, m.chamber, m.state,
      (SELECT COUNT(*) FROM donors d WHERE d.member_id = m.member_id) AS donor_count,
      (SELECT COUNT(*) FROM votes v WHERE v.member_id = m.member_id) AS vote_count,
      (SELECT COUNT(*) FROM pfd_transactions t WHERE t.member_id = m.member_id) AS trade_count
    FROM members m
    ORDER BY m.name
  `);
  const rows = await r.getRowObjects() as any[];
  return rows.map(r => ({
    member_id: String(r.member_id),
    name: String(r.name),
    party: String(r.party ?? ''),
    chamber: String(r.chamber ?? ''),
    state: String(r.state ?? ''),
    donor_count: Number(r.donor_count),
    vote_count: Number(r.vote_count),
    trade_count: Number(r.trade_count),
  }));
}

async function buildIndex(): Promise<void> {
  const overview = await fetchOverview();
  // Use the focused suspicious-trades feed: discretionary equities only,
  // before-vote direction only, 30-day window.  Cap per member so a single
  // high-volume trader (e.g. Pelosi) doesn't crowd out the rest.
  const suspicious = await suspiciousTradesCorpus(30, 2000);
  const allCollapsed = collapseTrades(suspicious);
  const PER_MEMBER_CAP = 5;
  const seen = new Map<string, number>();
  const trades: TradeRow[] = [];
  for (const t of allCollapsed) {
    const n = seen.get(t.member_id) ?? 0;
    if (n >= PER_MEMBER_CAP) continue;
    seen.set(t.member_id, n + 1);
    trades.push(t);
    if (trades.length >= 40) break;
  }

  const overviewRows = overview.map(m => `
    <tr data-name="${esc(m.name.toLowerCase())}" data-party="${esc(m.party.toLowerCase())}" data-state="${esc(m.state.toLowerCase())}" data-chamber="${esc(m.chamber.toLowerCase())}">
      <td><a class="member" href="members/${esc(m.member_id)}.html">${esc(m.name)}</a></td>
      <td><span class="tag ${partyClass(m.party)}">${esc(m.party.charAt(0) || '?')}</span> <span class="dim">${esc(m.chamber)}</span> <span class="muted">${esc(m.state)}</span></td>
      <td class="num">${m.donor_count}</td>
      <td class="num">${m.vote_count}</td>
      <td class="num">${m.trade_count > 0 ? m.trade_count : '<span class="muted">—</span>'}</td>
    </tr>`).join('');

  const tradeRows = trades.map(t => {
    // All trades in this feed are before-vote; show days_before_vote directly.
    const daysBefore = t.closest.days_before_vote;
    const proxLabel  = daysBefore === 0 ? 'same day' : `${daysBefore}d before`;
    const proxClass  = daysBefore === 0 ? 'tag same-day' : 'tag before';

    const closestLabel = t.closest.bill_title
      ? `<strong>${esc(t.closest.bill_title)}</strong>${t.closest.bill_id ? ` <span class="muted">${esc(t.closest.bill_id.replace(/-/g, ' ').toUpperCase())}</span>` : ''}`
      : esc((t.closest.vote_question ?? '').slice(0, 90));
    const closestHref = t.closest.bill_source_url ?? t.closest.vote_source_url ?? '#';

    const signals: string[] = [];
    if (t.closestJurisdiction) {
      const roleExtra = t.closestJurisdiction.member_committee_role && t.closestJurisdiction.member_committee_role !== 'member'
        ? ` · ${esc(t.closestJurisdiction.member_committee_role)}` : '';
      signals.push(`<span class="tag jurisdiction" title="${esc(t.closestJurisdiction.bill_committees ?? '')}">on committee${roleExtra}</span>`);
    }
    if ((t.closest as any).bill_mentions_ticker) {
      signals.push(`<span class="tag bill-match" title="Bill summary mentions ${esc(t.ticker ?? '')}">ticker in bill</span>`);
    }

    const jurisdictionVote = t.closestJurisdiction && t.closestJurisdiction !== t.closest
      ? `<div style="margin-top:3px;font-size:11px;" class="dim">Committee vote: <a class="row-link" href="${esc(t.closestJurisdiction.bill_source_url ?? t.closestJurisdiction.vote_source_url ?? '#')}" target="_blank" rel="noopener">${t.closestJurisdiction.bill_title ? `<strong>${esc(t.closestJurisdiction.bill_title)}</strong>` : esc((t.closestJurisdiction.vote_question ?? '').slice(0, 60))}</a> <span class="tag before" style="font-size:10px;">${t.closestJurisdiction.days_before_vote}d</span></div>` : '';

    return `
    <tr data-member="${esc(t.member_name.toLowerCase())}" data-ticker="${esc((t.ticker ?? '').toLowerCase())}" data-asset="${esc((t.asset ?? '').toLowerCase())}" data-type="${esc(t.tx_type ?? '')}" data-jurisdiction="${t.closestJurisdiction ? '1' : '0'}">
      <td>${esc(t.tx_date ?? '')}</td>
      <td><a class="member" href="members/${esc(t.member_id)}.html">${esc(t.member_name)}</a>${t.holder && t.holder !== 'self' ? ` <span class="tag holder-${esc(t.holder)}">${esc(t.holder)}</span>` : ''}</td>
      <td style="color:${(t.tx_type ?? '').includes('sale') ? '#e07840' : '#4caf7d'};">${esc(t.tx_type ?? '')}</td>
      <td>${t.ticker ? `<strong>${esc(t.ticker)}</strong> <span class="dim">—</span> ` : ''}${esc((t.asset ?? '').slice(0, 48))}</td>
      <td><span class="muted">${esc(t.amount_band ?? '')}</span></td>
      <td>
        <div><span class="${proxClass}">${esc(proxLabel)}</span> <span class="vote-count" title="votes in window">${t.vote_count}</span> ${signals.join(' ')}</div>
        <div style="margin-top:3px;"><a class="row-link" href="${esc(closestHref)}" target="_blank" rel="noopener">${closestLabel}</a></div>
        ${jurisdictionVote}
      </td>
      <td><a class="row-link" href="${esc(t.trade_source_url ?? '#')}" target="_blank" rel="noopener">PTR</a></td>
    </tr>`;
  }).join('');

  const body = `
<h2>Explore</h2>
<p class="lede"><a class="row-link" href="network.html">→ Co-sponsorship network</a> — who introduces bills together across the loaded corpus.</p>

<h2>Trades before votes — discretionary equities only</h2>
<p class="lede">Discretionary equity trades (stocks, options) made <em>before</em> a vote by the same member within 30 days. T-bills, ETFs, index funds, municipal bonds, and mutual funds excluded. One row per trade — sorted by committee jurisdiction overlap, then by days before vote. <span class="tag jurisdiction">on committee</span> means the member sat on a committee that handled that bill. <span class="tag bill-match">ticker in bill</span> means the bill summary mentions the traded ticker.</p>
${trades.length === 0
  ? '<div class="notice">No focused trade-vote pairs in DB yet. Run <code>npx tsx agents/pipeline.ts --load-pfd 2024</code> first.</div>'
  : `<div class="filter-bar" id="trades-filter">
  <input class="filter-input" id="trades-search" type="search" placeholder="Filter by member, ticker, or asset…" autocomplete="off">
  <label class="filter-toggle"><input type="checkbox" id="trades-type-buy"> purchases only</label>
  <label class="filter-toggle"><input type="checkbox" id="trades-type-sell"> sales only</label>
  <label class="filter-toggle"><input type="checkbox" id="trades-jurisdiction"> committee overlap only</label>
  <span class="filter-count" id="trades-count"></span>
</div>
<table id="trades-table">
<thead><tr><th>Trade date</th><th>Member</th><th>Type</th><th>Asset</th><th>Amount band</th><th>Before vote · signals</th><th>Source</th></tr></thead>
<tbody id="trades-tbody">${tradeRows}</tbody>
</table>`}

<h2>Corpus overview</h2>
<div class="filter-bar" id="corpus-filter">
  <input class="filter-input" id="corpus-search" type="search" placeholder="Filter by name, party, state, or chamber…" autocomplete="off">
  <span class="filter-count" id="corpus-count"></span>
</div>
<table id="corpus-table">
<thead><tr><th>Member</th><th>Party · Chamber · State</th><th class="num">Donors</th><th class="num">Votes</th><th class="num">Trades</th></tr></thead>
<tbody id="corpus-tbody">${overviewRows}</tbody>
</table>

<script>
(function() {
  function filterTable(tbodyId, countId, predicate) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    const rows = tbody.querySelectorAll('tr');
    let shown = 0;
    rows.forEach(function(row) {
      const vis = predicate(row);
      row.style.display = vis ? '' : 'none';
      if (vis) shown++;
    });
    const el = document.getElementById(countId);
    if (el) el.textContent = shown + ' / ' + rows.length;
  }

  // ── Corpus filter ──────────────────────────────────────────────────────────
  var corpusSearch = document.getElementById('corpus-search');
  function applyCorpusFilter() {
    var q = corpusSearch ? corpusSearch.value.trim().toLowerCase() : '';
    filterTable('corpus-tbody', 'corpus-count', function(row) {
      if (!q) return true;
      return (row.dataset.name   || '').includes(q) ||
             (row.dataset.party  || '').includes(q) ||
             (row.dataset.state  || '').includes(q) ||
             (row.dataset.chamber|| '').includes(q);
    });
  }
  if (corpusSearch) {
    corpusSearch.addEventListener('input', applyCorpusFilter);
    applyCorpusFilter();
  }

  // ── Trades filter ──────────────────────────────────────────────────────────
  var tradesSearch       = document.getElementById('trades-search');
  var tradesBuy          = document.getElementById('trades-type-buy');
  var tradesSell         = document.getElementById('trades-type-sell');
  var tradesJurisdiction = document.getElementById('trades-jurisdiction');
  function applyTradesFilter() {
    var q    = tradesSearch       ? tradesSearch.value.trim().toLowerCase() : '';
    var buy  = tradesBuy          ? tradesBuy.checked  : false;
    var sell = tradesSell         ? tradesSell.checked : false;
    var jur  = tradesJurisdiction ? tradesJurisdiction.checked : false;
    filterTable('trades-tbody', 'trades-count', function(row) {
      if (q && !(
        (row.dataset.member || '').includes(q) ||
        (row.dataset.ticker || '').includes(q) ||
        (row.dataset.asset  || '').includes(q)
      )) return false;
      var type = (row.dataset.type || '').toLowerCase();
      if (buy  && !type.includes('purchase')) return false;
      if (sell && !type.includes('sale'))     return false;
      if (jur  && row.dataset.jurisdiction !== '1') return false;
      return true;
    });
  }
  [tradesSearch, tradesBuy, tradesSell, tradesJurisdiction].forEach(function(el) {
    if (el) el.addEventListener(el.tagName === 'INPUT' && el.type === 'checkbox' ? 'change' : 'input', applyTradesFilter);
  });
  applyTradesFilter();
})();
</script>
`;

  const html = layout('CivicLens — Corpus', `<a href="index.html">Corpus</a>`, body);
  writeFileSync(resolve(OUT_DIR, 'index.html'), html);
  console.log(`  ✓ site/index.html  (${overview.length} members, ${trades.length} trade rows)`);
}

// ─── Member page ────────────────────────────────────────────────────────────

interface MemberDetail {
  member_id: string;
  name: string;
  party: string | null;
  chamber: string | null;
  state: string | null;
  district: string | null;
  bio_summary: string | null;
  bioguide_id: string | null;
  fec_candidate_id: string | null;
  trade_activity: string | null;
}

export async function fetchMember(memberId: string): Promise<MemberDetail | null> {
  const conn = await getDb();
  const r = await conn.run(
    `SELECT member_id, name, party, chamber, state, district, bio_summary, bioguide_id,
            fec_candidate_id, trade_activity
     FROM members WHERE member_id = ?`,
    [memberId],
  );
  const rows = await r.getRowObjects() as any[];
  if (rows.length === 0) return null;
  const m = rows[0];
  return {
    member_id: String(m.member_id),
    name: String(m.name),
    party: m.party ?? null,
    chamber: m.chamber ?? null,
    state: m.state ?? null,
    district: m.district ?? null,
    bio_summary: m.bio_summary ?? null,
    bioguide_id: m.bioguide_id ?? null,
    fec_candidate_id: m.fec_candidate_id ?? null,
    trade_activity:   m.trade_activity ?? null,
  };
}

async function fetchTopDonors(memberId: string, limit = 15): Promise<any[]> {
  const conn = await getDb();
  const r = await conn.run(
    `SELECT donor_name, donor_type, amount, latest_date, source_url
     FROM donors WHERE member_id = ? ORDER BY amount DESC LIMIT ?`,
    [memberId, limit],
  );
  return await r.getRowObjects() as any[];
}

async function fetchAllTrades(memberId: string, limit = 500): Promise<any[]> {
  const conn = await getDb();
  const r = await conn.run(
    `SELECT filing_id, tx_date, tx_type, asset, ticker, asset_type, amount_band, holder,
            sub_account, source_url
     FROM pfd_transactions WHERE member_id = ?
     ORDER BY tx_date DESC LIMIT ?`,
    [memberId, limit],
  );
  return await r.getRowObjects() as any[];
}

interface TimelineVote {
  date: string;
  position: string;
  question: string;
  bill_title: string | null;
  source_url: string | null;
}

interface TimelineTrade {
  date: string;
  tx_type: string;
  asset: string;
  ticker: string | null;
  amount_band: string;
  source_url: string | null;
}

async function fetchTimelineData(memberId: string): Promise<{ votes: TimelineVote[]; trades: TimelineTrade[] }> {
  const conn = await getDb();

  // Votes: cap at 2000, sorted ascending for the timeline axis
  const vr = await conn.run(
    `SELECT v.date, v.position, v.question, bs.title AS bill_title, v.source_url
     FROM votes v
     LEFT JOIN bill_summaries bs ON bs.bill_id = v.bill_id
     WHERE v.member_id = ? AND v.date IS NOT NULL
     ORDER BY v.date ASC
     LIMIT 2000`,
    [memberId],
  );
  const vrows = await vr.getRowObjects() as any[];
  const votes: TimelineVote[] = vrows.map(r => ({
    date:       String(r.date),
    position:   String(r.position ?? ''),
    question:   String(r.question ?? ''),
    bill_title: r.bill_title ? String(r.bill_title) : null,
    source_url: r.source_url ? String(r.source_url) : null,
  }));

  // Trades: all of them, ascending
  const tr = await conn.run(
    `SELECT tx_date AS date, tx_type, asset, ticker, amount_band, source_url
     FROM pfd_transactions
     WHERE member_id = ? AND tx_date IS NOT NULL
     ORDER BY tx_date ASC`,
    [memberId],
  );
  const trows = await tr.getRowObjects() as any[];
  const trades: TimelineTrade[] = trows.map(r => ({
    date:        String(r.date),
    tx_type:     String(r.tx_type ?? ''),
    asset:       String(r.asset ?? ''),
    ticker:      r.ticker ? String(r.ticker) : null,
    amount_band: String(r.amount_band ?? ''),
    source_url:  r.source_url ? String(r.source_url) : null,
  }));

  return { votes, trades };
}

function buildTimelineBlock(_memberId: string, votes: TimelineVote[], trades: TimelineTrade[]): string {
  if (votes.length === 0 && trades.length === 0) {
    return '<p class="muted">No dated records to display on timeline.</p>';
  }

  // All values going into the JSON originate from DB rows passed through the
  // typed TimelineVote / TimelineTrade mappers above; escaping is redundant
  // but applied defensively by the client-side escHtml() before any DOM write.
  const dataJson = JSON.stringify({ votes, trades });

  return `<div id="tl-wrap" style="position:relative;width:100%;overflow-x:auto;border:1px solid var(--line);border-radius:4px;margin-bottom:8px;background:#080a0d;">
  <svg id="tl-svg" style="display:block;min-width:900px;"></svg>
  <div id="tl-tip" style="position:fixed;display:none;background:#1e2229;border:1px solid var(--line);border-radius:4px;padding:8px 12px;font-size:12px;color:var(--fg);pointer-events:none;max-width:320px;z-index:999;line-height:1.5;"></div>
</div>
<div style="font-size:11px;color:var(--fg-muted);margin-bottom:16px;">
  <span style="margin-right:14px;">● <span style="color:#5b9ed8;">Yea</span></span>
  <span style="margin-right:14px;">● <span style="color:#d65a5a;">Nay</span></span>
  <span style="margin-right:14px;">● <span style="color:#5f6368;">Present / Not voting</span></span>
  <span style="margin-right:14px;">◆ <span style="color:#4caf7d;">Purchase</span></span>
  <span style="margin-right:14px;">◆ <span style="color:#e07840;">Sale</span></span>
</div>
<script>
(function() {
  const DATA = ${dataJson};
  const svgEl = document.getElementById('tl-svg');
  const tip   = document.getElementById('tl-tip');
  if (!svgEl || !DATA.votes.length && !DATA.trades.length) return;

  function escHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  const PAD = { top: 28, bottom: 28, left: 48, right: 24 };
  const ROW_VOTE = 28, ROW_TRADE = 62, H = 96;

  const allDates = DATA.votes.map(v => v.date).concat(DATA.trades.map(t => t.date));
  const minD = allDates.reduce((a, b) => a < b ? a : b);
  const maxD = allDates.reduce((a, b) => a > b ? a : b);

  const wrap = document.getElementById('tl-wrap');
  const totalWidth = Math.max(wrap.clientWidth, 900);
  const innerW = totalWidth - PAD.left - PAD.right;

  svgEl.setAttribute('width', totalWidth);
  svgEl.setAttribute('height', H);

  const NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  function dateToX(d) {
    const t0 = new Date(minD).getTime(), t1 = new Date(maxD).getTime();
    const t  = new Date(d).getTime();
    return PAD.left + (t1 === t0 ? innerW / 2 : (t - t0) / (t1 - t0) * innerW);
  }

  const svg = el('svg', { width: totalWidth, height: H }, null);
  svgEl.parentNode.replaceChild(svg, svgEl);
  svg.id = 'tl-svg';
  svg.style.display = 'block';
  svg.style.minWidth = '900px';

  // Axis line
  el('line', { x1: PAD.left, y1: H - PAD.bottom, x2: totalWidth - PAD.right, y2: H - PAD.bottom, stroke: '#2a2e35', 'stroke-width': '1' }, svg);

  // Year ticks
  const y0 = parseInt(minD.slice(0,4)), y1 = parseInt(maxD.slice(0,4));
  for (let y = y0; y <= y1 + 1; y++) {
    const d = y + '-01-01';
    if (d < minD || d > maxD + '-99') continue;
    const x = dateToX(d);
    el('line', { x1: x, y1: H - PAD.bottom, x2: x, y2: H - PAD.bottom + 5, stroke: '#2a2e35' }, svg);
    const t = el('text', { x: x, y: H - PAD.bottom + 14, 'text-anchor': 'middle', fill: '#5f6368', 'font-size': '10' }, svg);
    t.textContent = String(y);
  }

  // Vote position color
  function voteColor(pos) {
    const p = (pos ?? '').toLowerCase();
    if (p === 'yea') return '#5b9ed8';
    if (p === 'nay') return '#d65a5a';
    return '#3a3e45';
  }

  // Trade color
  function tradeColor(type) {
    const t = (type ?? '').toLowerCase();
    if (t === 'purchase') return '#4caf7d';
    if (t.startsWith('sale')) return '#e07840';
    return '#9aa0a6';
  }

  // Tooltip helpers
  function showTip(evt, html) {
    tip.style.display = 'block';
    tip.innerHTML = html;
    moveTip(evt);
  }
  function moveTip(evt) {
    const x = evt.clientX + 14, y = evt.clientY - 8;
    tip.style.left = Math.min(x, window.innerWidth - 340) + 'px';
    tip.style.top  = Math.max(y, 4) + 'px';
  }
  function hideTip() { tip.style.display = 'none'; }

  // Votes — cluster by month so 2000 dots don't pile up.
  // Pick one representative per month (the Nay if any, else first).
  const byMonth = new Map();
  for (const v of DATA.votes) {
    const mo = v.date.slice(0, 7);
    if (!byMonth.has(mo)) byMonth.set(mo, []);
    byMonth.get(mo).push(v);
  }
  for (const [mo, vs] of byMonth) {
    // Pick the most "interesting": Nay > Present > Yea (surface dissent)
    const priority = v => v.position === 'Nay' ? 0 : v.position === 'Present' ? 1 : v.position === 'Not Voting' ? 2 : 3;
    vs.sort((a, b) => priority(a) - priority(b));
    const rep = vs[0];
    const x = dateToX(rep.date);
    const c = el('circle', { cx: x, cy: ROW_VOTE, r: '3', fill: voteColor(rep.position), opacity: '0.75', style: 'cursor:default' }, svg);
    const allInMonth = vs.length;
    c.addEventListener('mouseenter', evt => {
      const label = escHtml(rep.bill_title ?? rep.question).slice(0, 120);
      const href  = rep.source_url ? '<br><a href="' + escHtml(rep.source_url) + '" target="_blank" rel="noopener" style="color:#79b8ff;">source ↗</a>' : '';
      showTip(evt,
        '<strong>' + escHtml(rep.date) + '</strong> · ' + escHtml(rep.position) +
        (allInMonth > 1 ? ' <span style="color:#5f6368;">(+' + (allInMonth-1) + ' more that month)</span>' : '') +
        '<br>' + label + href
      );
    });
    c.addEventListener('mousemove', moveTip);
    c.addEventListener('mouseleave', hideTip);
  }

  // Trades — diamond shape (rotated square)
  for (const t of DATA.trades) {
    const x = dateToX(t.date);
    const size = 5;
    const pts = [x+','+( ROW_TRADE-size), (x+size)+','+ROW_TRADE, x+','+(ROW_TRADE+size), (x-size)+','+ROW_TRADE].join(' ');
    const d = el('polygon', { points: pts, fill: tradeColor(t.tx_type), opacity: '0.9', style: 'cursor:default' }, svg);
    d.addEventListener('mouseenter', evt => {
      const asset = escHtml((t.ticker ? t.ticker + ' — ' : '') + t.asset).slice(0, 100);
      const href  = t.source_url ? '<br><a href="' + escHtml(t.source_url) + '" target="_blank" rel="noopener" style="color:#79b8ff;">PTR ↗</a>' : '';
      showTip(evt,
        '<strong>' + escHtml(t.date) + '</strong> · ' + escHtml(t.tx_type) +
        '<br>' + asset +
        '<br><span style="color:#5f6368;">' + escHtml(t.amount_band) + '</span>' + href
      );
    });
    d.addEventListener('mousemove', moveTip);
    d.addEventListener('mouseleave', hideTip);
  }

  // Row labels
  if (DATA.votes.length) {
    const lt = el('text', { x: PAD.left - 4, y: ROW_VOTE + 4, 'text-anchor': 'end', fill: '#5f6368', 'font-size': '10' }, svg);
    lt.textContent = 'votes';
  }
  if (DATA.trades.length) {
    const lt = el('text', { x: PAD.left - 4, y: ROW_TRADE + 4, 'text-anchor': 'end', fill: '#5f6368', 'font-size': '10' }, svg);
    lt.textContent = 'trades';
  }
})();
<\/script>`;
}

// Current Congress + cycle. 118th Congress = 2023-2024. Update when 119th seats.
const CURRENT_CONGRESS = 118;
const CYCLE_START = '2023-01-03';
const CYCLE_END   = '2025-01-03';

interface ActivityGlance {
  trades: number;
  tradeVolume: number;       // sum of band midpoints, nullable bands skipped
  votes: number;
  billsSponsored: number;
  topDonorType: string | null;
  distinctTickers: number;   // distinct tickers in pfd_transactions for this cycle
  tradesNearRelatedVote: number; // distinct trades within 14d of a related vote (ticker mention OR committee jurisdiction)
}

async function fetchActivityGlance(memberId: string): Promise<ActivityGlance> {
  const conn = await getDb();

  // Single rolled-up query for the four counts that come from per-member tables.
  const r = await conn.run(`
    WITH band_mid AS (
      SELECT CASE amount_band
        WHEN '$1,001 - $15,000'        THEN 8000
        WHEN '$15,001 - $50,000'       THEN 32500
        WHEN '$50,001 - $100,000'      THEN 75000
        WHEN '$100,001 - $250,000'     THEN 175000
        WHEN '$250,001 - $500,000'     THEN 375000
        WHEN '$500,001 - $1,000,000'   THEN 750000
        WHEN '$1,000,001 - $5,000,000' THEN 3000000
        WHEN '$5,000,001 - $25,000,000' THEN 15000000
        WHEN '$25,000,001 - $50,000,000' THEN 37500000
        WHEN 'Over $50,000,000'        THEN 50000000
        ELSE NULL
      END AS mid
      FROM pfd_transactions
      WHERE member_id = ? AND tx_date >= ?::DATE AND tx_date < ?::DATE
    ),
    counts AS (
      SELECT
        (SELECT count(*) FROM pfd_transactions WHERE member_id = ? AND tx_date >= ?::DATE AND tx_date < ?::DATE) AS trades,
        (SELECT coalesce(sum(mid), 0) FROM band_mid)                                                           AS trade_volume,
        (SELECT count(*) FROM votes  WHERE member_id = ? AND date >= ?::DATE AND date < ?::DATE)               AS votes,
        (SELECT count(*) FROM bills  WHERE member_id = ? AND sponsor_role = 'sponsor')                         AS bills_sponsored
    )
    SELECT * FROM counts
  `, [
    memberId, CYCLE_START, CYCLE_END,
    memberId, CYCLE_START, CYCLE_END,
    memberId, CYCLE_START, CYCLE_END,
    memberId,
  ]);
  const row = (await r.getRowObjects())[0] as any;

  // Top donor type — separate query (different aggregation shape).
  const dtR = await conn.run(`
    SELECT donor_type, sum(amount) AS total
    FROM donors
    WHERE member_id = ? AND donor_type IS NOT NULL
    GROUP BY donor_type
    ORDER BY total DESC
    LIMIT 1
  `, [memberId]);
  const dtRow = (await dtR.getRowObjects())[0] as any;

  // Distinct tickers traded in cycle.
  const dtcR = await conn.run(`
    SELECT count(DISTINCT ticker) AS n
    FROM pfd_transactions
    WHERE member_id = ? AND ticker IS NOT NULL AND ticker <> ''
      AND tx_date >= ?::DATE AND tx_date < ?::DATE
  `, [memberId, CYCLE_START, CYCLE_END]);
  const dtcRow = (await dtcR.getRowObjects())[0] as any;

  // Spec metric: distinct trades within 14 days of a related vote, where
  // "related" means the bill summary names the traded ticker OR the trader
  // sits on a committee with jurisdiction over the bill. Counts unique
  // (filing, asset/ticker) trades, not pair rows.
  const relR = await conn.run(`
    SELECT count(DISTINCT (trade_filing_id || '|' || COALESCE(asset,'') || '|' || COALESCE(ticker,''))) AS n
    FROM v_suspicious_trades
    WHERE member_id = ?
      AND tx_date >= ?::DATE AND tx_date < ?::DATE
      AND days_abs <= 14
      AND (bill_mentions_ticker = TRUE OR member_on_bill_committee = TRUE)
  `, [memberId, CYCLE_START, CYCLE_END]);
  const relRow = (await relR.getRowObjects())[0] as any;

  return {
    trades:           Number(row.trades ?? 0),
    tradeVolume:      Number(row.trade_volume ?? 0),
    votes:            Number(row.votes ?? 0),
    billsSponsored:   Number(row.bills_sponsored ?? 0),
    topDonorType:     dtRow ? String(dtRow.donor_type) : null,
    distinctTickers:  Number(dtcRow.n ?? 0),
    tradesNearRelatedVote: Number(relRow?.n ?? 0),
  };
}

function renderActivityGlance(g: ActivityGlance): string {
  const cell = (label: string, value: string) =>
    `<div class="glance-cell"><div class="glance-value">${value}</div><div class="glance-label">${esc(label)}</div></div>`;
  return `
<h2>Activity at a glance</h2>
<p class="lede" style="margin-bottom:8px;">${CURRENT_CONGRESS}th Congress, ${CYCLE_START.slice(0,4)}–${CYCLE_END.slice(0,4)} cycle. Counts only.</p>
<div class="glance-grid">
  ${cell('Trades',                   g.trades.toLocaleString())}
  ${cell('Trade volume',             fmtMoney(g.tradeVolume))}
  ${cell('Votes cast',               g.votes.toLocaleString())}
  ${cell('Bills sponsored (all-time)', g.billsSponsored.toLocaleString())}
  ${cell('Top donor type',           g.topDonorType ?? '—')}
  ${cell('Distinct tickers traded',  g.distinctTickers.toLocaleString())}
  ${cell('Trades within 14d of related vote', g.tradesNearRelatedVote.toLocaleString())}
</div>
`;
}

interface CosponsorEdgeForMember {
  peer_id: string;
  peer_name: string;
  peer_party: string | null;
  shared_bills: number;
}

async function fetchCosponsorEdgesForMember(memberId: string, limit = 5): Promise<CosponsorEdgeForMember[]> {
  const conn = await getDb();
  const r = await conn.run(`
    WITH pairs AS (
      SELECT b.member_id AS peer_id, count(*) AS shared_bills
      FROM bills a
      JOIN bills b ON a.bill_id = b.bill_id AND a.member_id <> b.member_id
      WHERE a.member_id = ?
      GROUP BY b.member_id
    )
    SELECT p.peer_id, m.name AS peer_name, m.party AS peer_party, p.shared_bills
    FROM pairs p
    JOIN members m ON m.member_id = p.peer_id
    ORDER BY p.shared_bills DESC
    LIMIT ?
  `, [memberId, limit]);
  const rows = await r.getRowObjects() as any[];
  return rows.map(row => ({
    peer_id:      String(row.peer_id),
    peer_name:    String(row.peer_name),
    peer_party:   row.peer_party ?? null,
    shared_bills: Number(row.shared_bills),
  }));
}

function renderCosponsorEmbed(edges: CosponsorEdgeForMember[]): string {
  if (edges.length === 0) {
    return `
<h2>Co-sponsorship</h2>
<p class="muted">No shared-bill peers in corpus.</p>
`;
  }
  const rows = edges.map(e => `
    <tr>
      <td><a class="member" href="${esc(e.peer_id)}.html">${esc(e.peer_name)}</a> ${e.peer_party ? `<span class="tag ${partyClass(e.peer_party)}" style="margin-left:4px;">${esc(e.peer_party)}</span>` : ''}</td>
      <td class="num">${e.shared_bills}</td>
    </tr>`).join('');
  return `
<h2>Co-sponsorship</h2>
<p class="lede" style="margin-bottom:8px;">Top peers by shared bills in the loaded corpus. <a class="row-link" href="../network.html">→ Full co-sponsorship network</a></p>
<table>
  <thead><tr><th>Peer</th><th class="num">Shared bills</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
`;
}

function renderPatternsPlaceholder(): string {
  return `
<h2>Patterns detected</h2>
<p class="muted">Pattern detection coming soon — see <a class="row-link" href="../about.html">/about</a> for methodology when published.</p>
`;
}

async function renderOutsideSpending(m: MemberDetail, cycle: number): Promise<string> {
  if (!m.fec_candidate_id) return '';

  let report: SuperPacIEReport;
  try {
    report = await fetchSuperPacIE(m.fec_candidate_id, cycle, { topFunders: 3 });
  } catch (e) {
    console.warn(`[outside-spending] fetch failed for ${m.member_id}:`, (e as Error).message);
    return '';
  }

  if (report.supporting.length === 0 && report.opposing.length === 0) return '';

  function fmtPac(p: SuperPacIE, funders: SuperPacFunder[] | undefined): string {
    const meta = [p.committeeType, p.designation, p.party].filter(Boolean).join(' · ');
    const realFunders = (funders ?? []).filter(f => !f.isPassthrough);
    const fundersHtml = realFunders.length > 0
      ? `<div class="dim" style="font-size:11px; margin-top:4px;">
           Top funders: ${realFunders.slice(0, 3).map(f =>
             `${esc(f.contributorName)} <span class="muted">${fmtMoney(f.amount)}</span>`
           ).join(' · ')}
         </div>`
      : '';
    return `<div class="pac-row">
      <div class="pac-name"><strong>${esc(p.committeeName ?? p.committeeId)}</strong>
        ${meta ? `<span class="muted" style="font-size:11px;"> · ${esc(meta)}</span>` : ''}
      </div>
      <div class="pac-amount num">${fmtMoney(p.totalAmount)} <span class="muted" style="font-size:11px;">(${p.count} filing${p.count === 1 ? '' : 's'})</span></div>
      ${fundersHtml}
    </div>`;
  }

  const supportingTop = report.supporting.slice(0, 3);
  const opposingTop = report.opposing.slice(0, 3);
  const funders = report.topFunders ?? {};

  const supportingBlock = supportingTop.length === 0
    ? `<p class="muted">No supporting independent expenditure in ${cycle} cycle.</p>`
    : `<div class="pac-list">${supportingTop.map(p => fmtPac(p, funders[p.committeeId])).join('')}</div>`;

  const opposingBlock = opposingTop.length === 0
    ? `<p class="muted">No opposing independent expenditure in ${cycle} cycle.</p>`
    : `<div class="pac-list">${opposingTop.map(p => fmtPac(p, funders[p.committeeId])).join('')}</div>`;

  return `
<h2>Outside spending (Super PACs)</h2>
<p class="lede" style="margin-bottom:8px;">
  Independent expenditure for or against ${esc(m.name)}, ${cycle} cycle.
  Uncapped, not coordinated with the candidate. Funders shown where Schedule A is available.
</p>
<div class="pac-totals">
  <span class="pac-side support">Supporting: ${fmtMoney(report.totalSupporting)}</span>
  <span class="pac-side oppose">Opposing: ${fmtMoney(report.totalOpposing)}</span>
</div>
<h3 style="margin-top:16px;">Supporting Super PACs</h3>
${supportingBlock}
<h3 style="margin-top:16px;">Opposing Super PACs</h3>
${opposingBlock}
`;
}

export async function buildMemberPage(m: MemberDetail): Promise<void> {
  const [donors, trades, peers, suspiciousPairs, allTradePairs, timeline, cosponsorEdges] = await Promise.all([
    fetchTopDonors(m.member_id),
    fetchAllTrades(m.member_id),
    findSharedDonors(m.member_id),
    findSuspiciousTrades(m.member_id, 90),    // discretionary, before-vote only
    findTradesNearVotes(m.member_id, 30),     // all trades for raw count
    fetchTimelineData(m.member_id),
    fetchCosponsorEdgesForMember(m.member_id, 5),
  ]);
  const collapsedSuspicious = collapseTrades(suspiciousPairs);
  const collapsedTrades = collapseTrades(allTradePairs);

  const meta = `<div class="kv">
    <div class="k">Party</div>            <div><span class="tag ${partyClass(m.party ?? '')}">${esc(m.party ?? '?')}</span></div>
    <div class="k">Chamber</div>          <div>${esc(m.chamber ?? '—')}</div>
    <div class="k">State / district</div> <div>${esc(m.state ?? '—')}${m.district ? ` ${esc(m.district)}` : ''}</div>
    <div class="k">Bioguide</div>         <div><span class="muted">${esc(m.bioguide_id ?? '—')}</span></div>
    <div class="k">FEC candidate</div>    <div><span class="muted">${esc(m.fec_candidate_id ?? '—')}</span></div>
  </div>`;

  const bio = m.bio_summary ? `<p class="lede">${esc(m.bio_summary)}</p>` : '';

  const tradeActivityBlock = m.trade_activity
    ? `<div class="trade-activity">
  <h2>Trade activity</h2>
  <p class="lede">${esc(m.trade_activity)}</p>
</div>`
    : '';

  const donorsBlock = donors.length === 0
    ? '<p class="muted">No donors loaded.</p>'
    : `<table>
<thead><tr><th>Donor</th><th>Type</th><th class="num">Lifetime amount</th><th>Most recent</th><th>Source</th></tr></thead>
<tbody>${donors.map(d => `
  <tr>
    <td>${esc(d.donor_name)}</td>
    <td><span class="muted">${esc(d.donor_type ?? '—')}</span></td>
    <td class="num">${fmtMoney(Number(d.amount))}</td>
    <td><span class="muted">${esc(d.latest_date ? String(d.latest_date) : '—')}</span></td>
    <td><a class="row-link" href="${esc(d.source_url ?? '#')}" target="_blank" rel="noopener">FEC</a></td>
  </tr>`).join('')}</tbody>
</table>`;

  const peersBlock = peers.length === 0
    ? '<p class="muted">No shared-donor peers in corpus.</p>'
    : `<table>
<thead><tr><th>Peer</th><th class="num">Shared donors</th><th class="num">Combined amount</th></tr></thead>
<tbody>${peers.map(p => `
  <tr>
    <td><a class="member" href="${esc(p.peer_id)}.html">${esc(p.peer_name)}</a></td>
    <td class="num">${p.shared_count}</td>
    <td class="num">${fmtMoney(p.combined_amount)}</td>
  </tr>`).join('')}</tbody>
</table>`;

  // ── Card renderer for one collapsed trade ───────────────────────────────
  function renderTradeCard(t: TradeRow): string {
    const typeColor = (t.tx_type ?? '').includes('sale') ? '#e07840' : '#4caf7d';
    const typeLabel = t.tx_type ?? '—';
    const holderTag = t.holder && t.holder !== 'self'
      ? `<span class="tag holder-${esc(t.holder)}">${esc(t.holder)}</span>`
      : '';

    const header = `<div class="tc-header">
      <div class="tc-asset">
        ${t.ticker ? `<span style="color:var(--fg);font-weight:600;">${esc(t.ticker)}</span> <span class="dim">— </span>` : ''}${esc((t.asset ?? '').slice(0, 60))}
      </div>
      <div class="tc-meta">
        <span style="color:${typeColor};">${esc(typeLabel)}</span>
        <span class="muted">·</span>
        <span>${esc(t.tx_date ?? '—')}</span>
        ${holderTag ? `<span class="muted">·</span> ${holderTag}` : ''}
        <span class="muted">·</span>
        <span class="dim">${esc(t.amount_band ?? '—')}</span>
        <a class="row-link" href="${esc(t.trade_source_url ?? '#')}" target="_blank" rel="noopener" style="margin-left:6px;">PTR ↗</a>
      </div>
    </div>`;

    // Votes: show up to 4; closestJurisdiction first (if present), then by days_before_vote
    const voteRows: string[] = [];
    const seen = new Set<string>();
    const ordered = [
      ...(t.closestJurisdiction ? [t.closestJurisdiction] : []),
      t.closest,
      ...t.example_votes,
    ].filter(v => {
      if (seen.has(v.vote_id)) return false;
      seen.add(v.vote_id);
      return true;
    }).slice(0, 4);

    for (const v of ordered) {
      const daysBefore = v.days_before_vote;
      const proxTag = daysBefore === 0
        ? `<span class="tag same-day">same day</span>`
        : `<span class="tag before">${daysBefore}d before</span>`;
      const billLabel = v.bill_title
        ? `<strong>${esc(v.bill_title)}</strong>${v.bill_id ? ` <span class="muted" style="font-size:10px;">${esc(v.bill_id.replace(/-/g,' ').toUpperCase())}</span>` : ''}`
        : esc((v.vote_question ?? '').slice(0, 100));
      const billHref = v.bill_source_url ?? v.vote_source_url ?? '#';

      const signals: string[] = [];
      if (v.member_on_bill_committee) {
        const roleExtra = v.member_committee_role && v.member_committee_role !== 'member'
          ? ` · ${esc(v.member_committee_role)}` : '';
        signals.push(`<span class="tag jurisdiction" title="${esc(v.bill_committees ?? '')}">on committee${roleExtra}</span>`);
      }
      if ((v as any).bill_mentions_ticker) {
        signals.push(`<span class="tag bill-match" title="Bill summary mentions ${esc(t.ticker ?? '')}">bill mentions ticker</span>`);
      }
      const signalHtml = signals.length ? `<span style="margin-left:4px;">${signals.join(' ')}</span>` : '';

      const summary = v.bill_summary
        ? `<div class="dim" style="font-size:11px;margin-top:2px;max-width:580px;">${esc(v.bill_summary.slice(0, 200))}${v.bill_summary.length > 200 ? '…' : ''}</div>`
        : '';

      voteRows.push(`<div class="tc-vote-row">
        ${proxTag}
        <div>
          <a class="row-link" href="${esc(billHref)}" target="_blank" rel="noopener">${billLabel}</a>
          ${signalHtml}
          ${summary}
        </div>
      </div>`);
    }

    if (t.vote_count > ordered.length) {
      voteRows.push(`<div class="dim" style="font-size:11px;margin-top:4px;">+${t.vote_count - ordered.length} more vote${t.vote_count - ordered.length === 1 ? '' : 's'} in window</div>`);
    }

    const votesHtml = voteRows.length > 0
      ? `<div class="tc-votes">${voteRows.join('')}</div>`
      : '';

    return `<div class="trade-card intensity-${rowIntensity(t)}">${header}${votesHtml}</div>`;
  }

  const suspiciousTradesBlock = collapsedSuspicious.length === 0 && trades.length === 0
    ? '<p class="muted">No PFD trades in DB. Run the loader if expected.</p>'
    : collapsedSuspicious.length === 0
    ? `<p class="muted">${trades.length} trade${trades.length === 1 ? '' : 's'} on file — none are discretionary equity trades before a vote within 90 days.</p>`
    : collapsedSuspicious.map(renderTradeCard).join('');

  // All trades tab (flat table, regardless of type or proximity)
  const allTradesBlock = trades.length === 0
    ? ''
    : `<table>
<thead><tr><th>Date</th><th>Type</th><th>Asset</th><th>Amount band</th><th>Holder</th><th>Sub-account</th><th>Source</th></tr></thead>
<tbody>${trades.map(t => `
  <tr>
    <td>${esc(t.tx_date ? String(t.tx_date) : '')}</td>
    <td>${esc(t.tx_type ?? '')}</td>
    <td>${esc((t.asset ?? '').slice(0, 50))}${t.ticker ? ` <span class="muted">(${esc(t.ticker)})</span>` : ''}</td>
    <td><span class="muted">${esc(t.amount_band ?? '')}</span></td>
    <td>${t.holder && t.holder !== 'self' ? `<span class="tag holder-${esc(t.holder)}">${esc(t.holder)}</span>` : '<span class="muted">self</span>'}</td>
    <td><span class="muted">${esc(t.sub_account ?? '')}</span></td>
    <td><a class="row-link" href="${esc(t.source_url ?? '#')}" target="_blank" rel="noopener">PTR</a></td>
  </tr>`).join('')}</tbody>
</table>`;

  const timelineBlock = buildTimelineBlock(m.member_id, timeline.votes, timeline.trades);
  const outsideSpendingBlock = await renderOutsideSpending(m, 2024);
  const cosponsorBlock = renderCosponsorEmbed(cosponsorEdges);
  const patternsBlock = renderPatternsPlaceholder();
  const glance = await fetchActivityGlance(m.member_id);
  const glanceBlock = renderActivityGlance(glance);
  const tabId = `tabs-${m.member_id.replace(/[^a-z0-9]/g, '-')}`;

  const body = `
<h2>${esc(m.name)}</h2>
${meta}
${bio}
${glanceBlock}
${tradeActivityBlock}
<h2>Timeline</h2>
<p class="lede" style="margin-bottom:8px;">Votes (circles, top row) and trades (diamonds, bottom row) plotted on the same axis. Hover for detail. One dot per month — most significant vote shown (Nay preferred over Yea).</p>
${timelineBlock}

<h2>Trades &amp; bills</h2>
<p class="lede" style="margin-bottom:12px;">
  Showing <strong>${collapsedSuspicious.length}</strong> discretionary equity trade${collapsedSuspicious.length === 1 ? '' : 's'} made <em>before</em> a vote within 90 days.
  T-bills, ETFs, index funds, munis, and bonds excluded — they carry no single-company vote nexus.
  ${collapsedTrades.length > collapsedSuspicious.length ? `<a class="row-link" href="#all-trades-tab" onclick="showTab('${esc(tabId)}','all')">Show all ${trades.length} trades →</a>` : ''}
</p>
<div class="section-tabs" id="${esc(tabId)}">
  <div class="section-tab active" onclick="showTab('${esc(tabId)}','focused')" data-tab="focused">Focused (before-vote, discretionary)</div>
  <div class="section-tab" onclick="showTab('${esc(tabId)}','all')" data-tab="all" id="all-trades-tab">All trades (${trades.length})</div>
</div>
<div class="tab-panel active" data-panel-for="${esc(tabId)}" data-panel="focused">
${suspiciousTradesBlock}
</div>
<div class="tab-panel" data-panel-for="${esc(tabId)}" data-panel="all">
${allTradesBlock || '<p class="muted">No trades in DB.</p>'}
</div>
<script>
function showTab(tabGroupId, panelName) {
  document.querySelectorAll('#' + tabGroupId + ' .section-tab').forEach(function(el) {
    el.classList.toggle('active', el.dataset.tab === panelName);
  });
  document.querySelectorAll('[data-panel-for="' + tabGroupId + '"]').forEach(function(el) {
    el.classList.toggle('active', el.dataset.panel === panelName);
  });
}
</script>

<h2>Top donors (lifetime, 4-cycle FEC union)</h2>
${donorsBlock}

<h2>Shared-donor peers in corpus</h2>
${peersBlock}

${outsideSpendingBlock}

${cosponsorBlock}

${patternsBlock}

<p style="margin-top: 32px;"><a class="row-link" href="../index.html">← back to corpus</a></p>
`;

  const html = layout(`CivicLens — ${m.name}`, `<a href="../index.html">Corpus</a> · ${esc(m.name)}`, body);
  writeFileSync(resolve(MEMBERS_DIR, `${m.member_id}.html`), html);
  console.log(`  ✓ site/members/${m.member_id}.html  (${donors.length}d ${trades.length}t ${collapsedTrades.length}p ${peers.length}peers)`);
}

// ─── Co-sponsorship network page ────────────────────────────────────────────

async function buildNetwork(): Promise<void> {
  const edges = await cosponsorNetwork();

  const nodeMap = new Map<string, { id: string; name: string; party: string | null }>();
  for (const e of edges) {
    if (!nodeMap.has(e.source_id)) nodeMap.set(e.source_id, { id: e.source_id, name: e.source_name, party: e.source_party });
    if (!nodeMap.has(e.target_id)) nodeMap.set(e.target_id, { id: e.target_id, name: e.target_name, party: e.target_party });
  }
  const nodes = [...nodeMap.values()];

  // Serialize to JSON — all string values from DB, safe for embedding in <script>
  const graphJson = JSON.stringify({ nodes, edges });

  // All client-side dynamic HTML is assembled via an esc() helper that
  // entity-encodes every interpolated value before it reaches innerHTML.
  // The data originates from the DB (already sanitized at ingest) and is
  // re-escaped here as a second-line defence.
  const clientScript = `
(function() {
  const GRAPH = ${graphJson};
  const partyColor = p => {
    if (!p) return '#9aa0a6';
    if (p.startsWith('D')) return '#5b9ed8';
    if (p.startsWith('R')) return '#d65a5a';
    if (p.startsWith('I')) return '#b88a3f';
    return '#9aa0a6';
  };

  function escHtml(s) {
    return String(s ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function renderEdgeTable(edges) {
    const rows = document.getElementById('edge-rows');
    const cells = edges.slice(0, 200).map(e => {
      const samples = e.bill_titles.slice(0, 3).map((t, i) => t || e.bill_ids[i]).filter(Boolean);
      return '<tr>'
        + '<td><a class="member" href="members/' + escHtml(e.source_id) + '.html">' + escHtml(e.source_name) + '</a></td>'
        + '<td><a class="member" href="members/' + escHtml(e.target_id) + '.html">' + escHtml(e.target_name) + '</a></td>'
        + '<td class="num">' + escHtml(e.shared_bills) + '</td>'
        + '<td class="dim" style="font-size:11px;">' + samples.map(s => escHtml(s.slice(0,60))).join('<br>') + '</td>'
        + '</tr>';
    });
    rows.textContent = '';
    rows.insertAdjacentHTML('beforeend', cells.join(''));
    document.getElementById('edge-count').textContent = '(' + edges.length + ')';
  }
  renderEdgeTable(GRAPH.edges);

  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js';
  script.onload = () => initGraph(GRAPH);
  document.head.appendChild(script);

  let selectedId = null;

  window.clearDetail = function() {
    selectedId = null;
    document.getElementById('detail').style.display = 'none';
    renderEdgeTable(GRAPH.edges);
    document.querySelectorAll('#graph circle').forEach(c => c.style.opacity = '1');
  };

  function showDetail(nodeId) {
    selectedId = nodeId;
    const node = GRAPH.nodes.find(n => n.id === nodeId);
    const myEdges = GRAPH.edges.filter(e => e.source_id === nodeId || e.target_id === nodeId);
    myEdges.sort((a, b) => b.shared_bills - a.shared_bills);

    document.getElementById('detail-name').textContent = node.name;
    document.getElementById('detail-sub').textContent = myEdges.length + ' co-sponsor connection' + (myEdges.length === 1 ? '' : 's') + ' in corpus';
    const tbody = document.getElementById('detail-rows');
    const rows = myEdges.map(e => {
      const partnerId   = e.source_id === nodeId ? e.target_id   : e.source_id;
      const partnerName = e.source_id === nodeId ? e.target_name : e.source_name;
      const samples = e.bill_titles.slice(0, 3).map((t, i) => t || e.bill_ids[i]).filter(Boolean);
      return '<tr>'
        + '<td><a class="member" href="members/' + escHtml(partnerId) + '.html">' + escHtml(partnerName) + '</a></td>'
        + '<td class="num">' + escHtml(e.shared_bills) + '</td>'
        + '<td class="dim" style="font-size:11px;">' + samples.map(s => escHtml(s.slice(0,70))).join('<br>') + '</td>'
        + '</tr>';
    });
    tbody.textContent = '';
    tbody.insertAdjacentHTML('beforeend', rows.join(''));
    document.getElementById('detail').style.display = '';
    renderEdgeTable(myEdges);
  }

  function initGraph(data) {
    const container = document.getElementById('graph');
    const W = container.clientWidth, H = container.clientHeight;
    const maxWeight = Math.max(...data.edges.map(e => e.shared_bills), 1);

    const svg = d3.select('#graph').append('svg')
      .attr('width', W).attr('height', H)
      .style('background', '#0e1014');

    const g = svg.append('g');
    svg.call(d3.zoom().scaleExtent([0.2, 8]).on('zoom', ev => g.attr('transform', ev.transform)));

    const link = g.append('g').selectAll('line')
      .data(data.edges)
      .join('line')
      .attr('stroke', '#2a2e35')
      .attr('stroke-width', d => Math.max(1, Math.sqrt(d.shared_bills / maxWeight) * 4))
      .attr('stroke-opacity', 0.7);

    const nodeGroup = g.append('g').selectAll('g')
      .data(data.nodes)
      .join('g')
      .attr('cursor', 'pointer')
      .call(d3.drag()
        .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag',  (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
        .on('end',   (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }))
      .on('click', (ev, d) => { ev.stopPropagation(); showDetail(d.id); });

    nodeGroup.append('circle')
      .attr('r', d => {
        const deg = data.edges.filter(e => e.source_id === d.id || e.target_id === d.id).length;
        return Math.max(5, Math.min(18, 4 + deg * 1.5));
      })
      .attr('fill', d => partyColor(d.party))
      .attr('fill-opacity', 0.85)
      .attr('stroke', '#0e1014')
      .attr('stroke-width', 1.5);

    nodeGroup.append('text')
      .attr('dy', '-10')
      .attr('text-anchor', 'middle')
      .attr('font-size', '10px')
      .attr('fill', '#9aa0a6')
      .attr('pointer-events', 'none')
      .text(d => d.name.split(' ').pop());

    const sim = d3.forceSimulation(data.nodes)
      .force('link', d3.forceLink(
        data.edges.map(e => ({ source: e.source_id, target: e.target_id, value: e.shared_bills }))
      ).id(d => d.id).distance(d => Math.max(40, 120 - d.value * 4)).strength(0.6))
      .force('charge', d3.forceManyBody().strength(-180))
      .force('center', d3.forceCenter(W / 2, H / 2))
      .force('collision', d3.forceCollide(22))
      .on('tick', () => {
        link
          .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
        nodeGroup.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
      });

    svg.on('click', () => { if (selectedId) clearDetail(); });
  }
})();
`;

  const graphSection = edges.length === 0
    ? '<div class="notice">No bills loaded yet. Run the pipeline with a researcher that fetches bills first.</div>'
    : `<div id="graph" style="width:100%;height:520px;border:1px solid var(--line);border-radius:4px;overflow:hidden;margin-bottom:24px;"></div>
<div id="detail" style="display:none;">
  <h2 id="detail-name" style="margin-bottom:8px;"></h2>
  <p class="lede" id="detail-sub" style="margin:0 0 12px;"></p>
  <table id="detail-table">
    <thead><tr><th>Partner</th><th class="num">Shared bills</th><th>Bills</th></tr></thead>
    <tbody id="detail-rows"></tbody>
  </table>
  <button onclick="clearDetail()" style="margin-top:12px;background:none;border:1px solid var(--line);color:var(--fg-dim);padding:4px 10px;border-radius:3px;cursor:pointer;font-size:12px;">Clear selection</button>
</div>
<h2>All edges <span id="edge-count" class="muted" style="font-weight:400;font-size:13px;">(${esc(edges.length)})</span></h2>
<table>
  <thead><tr><th>Member A</th><th>Member B</th><th class="num">Shared bills</th><th>Sample bills</th></tr></thead>
  <tbody id="edge-rows"></tbody>
</table>
<script>${clientScript}<\/script>`;

  const body = `
<h2>Co-sponsorship network</h2>
<p class="lede">Each node is a member in the corpus. An edge means they both appear on the same bill (as sponsor or co-sponsor). Edge weight = number of shared bills. Drag to reposition; scroll to zoom. Click a node to filter the table below.</p>
${graphSection}
<p style="margin-top: 32px;"><a class="row-link" href="index.html">← back to corpus</a></p>
`;

  const html = layout('CivicLens — Co-sponsorship Network', `<a href="index.html">Corpus</a> · Co-sponsorship network`, body);
  writeFileSync(resolve(OUT_DIR, 'network.html'), html);
  console.log(`  ✓ site/network.html  (${nodes.length} nodes, ${edges.length} edges)`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function buildAll(): Promise<void> {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  if (!existsSync(MEMBERS_DIR)) mkdirSync(MEMBERS_DIR, { recursive: true });

  console.log('Building CivicLens site…\n');
  await buildIndex();
  await buildNetwork();
  const overview = await fetchOverview();
  for (const m of overview) {
    const detail = await fetchMember(m.member_id);
    if (detail) await buildMemberPage(detail);
  }
  console.log(`\nDone. Output at ${OUT_DIR}/index.html`);
  const summary = await memberTradeSummary();
  if (summary.length > 0) {
    console.log(`\nTrade-loaded members: ${summary.map(s => `${s.name}(${s.total_trades})`).join(', ')}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildAll().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
