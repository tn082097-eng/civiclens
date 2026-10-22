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
import { ResearcherOutputSchema } from '../../lib/schemas.js';
import { tempDb, insertMember, snapshot } from '../../db/__testkit__/temp-db.js';
import { planVoteBatch, applyVoteBatch } from '../../db/load-from-tasks.js';

const cases = [
  { chamber: 'house' as const, bioguide: 'H001047', samples: [
    ['118-2023/h700', '2023-12-06', 'official-samples/house-legacy-2023-roll700.xml'],
    ['119-2025/h1', '2025-01-03', 'house-acquisition/house-2025-roll001.xml'],
    ['119-2025/h2', '2025-01-03', 'official-samples/house-speaker-2025-roll002.xml'],
    ['119-2025/h6', '2025-01-07', 'official-samples/house-bill-2025-roll006.xml'],
  ] },
  { chamber: 'senate' as const, bioguide: 'S000033', samples: [
    ['118-2024/s140', '2024-04-17', 'official-samples/senate-procedural-2024-roll140.xml'],
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
      const normalized = normalizeMemberVotes(normalization);
      assert.equal(normalized.votes.length, rolls.length);
      if (c.chamber === 'house') {
        assert.deepEqual(normalized.coverage.outOfServiceListings, [{
          rollKey: '119-2025/h1', chamber: 'house', voterId: 'G000578',
          rawPosition: 'Not Voting', date: '2025-01-03',
        }]);
      }
      // SYNTHETIC surrounding biography only; real normalized votes and coverage
      // must survive the same artifact validation that researcher/loadOne use.
      const parsed = ResearcherOutputSchema.parse({
        source:'congress.gov',fetchedAt:'2026-10-16T12:00:00Z',target:{name:'Fixture member',type:'politician'},warnings:[],
        data:{id:c.bioguide,name:'Fixture member',party:'Independent',state:'TX',chamber:c.chamber,
          role:'Fixture role',bio:'SYNTHETIC biography for an offline artifact interoperability control only. '.repeat(2),
          inOffice:true,bills:[],votes:normalized.votes,voteCoverage:normalized.coverage,donors:[],controversies:[],connections:[]},
      });
      assert.deepEqual(parsed.data.voteCoverage?.outOfServiceListings,normalized.coverage.outOfServiceListings);
      await insertMember(db.conn, { memberId: c.bioguide, name: 'Fixture member', chamber: c.chamber, bioguideId: c.bioguide });
      await insertMember(db.conn, { memberId: 'unaffected', name: 'SYNTHETIC unaffected member', chamber: c.chamber });
      const otherBefore = await snapshot(db.conn, "(SELECT * FROM members WHERE member_id='unaffected')", 'member_id');
      await applyVoteBatch(db.conn, c.bioguide, planVoteBatch(c.bioguide, parsed.data.votes, parsed.data.voteCoverage));
      const rows = await (await db.conn.run('SELECT vote_id, bill_id, position, source_url FROM votes WHERE member_id=? ORDER BY vote_id', [c.bioguide])).getRowObjects();
      assert.equal(rows.length, rolls.length);
      assert.deepEqual(rows.map(r => r.vote_id).sort(), rolls.map(r => r.key).sort());
      for (const resolution of resolutions) {
        assert.ok(resolution.ok);
        const row = rows.find(r => r.vote_id === resolution.key)!;
        assert.equal(row.bill_id, resolution.resolution.billId);
        assert.equal(row.source_url, resolution.sourceUrl);
      }
      if (c.chamber === 'house') {
        assert.equal(rows.find(r => r.vote_id === '119-2025/h2')?.position, 'other');
        assert.equal(rows.find(r => r.vote_id === '119-2025/h6')?.bill_id, '119-hr-29');
      } else {
        assert.equal(rows.find(r => r.vote_id === '118-2024/s140')?.bill_id, null);
        const procedural = resolutions.find(r => r.key === '118-2024/s140');
        assert.ok(procedural?.ok);
        assert.equal(procedural.resolution.outcome, 'unsupported_record');
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
