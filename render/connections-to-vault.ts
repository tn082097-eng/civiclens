#!/usr/bin/env -S npx tsx
/**
 * Regenerate Obsidian member notes by MERGING two sources:
 *   1. connection-mapper.json (latest per member)  → network EDGES (wikilinks)
 *   2. civiclens.duckdb                              → per-member FACTS
 *      (bio, donors, super-PAC IE, voting record, PFD trades, pattern hits)
 *
 * Supersedes render/connections-to-vault.py, which only rendered #1.
 *
 * Source : ~/.hermes/civiclens/pipeline/task-* /connection-mapper.json (newest per member)
 * Output : ~/NoService/Projects/CivicLens/Connections/<member-id>.md
 * Also   : ~/NoService/Projects/CivicLens/Members/<Display Name>.md (graph stub)
 *
 * Sanders dedup: bernard-sanders folds into bernie-sanders (same bioguide S000033).
 * Run: npx tsx render/connections-to-vault.ts
 */
import { getDb } from '../db/init.ts';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HOME = process.env.HOME!;
const PIPELINE = resolve(HOME, '.hermes/civiclens/pipeline');
const VAULT = resolve(HOME, 'NoService/Projects/CivicLens');
const CONN_DIR = join(VAULT, 'Connections');
const MEM_DIR = join(VAULT, 'Members');

const ALIAS_ID: Record<string, string> = { 'bernard-sanders': 'bernie-sanders' };
const ALIAS_NAME: Record<string, string> = { 'Bernard Sanders': 'Bernie Sanders' };
const canonId = (i: string) => ALIAS_ID[i] ?? i;
const canonName = (n: string) => ALIAS_NAME[n] ?? n;

const fmtUsd = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
const num = (v: any) => Number(v);

type CM = any;

/** Newest connection-mapper.json per member (dirs walked newest-first, first hit wins). */
function latestPerMember(): Map<string, CM> {
  const best = new Map<string, CM>();
  const dirs = readdirSync(PIPELINE)
    .map(d => join(PIPELINE, d))
    .filter(d => { try { return statSync(d).isDirectory(); } catch { return false; } })
    .map(d => ({ d, m: statSync(d).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  for (const { d } of dirs) {
    const cm = join(d, 'connection-mapper.json');
    if (!existsSync(cm)) continue;
    let data: CM;
    try { data = JSON.parse(readFileSync(cm, 'utf-8')); } catch { continue; }
    const sid = canonId(data.subjectId ?? '');
    if (!sid || best.has(sid)) continue;
    best.set(sid, data);
  }
  return best;
}

function fmtLinks(items: any[], kind: 'direct' | 'hidden' | 'indirect'): string[] {
  const out: string[] = [];
  for (const x of items ?? []) {
    const name = canonName(x.toName ?? x.to ?? '?');
    const s = typeof x.strength === 'number' ? ` (${x.strength.toFixed(2)})` : '';
    if (kind === 'hidden') out.push(`- [[${name}]]${s} — via **${x.via ?? ''}**. ${x.evidence ?? ''}`);
    else if (kind === 'indirect') out.push(`- [[${name}]]${s} — *${x.linkType ?? ''}* via ${x.via ?? ''}`);
    else out.push(`- [[${name}]]${s} — ${x.evidence ?? ''}`);
  }
  return out.length ? out : ['- _(none)_'];
}

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

function networkSection(memberId: string, data: CM): { lines: string[]; name: string; comp: string[] } {
  const name = canonName(data.subjectName ?? memberId);
  const compared: any[] = data.comparedAgainst ?? [];
  const seen = new Set<string>();
  const comp: string[] = [];
  for (const c of compared) {
    const cid = canonId(c.id ?? '');
    if (cid && cid !== memberId && !seen.has(cid)) { seen.add(cid); comp.push(canonName(c.name ?? cid)); }
  }

  const L: string[] = [];
  if (data.networkSummary) L.push('## Network summary', '', data.networkSummary as string, '');
  L.push('## Direct links', '', ...fmtLinks(data.directLinks, 'direct'), '');
  L.push('## Hidden connections', '', ...fmtLinks(data.hiddenConnections, 'hidden'), '');
  L.push('## Indirect links', '', ...fmtLinks(data.indirectLinks, 'indirect'), '');

  L.push('## Shared donors', '');
  const sd: any[] = data.sharedDonors ?? [];
  if (sd.length) for (const d of sd) {
    // sharedWith holds member IDs, not display names → canonId folds the Sanders alias.
    const who = (d.sharedWith ?? []).map((w: string) => `[[${canonId(w)}]]`).join(', ');
    const url = d.sourceUrl ?? '';
    L.push(`- **${d.donorName ?? '?'}** — shared with: ${who}` + (url ? ` ([source](${url}))` : ''));
  } else L.push('- _(none)_');
  L.push('');

  L.push('## Compared against', '', ...comp.slice().sort().map(n => `- [[${n}]]`), '');
  return { lines: L, name, comp };
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
  const best = latestPerMember();

  const stale = join(CONN_DIR, 'bernard-sanders.md');
  if (existsSync(stale)) rmSync(stale);

  const allNames = new Map<string, string | null>();
  for (const [mid, data] of best) {
    const net = networkSection(mid, data);
    const facts = await dbFacts(conn, mid);
    const header = [
      '---', `member: ${net.name}`, `member_id: ${mid}`,
      `analyzed_at: ${data.analyzedAt ?? ''}`, `corpus_size: ${net.comp.length}`,
      'tags: [civiclens, member, db-backed]', '---', '',
      `# ${net.name}`, '', `Profile for [[${net.name}]] · ID \`${mid}\` · Hub: [[CivicLens]]`, '',
    ];
    const body = [...header, ...facts, ...net.lines].join('\n') + '\n';
    writeFileSync(join(CONN_DIR, `${mid}.md`), body);
    allNames.set(net.name, mid);
    for (const cn of net.comp) if (!allNames.has(cn)) allNames.set(cn, null);
  }

  let memCount = 0;
  for (const [name, mid] of allNames) {
    if (!mid) continue;
    writeFileSync(join(MEM_DIR, `${name}.md`), memberStub(name, mid));
    memCount++;
  }

  console.log(`connections: ${best.size} notes -> ${CONN_DIR}`);
  console.log(`members:     ${memCount} notes -> ${MEM_DIR}`);
  console.log(`generated:   ${new Date().toISOString().slice(0, 10)}`);
  process.exit(0);
}

main();
