/**
 * Frozen official XML -> acquisition -> pinned offline collector -> normalization
 * -> temporary DuckDB. Selected rolls prove interoperability, NOT window coverage.
 * The window envelope below is explicitly SYNTHETIC; no live source is queried.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT } from '../../lib/paths.js';
import { parseRollKey, houseSourceUrl, senateSourceUrl, coverageWindow } from '../../lib/vote-source.js';
import { loadWindowRun, normalizeMemberVotes } from './official-member-votes.js';
import { resolveOfficialRolls } from './official-vote-runtime.js';
import { runCollectorBridge } from '../../lib/collector-bridge.js';
import { loadIdentityIndex } from '../../lib/official-identity.js';
import { OfficialVoteFailure } from '../../lib/official-vote-types.js';
import { tempDb, insertMember, snapshot } from '../../db/__testkit__/temp-db.js';
import { planVoteBatch, applyVoteBatch } from '../../db/load-from-tasks.js';

const cases = [
  { chamber: 'house' as const, bioguide: 'H001047', samples: [
    ['119-2025/h1', '2025-01-03', 'house-acquisition/house-2025-roll001.xml'],
    ['119-2025/h2', '2025-01-03', 'official-samples/house-speaker-2025-roll002.xml'],
    ['119-2025/h6', '2025-01-07', 'official-samples/house-bill-2025-roll006.xml'],
  ] },
  { chamber: 'senate' as const, bioguide: 'S000033', samples: [
    ['119-2025/s1', '2025-01-09', 'official-samples/senate-119-1-roll00001.xml'],
    ['119-2025/s3', '2025-01-15', 'official-samples/senate-amendment-119-1-roll00003.xml'],
    ['119-2025/s570', '2025-10-09', 'official-samples/senate-bill-119-1-roll00570.xml'],
    ['119-2025/s655', '2025-12-18', 'official-samples/senate-nomination-119-1-roll00655.xml'],
  ] },
];

for (const c of cases) {
  test(`${c.chamber}: frozen official rolls reach canonical temporary vote rows`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'official-vote-e2e-'));
    const db = await tempDb();
    try {
      const rolls = c.samples.map(([key, date]) => ({ key, date }));
      const fixtureMap = Object.fromEntries(c.samples.map(([key, , file]) => {
        const id = parseRollKey(key);
        const url = id.chamber === 'house' ? houseSourceUrl(id.year, id.roll)
          : senateSourceUrl(id.congress, id.session, id.roll);
        return [url, join(ROOT, 'fixtures/votes', file)];
      }));
      writeFileSync(join(dir, 'rolls.json'), JSON.stringify(rolls));
      writeFileSync(join(dir, 'map.json'), JSON.stringify(fixtureMap));
      const runDir = join(dir, 'run');
      const acquisition = spawnSync('/usr/bin/python3', ['-I', '-B',
        join(ROOT, 'tools/congress-collector/acquire_window.py'),
        '--chamber', c.chamber, '--rolls-json', join(dir, 'rolls.json'),
        '--fixture-map', join(dir, 'map.json'), '--output', runDir,
      ], { cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir, LANG: 'C.UTF-8' } });
      assert.equal(acquisition.status, 0, `${acquisition.stderr}\n${readFileSync(join(runDir, 'acquisition/manifest.json'), 'utf8')}`);
      const loaded = loadWindowRun(runDir);
      const resolutions = await resolveOfficialRolls(rolls, { source: { mode: 'prepared', runDir } });
      assert.equal(resolutions.length, rolls.length);
      assert.ok(resolutions.every(r => r.ok), JSON.stringify(resolutions));
      const bridge = await runCollectorBridge(loaded.bridgeInputs);
      if (c.chamber === 'senate') {
        const bundle = bridge.results.find(r => r.key === '119-2025/s655');
        assert.ok(bundle?.ok && bundle.raw.chamber === 'senate');
        assert.equal(bundle.raw.documents?.length, 97);
      }
      const asOf = '2026-10-16', window = coverageWindow(asOf);
      // SYNTHETIC envelope only: these selected rolls are not full-window evidence.
      const normalization = {
        ...loaded, runDir, bridge, identity: loadIdentityIndex(), bioguideId: c.bioguide,
        chamber: c.chamber, asOf,
        run: { ...loaded.run, mode: 'window' as const, as_of: asOf, months: 48, window: [window.start, window.end] as [string, string] },
      };
      if (c.chamber === 'house') {
        // Real source conflict, NOT a success fixture: roll 1 includes G000578
        // as Not Voting after the pinned identity snapshot's term end.
        // Preserve the strict contract; do not silently omit it in production.
        assert.throws(() => normalizeMemberVotes(normalization),
          (error: unknown) => error instanceof OfficialVoteFailure
            && error.code === 'voter_not_in_service' && error.message.includes('G000578'));
      }
      const accepted = c.chamber === 'house' ? rolls.filter(r => r.key !== '119-2025/h1') : rolls;
      const acceptedKeys = new Set(accepted.map(r => r.key));
      // A separate selected-roll interoperability control, not a repaired full run.
      const normalized = normalizeMemberVotes({ ...normalization,
        bridgeInputs: loaded.bridgeInputs.filter(r => acceptedKeys.has(r.key)),
        bridge: { ...bridge, results: bridge.results.filter(r => acceptedKeys.has(r.key)) },
      });
      assert.equal(normalized.votes.length, accepted.length);
      await insertMember(db.conn, { memberId: c.bioguide, name: 'Fixture member', chamber: c.chamber, bioguideId: c.bioguide });
      await insertMember(db.conn, { memberId: 'unaffected', name: 'SYNTHETIC unaffected member', chamber: c.chamber });
      const otherBefore = await snapshot(db.conn, "(SELECT * FROM members WHERE member_id='unaffected')", 'member_id');
      await applyVoteBatch(db.conn, c.bioguide, planVoteBatch(c.bioguide, normalized.votes, normalized.coverage));
      const rows = await (await db.conn.run('SELECT vote_id, bill_id, position, source_url FROM votes WHERE member_id=? ORDER BY vote_id', [c.bioguide])).getRowObjects();
      assert.equal(rows.length, accepted.length);
      assert.deepEqual(rows.map(r => r.vote_id).sort(), accepted.map(r => r.key).sort());
      for (const resolution of resolutions.filter(r => acceptedKeys.has(r.key))) {
        assert.ok(resolution.ok);
        const row = rows.find(r => r.vote_id === resolution.key)!;
        assert.equal(row.bill_id, resolution.resolution.billId);
        assert.equal(row.source_url, resolution.sourceUrl);
      }
      if (c.chamber === 'house') {
        assert.equal(rows.find(r => r.vote_id === '119-2025/h2')?.position, 'other');
        assert.equal(rows.find(r => r.vote_id === '119-2025/h6')?.bill_id, '119-hr-29');
      } else {
        assert.equal(rows.find(r => r.vote_id === '119-2025/s655')?.bill_id, null);
        const bundle = resolutions.find(r => r.key === '119-2025/s655');
        assert.ok(bundle?.ok);
        assert.equal(bundle.resolution.subtype, 'nomination');
      }
      assert.equal(await snapshot(db.conn, "(SELECT * FROM members WHERE member_id='unaffected')", 'member_id'), otherBefore);
    } finally {
      db.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
