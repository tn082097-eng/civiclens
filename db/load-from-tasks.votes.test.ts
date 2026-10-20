// SYNTHETIC researcher artifacts; real loadOne + temp DuckDB only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDb, insertMember, snapshot } from './__testkit__/temp-db.js';
import { loadOne, planVoteBatch, applyVoteBatch, VoteBatchError } from './load-from-tasks.js';
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
async function setup() {
  const db = await tempDb();
  const dir = mkdtempSync(join(tmpdir(), 'civiclens-vote-task-'));
  for (const id of ['test-member', 'other-member']) {
    await insertMember(db.conn, { memberId: id, name: id, chamber: 'house' });
    await db.conn.run("INSERT INTO votes (member_id,vote_id,bill_id,question,position,date,source_url,fetched_at) VALUES (?, '119-2025/h6','119-hr-99','old question','nay','2025-01-07','https://www.govtrack.us/congress/votes/119-2025/h6','2026-01-01T00:00:00.000Z')", [id]);
  }
  const pick = { taskId: 'task-synthetic', taskDir: dir, memberName: 'Test Member', updatedAt: 0 };
  return { ...db, pick, write: (votes: unknown[], c?: unknown) => writeFileSync(join(dir, 'researcher.json'), JSON.stringify(artifact(votes, c))), cleanup: () => { db.cleanup(); rmSync(dir, { recursive: true, force: true }); } };
}
test('real loadOne persists rollKey and linkage while preserving another member', async () => {
  const s = await setup();
  try {
    const before = await snapshot(s.conn, "(SELECT * FROM votes WHERE member_id='other-member')", 'vote_id');
    s.write([officialVote()]);
    const r = await loadOne(s.pick, { conn: s.conn });
    assert.equal(r.votes, 1);
    const row = (await (await s.conn.run("SELECT * FROM votes WHERE member_id='test-member'")).getRowObjects())[0];
    assert.equal(row.vote_id, '119-2025/h6');
    assert.equal(row.bill_id, '119-hr-29');
    assert.equal(row.question, 'On Passage');
    assert.equal(await snapshot(s.conn, "(SELECT * FROM votes WHERE member_id='other-member')", 'vote_id'), before);
  }
  finally {
    s.cleanup();
  }
});
test('invalid row prevents all member writes and deletes', async () => {
  const s = await setup();
  try {
    const members = await snapshot(s.conn, 'members', 'member_id');
    const votes = await snapshot(s.conn, 'votes', 'member_id,vote_id');
    s.write([officialVote(), officialVote({ rollKey: 'bad' })]);
    await assert.rejects(() => loadOne(s.pick, { conn: s.conn }));
    assert.equal(await snapshot(s.conn, 'members', 'member_id'), members);
    assert.equal(await snapshot(s.conn, 'votes', 'member_id,vote_id'), votes);
  }
  finally {
    s.cleanup();
  }
});
test('injected insert failure after delete rolls back real loadOne vote transaction', async () => {
  const s = await setup();
  try {
    const before = await snapshot(s.conn, 'votes', 'member_id,vote_id');
    s.write([officialVote()]);
    const proxy = new Proxy(s.conn, {
      get(target, key) {
        if (key === 'run')
          return async (sql: string, ...args: any[]) => {
            if (sql.includes('INSERT') && sql.includes('INTO votes'))
              throw Error('synthetic insert failure'); return (target.run as any)(sql, ...args);
          }; const val = Reflect.get(target, key, target); return typeof val === 'function' ? val.bind(target) : val;
      }
    });
    await assert.rejects(() => loadOne(s.pick, { conn: proxy }), /synthetic insert failure/);
    assert.equal(await snapshot(s.conn, 'votes', 'member_id,vote_id'), before);
  }
  finally {
    s.cleanup();
  }
});
for (const outcome of ['authoritative_non_bill', 'unsupported_record'])
  test(`official ${outcome} clears stale GovTrack linkage`, async () => {
    const s = await setup();
    try {
      s.write([officialVote({ resolution: { outcome, billId: null, subtype: outcome === 'authoritative_non_bill' ? 'quorum' : null, amendment: null, reason: outcome === 'unsupported_record' ? 'synthetic unsupported' : null } })]);
      await loadOne(s.pick, { conn: s.conn });
      const rows = await (await s.conn.run("SELECT bill_id FROM votes WHERE member_id='test-member'")).getRowObjects();
      assert.equal(rows[0].bill_id, null);
    }
    finally {
      s.cleanup();
    }
  });
test('batch planner collects mixed, duplicate and legacy official-URL errors', () => {
  const legacy = { billTitle: 'old vote', vote: 'yea', date: '2025-01-07', source: 'govtrack.us', confidence: 1, sourceUrl: 'https://www.govtrack.us/congress/votes/119-2025/h6' };
  for (const votes of [[officialVote(), legacy], [officialVote(), officialVote()], [{ ...legacy, sourceUrl: 'https://www.senate.gov/anything' }]])
    assert.throws(() => planVoteBatch('test-member', votes), VoteBatchError);
  assert.throws(() => planVoteBatch('test-member', [officialVote({ roll: 9 }), officialVote({ roll: 10 })]), (e: any) => e.problems.length >= 2);
});
test('empty legacy batch preserves rows; validated official empty clears target only', async () => {
  const s = await setup();
  try {
    const before = await snapshot(s.conn, 'votes', 'member_id,vote_id');
    s.write([]);
    await loadOne(s.pick, { conn: s.conn });
    assert.equal(await snapshot(s.conn, 'votes', 'member_id,vote_id'), before);
    assert.throws(() => planVoteBatch('test-member', [], { outcome: 'ok' }));
    s.write([], coverage());
    await loadOne(s.pick, { conn: s.conn });
    const rows = await (await s.conn.run('SELECT member_id FROM votes')).getRowObjects();
    assert.deepEqual(rows.map(x => x.member_id), ['other-member']);
  }
  finally {
    s.cleanup();
  }
});
test('legacy apply keeps stored bill linkage and skips id-less rows', async () => {
  const s = await setup();
  try {
    const row = { billTitle: 'old vote', vote: 'yea', date: '2025-01-07', source: 'govtrack.us', confidence: 1, sourceUrl: 'https://www.govtrack.us/congress/votes/119-2025/h6' };
    await applyVoteBatch(s.conn, 'test-member', planVoteBatch('test-member', [row, { ...row, sourceUrl: 'https://example.org' }]));
    const rows = await (await s.conn.run("SELECT bill_id FROM votes WHERE member_id='test-member'")).getRowObjects();
    assert.equal(rows[0].bill_id, '119-hr-99');
  }
  finally {
    s.cleanup();
  }
});
