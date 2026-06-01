/**
 * Sync a single pipeline task into the DuckDB corpus.
 *
 * Called from agents/pipeline.ts immediately after the Researcher
 * (and again after Final Reviewer, to update approved + summary fields).
 * The agent JSON files remain the source of truth for the run; the DB is
 * the source of truth for cross-corpus queries.
 */

import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { applySchema, getDb } from './init.js';
import { loadOne } from './load-from-tasks.js';
import { resolveFecCandidateId } from './backfill-fec-candidate.js';
import { PIPE_DIR } from '../lib/paths.js';

export interface SyncResult {
  ok: boolean;
  reason?: string;
  fecResolved?: 'filled' | 'already-set' | 'unresolved' | 'error';
  fecReason?: string;
}

export async function syncTask(taskId: string): Promise<SyncResult> {
  await applySchema();
  const dir = resolve(PIPE_DIR, taskId);
  const stateFile = resolve(dir, 'state.json');
  if (!existsSync(stateFile)) return { ok: false, reason: 'no state.json' };
  let state: any;
  try { state = JSON.parse(readFileSync(stateFile, 'utf-8')); } catch (e: any) {
    return { ok: false, reason: `state parse: ${e.message}` };
  }
  const memberName = state?.target?.name;
  if (!memberName) return { ok: false, reason: 'no target name' };
  const updatedAt = new Date(state.updatedAt ?? Date.now()).getTime();
  await loadOne({ taskId, taskDir: dir, memberName, updatedAt });

  // Backfill members.fec_candidate_id if the researcher didn't carry it.
  // Required by lib/fec-ie.ts (outside-spending section). Returns status so
  // the pipeline runner can surface unresolved IDs at end-of-run.
  let fecResolved: SyncResult['fecResolved'];
  let fecReason: string | undefined;
  try {
    const conn = await getDb();
    const r = await conn.run(`SELECT member_id, fec_candidate_id FROM members WHERE name = ? LIMIT 1`, [memberName]);
    const rows = await r.getRowObjects() as any[];
    if (rows.length > 0) {
      if (rows[0].fec_candidate_id) {
        fecResolved = 'already-set';
      } else {
        const result = await resolveFecCandidateId(String(rows[0].member_id));
        if (result.filled) {
          fecResolved = 'filled';
        } else {
          fecResolved = 'unresolved';
          fecReason = result.reason;
        }
      }
    }
  } catch (e: any) {
    fecResolved = 'error';
    fecReason = e?.message ?? String(e);
  }

  return { ok: true, fecResolved, fecReason };
}

/**
 * Returns the latest fetched-at researcher snapshot per member, excluding the
 * caller's own member_id (or task). Drop-in replacement for
 * loadOtherResearchers() in agents/pipeline.ts — same shape, but sourced from
 * the DB instead of scanning task dirs.
 */
export interface CorpusEntry {
  taskId: string;
  data: any;
  mtime: number;
}

export async function loadCorpus(excludeMemberId?: string): Promise<CorpusEntry[]> {
  const conn = await getDb();
  const r = await conn.run(`
    SELECT m.member_id, m.name, m.party, m.chamber, m.state, m.district, m.role,
           m.in_office, m.first_elected_year, m.bioguide_id, m.fec_candidate_id,
           m.bio_summary, m.fetched_at,
           (SELECT MAX(p.task_id) FROM pipeline_runs p WHERE p.member_id = m.member_id AND p.approved) AS task_id
    FROM members m
    WHERE m.member_id <> COALESCE(?, '')
  `, [excludeMemberId ?? null]);
  const memberRows = await r.getRowObjects() as any[];
  const out: CorpusEntry[] = [];
  for (const row of memberRows) {
    const memberId = String(row.member_id);
    // Pull related arrays in parallel.
    const [donorsR, votesR, billsR, committeesR] = await Promise.all([
      conn.run(`SELECT donor_name AS name, donor_type AS type, amount, latest_date AS date,
                       source, source_url AS sourceUrl, confidence
                FROM donors WHERE member_id = ?`, [memberId]),
      conn.run(`SELECT question AS billTitle, position AS vote, date,
                       source_url AS sourceUrl, category
                FROM votes WHERE member_id = ?`, [memberId]),
      conn.run(`SELECT title, status, introduced_at AS introducedAt,
                       source_url AS sourceUrl
                FROM bills WHERE member_id = ?`, [memberId]),
      conn.run(`SELECT committee_name AS name, role, source_url AS sourceUrl
                FROM committees WHERE member_id = ?`, [memberId]),
    ]);
    const data = {
      id:        memberId,
      name:      row.name,
      party:     row.party,
      chamber:   row.chamber,
      state:     row.state,
      district:  row.district,
      role:      row.role,
      inOffice:  row.in_office,
      firstElectedYear: row.first_elected_year,
      bioguideId: row.bioguide_id,
      fecCandidateId: row.fec_candidate_id,
      bio:       row.bio_summary,
      donors:     await donorsR.getRowObjects(),
      votes:      await votesR.getRowObjects(),
      bills:      await billsR.getRowObjects(),
      committees: await committeesR.getRowObjects(),
    };
    out.push({
      taskId: row.task_id ? String(row.task_id) : 'db',
      data,
      mtime: new Date(row.fetched_at).getTime(),
    });
  }
  return out;
}

// CLI smoke
if (import.meta.url === `file://${process.argv[1]}`) {
  const taskId = process.argv[2];
  if (taskId === '--corpus') {
    loadCorpus(process.argv[3]).then(c => {
      console.log(`corpus: ${c.length} member(s)`);
      for (const e of c) {
        console.log(`  ${e.data.id.padEnd(28)} donors=${e.data.donors.length} votes=${e.data.votes.length}`);
      }
      process.exit(0);
    }).catch(e => { console.error(e); process.exit(1); });
  } else if (taskId) {
    syncTask(taskId).then(r => {
      console.log(JSON.stringify(r));
      process.exit(r.ok ? 0 : 1);
    });
  } else {
    console.error('Usage: sync-task.ts <task-id>   |   sync-task.ts --corpus [excludeId]');
    process.exit(1);
  }
}
