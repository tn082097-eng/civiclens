/**
 * Bills member-scope tests (Phase 1B.5). Member mode: regex backfill touches ONLY
 * the target's NULL votes; another member's votes are never updated; and no
 * global NULL-title refill runs. Temp DuckDB; API pass disabled (network-free —
 * the scoping logic under test is the regex backfill + worklist origin).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, insertMember, snapshot } from './__testkit__/temp-db.js';
import { backfillBillIds, distinctBillWorklist } from './load-bill-summaries.js';
import type { IngestScope } from '../lib/ingest-scope.js';

function memberScope(slug: string): IngestScope {
  return { kind: 'member', slug, bioguideId: 'X', memberId: slug, chamber: 'house' };
}

async function seedVote(conn: any, member: string, voteId: string, question: string) {
  await conn.run(
    `INSERT INTO votes (member_id, vote_id, question, position, date, source_url, fetched_at)
     VALUES (?, ?, ?, 'Yea', '2024-03-01', ?, ?)`,
    [member, voteId, question, `https://www.govtrack.us/congress/votes/118-2024/${voteId}`, '2026-01-01T00:00:00.000Z'],
  );
}

async function seedTwoMembers(conn: any) {
  await insertMember(conn, { memberId: 'jane-doe', name: 'Jane Doe', chamber: 'house' });
  await insertMember(conn, { memberId: 'john-roe', name: 'John Roe', chamber: 'house' });
}

test('member mode regex backfill updates only the target member votes', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await seedTwoMembers(conn);
    await seedVote(conn, 'jane-doe', 'h100', 'On Passage H R 8752');
    await seedVote(conn, 'john-roe', 'h200', 'On Passage H R 9999');

    const r = await backfillBillIds(memberScope('jane-doe'), { apiPass: false, conn });
    assert.ok(r.filled >= 1, 'target vote backfilled');

    const jane = await snapshot(conn, "(SELECT member_id, vote_id, bill_id FROM votes WHERE member_id='jane-doe')", 'vote_id');
    const roe = await snapshot(conn, "(SELECT member_id, vote_id, bill_id FROM votes WHERE member_id='john-roe')", 'vote_id');
    assert.match(jane, /118-hr-8752/, 'jane bill_id filled');
    assert.match(roe, /"bill_id":null/, 'john-roe vote left NULL — not touched by a member-scoped run');
  } finally {
    cleanup();
  }
});

test('member worklist is only bills referenced by the target votes', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await seedTwoMembers(conn);
    // Both members already have bill_ids; worklist for jane must exclude john's bill.
    await conn.run(
      `INSERT INTO votes (member_id, vote_id, question, position, date, bill_id, source_url, fetched_at)
       VALUES ('jane-doe','h1','q','Yea','2024-01-01','118-hr-1','u','2026-01-01T00:00:00.000Z'),
              ('john-roe','h2','q','Yea','2024-01-01','118-hr-2','u','2026-01-01T00:00:00.000Z')`);

    const work = await distinctBillWorklist(memberScope('jane-doe'), conn);
    assert.deepEqual(work, ['118-hr-1'], 'worklist scoped to the target member only');

    const workAll = await distinctBillWorklist({ kind: 'all' }, conn);
    assert.deepEqual(workAll.sort(), ['118-hr-1', '118-hr-2']);
  } finally {
    cleanup();
  }
});

test('member mode does no global NULL-title refill (other members untouched)', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await seedTwoMembers(conn);
    await seedVote(conn, 'jane-doe', 'h100', 'On Passage H R 8752');
    await seedVote(conn, 'john-roe', 'h200', 'On Passage H R 9999');
    const roeBefore = await snapshot(conn, "(SELECT member_id, vote_id, bill_id FROM votes WHERE member_id='john-roe')", 'vote_id');

    // Full member run with API disabled (backfill only) must never touch john-roe.
    await backfillBillIds(memberScope('jane-doe'), { apiPass: false, conn });

    const roeAfter = await snapshot(conn, "(SELECT member_id, vote_id, bill_id FROM votes WHERE member_id='john-roe')", 'vote_id');
    assert.equal(roeAfter, roeBefore, 'other member votes byte-identical after member-scoped backfill');
  } finally {
    cleanup();
  }
});

test('all mode backfills every member', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await seedTwoMembers(conn);
    await seedVote(conn, 'jane-doe', 'h100', 'On Passage H R 8752');
    await seedVote(conn, 'john-roe', 'h200', 'On Passage H R 9999');

    await backfillBillIds({ kind: 'all' }, { apiPass: false, conn });
    const all = await snapshot(conn, '(SELECT member_id, vote_id, bill_id FROM votes)', 'member_id, vote_id');
    assert.match(all, /118-hr-8752/);
    assert.match(all, /118-hr-9999/);
  } finally {
    cleanup();
  }
});
