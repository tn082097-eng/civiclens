import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectOfficialVotes } from './fetch.js';
import { OfficialVoteFailure } from '../../lib/official-vote-types.js';
// SYNTHETIC helpers are local so importing them never runs another test suite.
function officialVote(overrides: Record<string, unknown> = {}) {
  return { billTitle: 'H R 29: Test bill', vote: 'yea', rawPosition: 'Yea', date: '2025-01-07', source: 'clerk.house.gov', sourceUrl: 'https://clerk.house.gov/evs/2025/roll006.xml', sourceSha256: 'a'.repeat(64), confidence: 1, rollKey: '119-2025/h6', chamber: 'house', congress: 119, session: 1, roll: 6, question: 'On Passage', resolution: { outcome: 'resolved_bill', billId: '119-hr-29', subtype: null, amendment: null, reason: null }, ...overrides };
}
function coverage(recorded = 0) {
  return { outcome: 'ok', source: 'official', chamber: 'house', bioguideId: 'X000001', asOf: '2026-10-16', window: { start: '2022-10-16', end: '2026-10-16', months: 48 }, requiredRolls: recorded, analyzedRolls: recorded, inServiceRolls: recorded, recorded, notRecorded: 0, notRecordedKeys: [], acquisition: { runDir: '/synthetic/run', manifestSha256: 'a'.repeat(64), inventorySha256: 'b'.repeat(64) }, collector: { commit: 'a'.repeat(40), lockSha256: 'a'.repeat(64), vendorManifestSha256: 'a'.repeat(64) }, identity: { commit: 'a'.repeat(40), snapshotSha256: 'a'.repeat(64), floor: '2022-01-01' } };
}
function artifact(votes: unknown[], voteCoverage?: unknown) {
  return { source: 'congress.gov', fetchedAt: '2026-10-16T12:00:00.000Z', target: { name: 'Test Member', type: 'politician' }, warnings: [], data: { id: 'test-member', name: 'Test Member', party: 'Independent', state: 'TX', chamber: 'house', role: 'Representative', bio: 'A synthetic biography used only for isolated contract tests.'.repeat(2), inOffice: true, bills: [], votes, donors: [], controversies: [], connections: [], ...(voteCoverage === undefined ? {} : { voteCoverage }) } };
}
test('collectOfficialVotes propagates the exact failure, never empty success', async () => {
  const failure = new OfficialVoteFailure('acquisition', 'source_failed', 'synthetic failure');
  await assert.rejects(() => collectOfficialVotes('X000001', 'house', '2026-10-16', async () => { throw failure; }), e => e === failure);
});
test('collectOfficialVotes forwards live options and preserves records/coverage', async () => {
  const expected: any = { votes: [officialVote()], coverage: coverage(1) };
  const result = await collectOfficialVotes('X000001', 'house', '2026-10-16', async (opts) => { assert.deepEqual(opts, { bioguideId: 'X000001', chamber: 'house', asOf: '2026-10-16', source: { mode: 'live' } }); return expected; });
  assert.deepEqual(result, expected);
});
test('unsupported chamber fails before calling a dependency', async () => {
  await assert.rejects(() => collectOfficialVotes('X000001', 'executive', '2026-10-16', async () => { throw Error('must not call'); }), (e: any) => e.stage === 'identity' && e.code === 'unsupported_chamber');
});
test('active TypeScript consumers contain no GovTrack API endpoint', () => {
  const hits: string[] = [];
  function scan(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory())
        scan(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && readFileSync(path, 'utf8').includes('govtrack.us/api'))
        hits.push(path);
    }
  }
  for (const dir of ['skills', 'db', 'agents', 'lib'])
    scan(resolve(dir));
  assert.deepEqual(hits, []);
});
