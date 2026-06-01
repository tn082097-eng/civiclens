/**
 * One-off loader: walks pipeline task dirs, takes the latest approved
 * researcher.json per member, populates the DuckDB schema.
 *
 * Idempotent — re-running upserts. Connection-mapper.json is intentionally
 * NOT loaded (the new world derives shared donors from a SQL view).
 *
 * Usage:
 *   npx tsx db/load-from-tasks.ts            # load all latest-approved
 *   npx tsx db/load-from-tasks.ts --reset    # truncate then load
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { applySchema, getDb } from './init.js';
import { committeeCanonical } from './load-bill-committees.js';
import { PIPE_DIR } from '../lib/paths.js';

interface TaskPick {
  taskId: string;
  taskDir: string;
  memberName: string;
  updatedAt: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function findLatestApproved(): TaskPick[] {
  const taskDirs = readdirSync(PIPE_DIR).filter(d => d.startsWith('task-'));
  const byMember = new Map<string, TaskPick>();
  for (const t of taskDirs) {
    const dir = resolve(PIPE_DIR, t);
    const stateFile = resolve(dir, 'state.json');
    const finalFile = resolve(dir, 'final-review.json');
    if (!existsSync(stateFile) || !existsSync(finalFile)) continue;
    let state: any, final: any;
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      final = JSON.parse(readFileSync(finalFile, 'utf-8'));
    } catch { continue; }
    if (!final.readyToApply) continue;
    const name = state?.target?.name;
    if (!name) continue;
    const updatedAt = new Date(state.updatedAt ?? 0).getTime();
    const prev = byMember.get(name);
    if (!prev || updatedAt > prev.updatedAt) {
      byMember.set(name, { taskId: t, taskDir: dir, memberName: name, updatedAt });
    }
  }
  return [...byMember.values()];
}

// Mirrors normalizeDonorName() in agents/pipeline.ts — keep these in lockstep
// or shared-donor matches will diverge between the JS mapper and SQL.
export function canonicalDonor(raw: string): string {
  return (raw ?? '')
    .toUpperCase()
    .replace(/\b(JR|SR|II|III|IV|ESQ|PHD|MD)\b\.?/g, '')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function voteIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  // https://www.govtrack.us/congress/votes/119-2026/h137  ->  119-2026/h137
  const m = url.match(/\/votes\/([^/]+\/\w+)/);
  return m?.[1] ?? null;
}

function billIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  // https://www.congress.gov/bill/119th-congress/house-bill/4  ->  119/hr/4
  const m = url.match(/\/bill\/(\d+)\w+-congress\/([^/]+)\/(\d+)/);
  if (!m) return null;
  const chamberPrefix = m[2].startsWith('house') ? 'hr' : m[2].startsWith('senate') ? 's' : m[2];
  return `${m[1]}/${chamberPrefix}/${m[3]}`;
}

function asDate(s: string | undefined | null): string | null {
  if (!s) return null;
  // accept YYYY-MM-DD or YYYY-MM-DDTHH:...
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m?.[1] ?? null;
}

function asInt(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

// ─── Loaders per table ──────────────────────────────────────────────────────

export async function loadOne(pick: TaskPick): Promise<{ donors: number; votes: number; bills: number; committees: number; controversies: number }> {
  const conn = await getDb();
  const researcherPath = resolve(pick.taskDir, 'researcher.json');
  if (!existsSync(researcherPath)) return { donors: 0, votes: 0, bills: 0, committees: 0, controversies: 0 };
  const r = JSON.parse(readFileSync(researcherPath, 'utf-8'));
  const d = r.data ?? {};
  const memberId = d.id;
  if (!memberId) return { donors: 0, votes: 0, bills: 0, committees: 0, controversies: 0 };

  const fetchedAt = r.fetchedAt ?? new Date().toISOString();
  const bioSummary = typeof d.bio === 'string' ? d.bio : (d.bio?.summary ?? null);
  const bioSourceUrl = typeof d.bio === 'object' ? (d.bio?.sourceUrl ?? null) : null;

  // members
  await conn.run(
    `INSERT OR REPLACE INTO members
     (member_id, name, party, chamber, state, district, role, in_office,
      first_elected_year, bioguide_id, fec_candidate_id, bio_summary, bio_source_url, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      memberId, d.name, d.party ?? null, d.chamber ?? null, d.state ?? null,
      d.district ?? null, d.role ?? null, d.inOffice ?? null,
      asInt(d.firstElectedYear), d.bioguideId ?? null, d.fecCandidateId ?? null,
      bioSummary, bioSourceUrl, fetchedAt,
    ]
  );

  // donors — clear existing rows for this member (cumulative semantics: latest fetch wins)
  await conn.run(`DELETE FROM donors WHERE member_id = ?`, [memberId]);
  let donorCount = 0;
  for (const dn of d.donors ?? []) {
    if (!dn?.name) continue;
    const canonical = canonicalDonor(dn.name);
    if (!canonical) continue;
    await conn.run(
      `INSERT OR REPLACE INTO donors
       (member_id, donor_name, donor_canonical, donor_type, amount, latest_date,
        cycles, source, source_url, confidence, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        memberId, dn.name, canonical, dn.type ?? null,
        Number(dn.amount ?? 0), asDate(dn.date),
        null, // cycles array not yet propagated from researcher
        dn.source ?? null, dn.sourceUrl ?? null,
        Number.isFinite(dn.confidence) ? dn.confidence : null,
        fetchedAt,
      ]
    );
    donorCount++;
  }

  // votes
  await conn.run(`DELETE FROM votes WHERE member_id = ?`, [memberId]);
  let voteCount = 0;
  for (const v of d.votes ?? []) {
    const voteId = voteIdFromUrl(v.sourceUrl);
    if (!voteId) continue;
    await conn.run(
      `INSERT OR REPLACE INTO votes
       (member_id, vote_id, date, question, position, category, party_position, bill_number, source_url, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        memberId, voteId, asDate(v.date), v.billTitle ?? v.question ?? null,
        v.vote ?? v.position ?? null, v.category ?? null, v.partyPosition ?? null,
        v.billNumber ?? null, v.sourceUrl ?? null, fetchedAt,
      ]
    );
    voteCount++;
  }

  // bills
  await conn.run(`DELETE FROM bills WHERE member_id = ?`, [memberId]);
  let billCount = 0;
  for (const b of d.bills ?? []) {
    const billId = billIdFromUrl(b.sourceUrl) ?? b.billId ?? null;
    if (!billId) continue;
    await conn.run(
      `INSERT OR REPLACE INTO bills
       (member_id, bill_id, title, status, sponsor_role, introduced_at, source_url, fetched_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        memberId, billId, b.title ?? b.billTitle ?? null, b.status ?? null,
        b.sponsorRole ?? null, asDate(b.introducedAt), b.sourceUrl ?? null, fetchedAt,
      ]
    );
    billCount++;
  }

  // committees
  await conn.run(`DELETE FROM committees WHERE member_id = ?`, [memberId]);
  let committeeCount = 0;
  for (const c of d.committees ?? []) {
    if (!c?.name) continue;
    await conn.run(
      `INSERT OR REPLACE INTO committees
       (member_id, committee_name, committee_canonical, role, source_url, fetched_at)
       VALUES (?,?,?,?,?,?)`,
      [memberId, c.name, committeeCanonical(c.name), c.role ?? null, c.sourceUrl ?? null, fetchedAt]
    );
    committeeCount++;
  }

  // controversies
  await conn.run(`DELETE FROM controversies WHERE member_id = ?`, [memberId]);
  let contCount = 0;
  for (const co of d.controversies ?? []) {
    if (!co?.topic && !co?.title) continue;
    const topic = co.topic ?? co.title;
    await conn.run(
      `INSERT OR REPLACE INTO controversies
       (member_id, topic, summary, date, source, source_url, fetched_at)
       VALUES (?,?,?,?,?,?,?)`,
      [memberId, topic, co.summary ?? null, asDate(co.date), co.source ?? null, co.sourceUrl ?? null, fetchedAt]
    );
    contCount++;
  }

  // pipeline_runs
  let final: any = null;
  try { final = JSON.parse(readFileSync(resolve(pick.taskDir, 'final-review.json'), 'utf-8')); } catch {}
  let summary: string | null = null;
  try {
    const s = JSON.parse(readFileSync(resolve(pick.taskDir, 'summarizer.json'), 'utf-8'));
    summary = s.summary ?? s.text ?? null;
  } catch {}
  await conn.run(
    `INSERT OR REPLACE INTO pipeline_runs
     (task_id, member_id, started_at, finished_at, approved, reviewer_decision, reviewer_notes, summary_text, report_html_path, errors)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      pick.taskId, memberId, new Date(pick.updatedAt).toISOString(),
      new Date(pick.updatedAt).toISOString(),
      final?.readyToApply ?? null, final?.decision ?? null,
      typeof final?.notes === 'string' ? final.notes : (final?.notes ? JSON.stringify(final.notes) : null),
      summary, null, null,
    ]
  );

  // trade_activity — from trade-analyst.json if present
  try {
    const taPath = resolve(pick.taskDir, 'trade-analyst.json');
    if (existsSync(taPath)) {
      const ta = JSON.parse(readFileSync(taPath, 'utf-8'));
      const narrative: string | null = ta?.tradeNarrative ?? null;
      if (narrative && narrative !== 'N/A') {
        await conn.run(
          `UPDATE members SET trade_activity = ? WHERE member_id = ?`,
          [narrative, memberId],
        );
      }
    }
  } catch { /* non-fatal */ }

  // predictions
  try {
    const p = JSON.parse(readFileSync(resolve(pick.taskDir, 'predictor.json'), 'utf-8'));
    const models = p.models ?? p.results ?? [];
    if (Array.isArray(models)) {
      await conn.run(`DELETE FROM predictions WHERE task_id = ?`, [pick.taskId]);
      for (const m of models) {
        await conn.run(
          `INSERT OR REPLACE INTO predictions
           (task_id, member_id, model, brier_score, log_loss, accuracy, train_count, test_count, best_model, run_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            pick.taskId, memberId, m.name ?? m.model ?? 'unknown',
            m.brier ?? m.brierScore ?? null,
            m.logLoss ?? null, m.accuracy ?? null,
            m.trainCount ?? p.trainCount ?? null, m.testCount ?? p.testCount ?? null,
            !!m.best, new Date(pick.updatedAt).toISOString(),
          ]
        );
      }
    }
  } catch {}

  return { donors: donorCount, votes: voteCount, bills: billCount, committees: committeeCount, controversies: contCount };
}

// ─── Reset (optional) ───────────────────────────────────────────────────────

async function reset(): Promise<void> {
  const conn = await getDb();
  for (const t of ['donors','votes','bills','committees','controversies','pfd_transactions','pipeline_runs','predictions','members']) {
    await conn.run(`DELETE FROM ${t}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  await applySchema();
  if (process.argv.includes('--reset')) {
    await reset();
    console.log('reset: all tables truncated');
  }
  const picks = findLatestApproved();
  console.log(`found ${picks.length} approved task(s)`);
  let totals = { members: 0, donors: 0, votes: 0, bills: 0, committees: 0, controversies: 0 };
  for (const p of picks) {
    const c = await loadOne(p);
    totals.members++;
    totals.donors += c.donors;
    totals.votes += c.votes;
    totals.bills += c.bills;
    totals.committees += c.committees;
    totals.controversies += c.controversies;
    console.log(`  ✓ ${p.memberName.padEnd(26)} donors=${c.donors} votes=${c.votes} bills=${c.bills} cmtes=${c.committees}`);
  }
  console.log(`\nloaded: ${totals.members} members, ${totals.donors} donors, ${totals.votes} votes, ${totals.bills} bills, ${totals.committees} committees`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
