import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { DB_PATH, PIPE_DIR, ROOT } from '../lib/paths.js';
import { loadThemeGapsOrSentinel } from '../render/load-artifacts.js';
import type { PublishedManifest } from '../render/landing.js';
import { validateCorpus } from './validate-artifact-corpus.js';

interface ApprovedRun {
  member_id: string;
  bioguide_id: string | null;
  in_office: boolean | null;
  task_id: string;
  reviewer_decision: string;
}

async function main(): Promise<void> {
  const roster = process.argv.slice(2);
  if (roster.length === 0 || new Set(roster).size !== roster.length ||
      roster.some(slug => !/^[a-z][a-z0-9-]*$/.test(slug))) {
    throw new Error('Provide a nonempty release roster of unique member slugs');
  }
  const manifest: PublishedManifest = JSON.parse(readFileSync(join(ROOT, 'render', 'published-members.json'), 'utf8'));
  const manifestSlugs = manifest.members.map(member => member.slug).sort();
  if (JSON.stringify([...roster].sort()) !== JSON.stringify(manifestSlugs)) {
    throw new Error('Release roster must match render/published-members.json');
  }
  if (!existsSync(DB_PATH) || existsSync(DB_PATH + '.wal')) {
    throw new Error('Release check requires a complete DuckDB snapshot without a pending WAL');
  }

  const db = await DuckDBInstance.create(DB_PATH, { access_mode: 'READ_ONLY' });
  const conn = await db.connect();
  try {
    const query = await conn.run(`
      SELECT m.member_id, m.bioguide_id, m.in_office, r.task_id, r.reviewer_decision
      FROM members m JOIN pipeline_runs r USING (member_id)
      WHERE r.approved IS TRUE AND m.member_id IN (${roster.map(() => '?').join(', ')})
      QUALIFY row_number() OVER (
        PARTITION BY m.member_id ORDER BY r.finished_at DESC NULLS LAST, r.task_id DESC
      ) = 1
      ORDER BY m.member_id
    `, roster);
    const runs = await query.getRowObjects() as unknown as ApprovedRun[];
    for (const slug of roster) {
      const run = runs.find(row => row.member_id === slug);
      if (!run || !['approved', 'approved_with_warnings'].includes(run.reviewer_decision)) {
        throw new Error(`No approved run recorded in the release snapshot for ${slug}`);
      }
      if (!run.in_office || !/^[A-Z]\d{6}$/.test(run.bioguide_id ?? '')) {
        throw new Error(`Missing sitting member identity in release snapshot for ${slug}`);
      }
      const artifact = loadThemeGapsOrSentinel(slug);
      if (artifact.memberId !== slug || !['ranked', 'low-power'].includes(artifact.band)) {
        throw new Error(`Missing eligible theme-gaps evidence for ${slug}`);
      }
      const report = validateCorpus({ taskIds: [run.task_id] });
      const failed = report.families.filter(family => family.status === 'FAIL');
      if (failed.length) {
        throw new Error(`Failed artifacts for ${slug} (${run.task_id}): ${failed.map(family => family.agent).join(', ')}`);
      }
      console.log(`PASS ${slug} ${run.bioguide_id} ${run.task_id}`);
    }
  } finally {
    conn.closeSync();
    db.closeSync();
  }
  console.log(`Release evidence passed for all ${roster.length} profiles.`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
