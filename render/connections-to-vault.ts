#!/usr/bin/env -S npx tsx
/**
 * Regenerate Obsidian member notes from DETERMINISTIC sources only:
 *   1. findSharedDonors() SQL  → shared-donor network EDGES (wikilinks)
 *   2. civiclens.duckdb        → per-member FACTS
 *      (bio, donors, super-PAC IE, voting record, PFD trades, pattern hits)
 *
 * No longer reads connection-mapper.json. The agent's LLM-narrated
 * direct/hidden/indirect edges were inferred, not sourced — they violated the
 * truth-over-narrative / no-fabrication rule. Shared-donor edges are now
 * computed straight from filings via db/queries/shared-donors.sql, the same
 * deterministic query the public site renders (findSharedDonors).
 *
 * Output : ~/NoService/Projects/CivicLens/Connections/<member-id>.md
 * Also   : ~/NoService/Projects/CivicLens/Members/<Display Name>.md (graph stub)
 *
 * Sanders dedup: bernard-sanders folds into bernie-sanders (same bioguide S000033).
 * Run: npx tsx render/connections-to-vault.ts
 */
import { getDb } from '../db/init.js';
import { findSharedDonors, listMembers, type SharedDonorPeer } from '../db/queries.js';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HOME = process.env.HOME!;
const VAULT = resolve(HOME, 'NoService/Projects/CivicLens');
const CONN_DIR = join(VAULT, 'Connections');
const MEM_DIR = join(VAULT, 'Members');

const ALIAS_ID: Record<string, string> = { 'bernard-sanders': 'bernie-sanders' };
const ALIAS_NAME: Record<string, string> = { 'Bernard Sanders': 'Bernie Sanders' };
const canonId = (i: string) => ALIAS_ID[i] ?? i;
const canonName = (n: string) => ALIAS_NAME[n] ?? n;

const fmtUsd = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
const num = (v: any) => Number(v);

async function dbFacts(conn: any, memberId: string): Promise<string[]> {
  const q = async (sql: string) => { const r = await conn.run(sql); return (await r.getRowObjects()) as any[]; };
  const esc = (s: string) => s.replace(/'/g, "''");
  const id = esc(memberId);

  const member = (await q(`SELECT * FROM members WHERE member_id='${id}'`))[0];
  const L: string[] = [];
  if (!member) { return ['> _No DuckDB row for this member — facts unavailable._', '']; }

  const donors = await q(`SELECT donor_name, donor_type, amount FROM donors WHERE member_id='${id}' ORDER BY amount DESC LIMIT 10`);
  const ie = await q(`SELECT support_oppose, committee_name, total_amount, cycle FROM super_pac_ie WHERE member_id='${id}' ORDER BY total_amount DESC LIMIT 10`);
  const voteBreakdown = await q(`SELECT position, count(*) n FROM votes WHERE member_id='${id}' GROUP BY position ORDER BY n DESC`);
  const brokeParty = await q(`SELECT date, question, position, party_position FROM votes
    WHERE member_id='${id}' AND party_position IS NOT NULL AND position IS NOT NULL
      AND lower(position) != lower(party_position)
      AND lower(position) IN ('yea','nay') AND lower(party_position) IN ('yea','nay')
    ORDER BY date DESC LIMIT 8`);
  const trades = await q(`SELECT tx_date, tx_type, asset, ticker, amount_band, holder FROM pfd_transactions
    WHERE member_id='${id}' ORDER BY tx_date DESC LIMIT 20`);
  const hits = await q(`SELECT pattern, finding, intensity, null_model, observed, expected, p_value
    FROM pattern_hits WHERE member='${id}' ORDER BY z_score DESC NULLS LAST, intensity DESC`);

  if (member.bio_summary) { L.push(member.bio_summary as string); L.push(''); }

  L.push('## Money in — top donors', '');
  if (donors.length) for (const d of donors) L.push(`- ${fmtUsd(num(d.amount))} — ${d.donor_name} _(${d.donor_type ?? '?'})_`);
  else L.push('- _(none on file)_');
  L.push('');

  L.push('## Outside spending — super-PAC IE', '');
  if (ie.length) for (const r of ie) L.push(`- ${r.support_oppose === 'S' ? 'SUPPORTING' : 'OPPOSING'} — ${r.committee_name ?? '?'} · ${fmtUsd(num(r.total_amount))} (${num(r.cycle)})`);
  else L.push('- _(none on file)_');
  L.push('');

  L.push('## Voting record', '');
  if (voteBreakdown.length) {
    L.push('Position breakdown: ' + voteBreakdown.map(v => `${v.position} ${num(v.n)}`).join(' · '));
    if (brokeParty.length) {
      L.push('', '**Broke with party line:**');
      for (const v of brokeParty) L.push(`- ${v.date} — voted **${v.position}** (party: ${v.party_position}) — ${v.question}`);
    }
  } else L.push('- _(no votes loaded)_');
  L.push('');

  L.push('## Stock trades — PFD', '');
  if (trades.length) for (const t of trades) L.push(`- ${t.tx_date} — **${t.tx_type}** ${t.asset ?? ''}${t.ticker ? ` (${t.ticker})` : ''} · ${t.amount_band ?? ''} · _${t.holder}_`);
  else L.push('- _(none disclosed)_');
  L.push('');

  L.push('## Pattern hits', '');
  if (hits.length) for (const h of hits) {
    L.push(`- **${h.pattern}** (intensity ${num(h.intensity).toFixed(2)}) — ${h.finding}`);
    if (h.null_model != null) {
      const verdict = num(h.p_value) <= 0.05 ? 'Exceeds chance' : 'Consistent with chance';
      L.push(`  - _Rigor:_ **${verdict}** — observed ${num(h.observed)} vs expected ${num(h.expected).toFixed(2)} (${h.null_model} null, p=${num(h.p_value).toFixed(3)})`);
    }
  }
  else L.push('- _(no detector fired)_');
  L.push('');

  return L;
}

/** Deterministic shared-donor edges (wikilinks), in the SQL's own ranked order. */
function sharedDonorSection(peers: SharedDonorPeer[]): { lines: string[]; peerNames: Map<string, string> } {
  const peerNames = new Map<string, string>();
  const L: string[] = ['## Shared-donor connections', ''];
  if (!peers.length) {
    L.push('- _(no shared donors with other tracked members)_', '');
    return { lines: L, peerNames };
  }
  for (const p of peers) {
    const pid = canonId(p.peer_id);
    const pname = canonName(p.peer_name);
    peerNames.set(pname, pid);
    const donors = p.donor_canonicals.slice(0, 5).join(', ');
    L.push(
      `- [[${pid}]] — **${p.shared_count}** shared donor${p.shared_count === 1 ? '' : 's'}` +
      `, ${fmtUsd(p.combined_amount)} combined` +
      (donors ? ` · ${donors}` : '')
    );
  }
  L.push('');
  return { lines: L, peerNames };
}

function memberStub(name: string, memberId: string): string {
  return [
    '---', `name: ${name}`, `member_id: ${memberId}`, 'tags: [civiclens, member]', '---', '',
    `# ${name}`, '', `Member of Congress tracked by [[CivicLens]].`, '',
    `- Profile: [[${memberId}|${name}]]`, '', '## Backlinks', '',
    'Connections, shared donors, votes, and trades surface in the Obsidian backlinks pane and graph view.', '',
  ].join('\n');
}

async function main() {
  mkdirSync(CONN_DIR, { recursive: true });
  mkdirSync(MEM_DIR, { recursive: true });
  const conn = await getDb();

  const stale = join(CONN_DIR, 'bernard-sanders.md');
  if (existsSync(stale)) rmSync(stale);

  const today = new Date().toISOString().slice(0, 10);
  const allNames = new Map<string, string | null>();  // display name -> member_id
  const seen = new Set<string>();
  let connCount = 0;

  for (const m of await listMembers()) {
    const mid = canonId(m.member_id);
    if (seen.has(mid)) continue;          // fold the Sanders alias
    seen.add(mid);
    const name = canonName(m.name);

    const peers = await findSharedDonors(mid);
    const { lines: edgeLines, peerNames } = sharedDonorSection(peers);
    const facts = await dbFacts(conn, mid);

    const header = [
      '---', `member: ${name}`, `member_id: ${mid}`,
      `generated_at: ${today}`, `shared_donor_peers: ${peers.length}`,
      'tags: [civiclens, member, db-backed]', '---', '',
      `# ${name}`, '', `Profile for [[${name}]] · ID \`${mid}\` · Hub: [[CivicLens]]`, '',
    ];
    const body = [...header, ...facts, ...edgeLines].join('\n') + '\n';
    writeFileSync(join(CONN_DIR, `${mid}.md`), body);
    connCount++;

    allNames.set(name, mid);
    for (const [pn, pid] of peerNames) if (!allNames.has(pn)) allNames.set(pn, pid);
  }

  let memCount = 0;
  for (const [name, mid] of allNames) {
    if (!mid) continue;
    writeFileSync(join(MEM_DIR, `${name}.md`), memberStub(name, mid));
    memCount++;
  }

  console.log(`connections: ${connCount} notes -> ${CONN_DIR}`);
  console.log(`members:     ${memCount} notes -> ${MEM_DIR}`);
  console.log(`generated:   ${today}`);
  process.exit(0);
}

main();
