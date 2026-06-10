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

// CLI smoke
if (import.meta.url === `file://${process.argv[1]}`) {
  const taskId = process.argv[2];
  if (taskId) {
    syncTask(taskId).then(r => {
      console.log(JSON.stringify(r));
      process.exit(r.ok ? 0 : 1);
    });
  } else {
    console.error('Usage: sync-task.ts <task-id>');
    process.exit(1);
  }
}
