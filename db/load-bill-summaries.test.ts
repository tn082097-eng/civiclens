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

// SYNTHETIC legacy stored rolls, resolved by an injected official source.
async function seedLegacyRoll(conn: any, key: string, date = '2025-01-07', question = 'Procedure') {
  await conn.run(`INSERT INTO votes(member_id,vote_id,date,question,source_url,fetched_at) VALUES ('jane-doe',?,?,?,?,'2026-01-01T00:00:00.000Z')`, [key, date, question, `https://www.govtrack.us/congress/votes/${key}`]);
}
test('official pass resolves only bills, counts outcomes/cap and preserves member scope', async () => {
  const s = await tempDb();
  try {
    await seedTwoMembers(s.conn);
    for (const key of ['119-2025/h6', '119-2025/h7', '119-2025/h8', '119-2025/h9'])
      await seedLegacyRoll(s.conn, key);
    const r = await backfillBillIds(memberScope('jane-doe'), { conn: s.conn, officialPass: true, apiLimit: 3, resolveRolls: async (reqs, opts) => { assert.equal(reqs.length, 3); assert.deepEqual(opts, { source: { mode: 'live' } }); return reqs.map((q, i) => ({ key: q.key, date: q.date, ok: true, sourceUrl: `https://clerk.house.gov/evs/2025/roll${q.key.split('h')[1].padStart(3, '0')}.xml`, resolution: i === 0 ? { outcome: 'resolved_bill', billId: '119-hr-29', subtype: null, amendment: null, reason: null } : i === 1 ? { outcome: 'authoritative_non_bill', billId: null, subtype: 'quorum', amendment: null, reason: null } : { outcome: 'unsupported_record', billId: null, subtype: null, amendment: null, reason: 'synthetic' } })); } });
    assert.equal(r.officialResolved, 1);
    assert.equal(r.apiResolved, 1);
    assert.equal(r.nonBill, 1);
    assert.equal(r.unresolved, 1);
    assert.equal(r.notAttempted, 1);
    const rows = await (await s.conn.run("SELECT bill_id FROM votes WHERE bill_id IS NOT NULL")).getRowObjects();
    assert.deepEqual(rows.map(x => x.bill_id), ['119-hr-29']);
  }
  finally {
    s.cleanup();
  }
});
test('official resolver failure prevents every update, including regex candidates', async () => {
  const s = await tempDb();
  try {
    await seedTwoMembers(s.conn);
    await seedLegacyRoll(s.conn, '119-2025/h6', '2025-01-07', 'H R 29');
    await seedLegacyRoll(s.conn, '119-2025/h7');
    const before = await snapshot(s.conn, 'votes', 'member_id,vote_id');
    await assert.rejects(() => backfillBillIds(memberScope('jane-doe'), { conn: s.conn, officialPass: true, resolveRolls: async (reqs) => reqs.map(q => ({ key: q.key, ok: false, failure: { stage: 'acquisition', code: 'synthetic', message: 'failed' } })) }), /legacy_roll_resolution_failed/);
    assert.equal(await snapshot(s.conn, 'votes', 'member_id,vote_id'), before);
  }
  finally {
    s.cleanup();
  }
});
test('regex ignores official URLs and malformed legacy roll keys fail before update', async () => {
  const s = await tempDb();
  try {
    await seedTwoMembers(s.conn);
    await s.conn.run("INSERT INTO votes(member_id,vote_id,question,source_url,fetched_at) VALUES ('jane-doe','119-2025/h6','H R 29','https://clerk.house.gov/evs/2025/roll006.xml','2026-01-01T00:00:00.000Z')");
    await backfillBillIds(memberScope('jane-doe'), { conn: s.conn });
    assert.match(await snapshot(s.conn, 'votes', 'vote_id'), /"bill_id":null/);
    await seedLegacyRoll(s.conn, 'bad-key');
    await assert.rejects(() => backfillBillIds(memberScope('jane-doe'), { conn: s.conn, officialPass: true, resolveRolls: async () => { throw Error('must not call'); } }), /legacy_roll_resolution_failed/);
  }
  finally {
    s.cleanup();
  }
});
test('official pass rejects conflicting dates before resolution and missing/duplicate results before updates', async () => {
  const s = await tempDb();
  try {
    await seedTwoMembers(s.conn);
    await seedLegacyRoll(s.conn, '119-2025/h6');
    await s.conn.run(`INSERT INTO votes(member_id,vote_id,date,question,source_url,fetched_at) VALUES ('john-roe','119-2025/h6','2025-01-08','Procedure','https://www.govtrack.us/congress/votes/119-2025/h6','2026-01-01T00:00:00.000Z')`);
    const before = await snapshot(s.conn, 'votes', 'member_id,vote_id');
    await assert.rejects(() => backfillBillIds({ kind: 'all' }, { conn: s.conn, officialPass: true, resolveRolls: async () => { throw Error('must not resolve'); } }), /legacy_roll_resolution_failed/);
    assert.equal(await snapshot(s.conn, 'votes', 'member_id,vote_id'), before);
    await assert.rejects(() => backfillBillIds(memberScope('jane-doe'), { conn: s.conn, officialPass: true, resolveRolls: async () => [] }), /legacy_roll_resolution_failed/);
    await assert.rejects(() => backfillBillIds(memberScope('jane-doe'), { conn: s.conn, officialPass: true, resolveRolls: async (requests) => requests.flatMap(r => [0, 1].map(() => ({ key: r.key, ok: true as const, date: r.date, sourceUrl: 'https://clerk.house.gov/evs/2025/roll006.xml', resolution: { outcome: 'resolved_bill' as const, billId: '119-hr-29', subtype: null, amendment: null, reason: null } }))) }), /legacy_roll_resolution_failed/);
    assert.equal(await snapshot(s.conn, 'votes', 'member_id,vote_id'), before);
  }
  finally {
    s.cleanup();
  }
});
test('official pass batches shared rolls once, deprecated alias works, updates remain transactional', async () => {
  const s = await tempDb();
  try {
    await seedTwoMembers(s.conn);
    await seedLegacyRoll(s.conn, '119-2025/h6');
    await seedLegacyRoll(s.conn, '119-2025/h7');
    const before = await snapshot(s.conn, 'votes', 'member_id,vote_id');
    let updateCalls = 0;
    const proxy = new Proxy(s.conn, {
      get(target, key) {
        if (key === 'run')
          return async (sql: string, ...args: any[]) => {
            if (sql.startsWith('UPDATE votes') && ++updateCalls === 2)
              throw Error('synthetic update failure'); return (target.run as any)(sql, ...args);
          }; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    await assert.rejects(() => backfillBillIds(memberScope('jane-doe'), { conn: proxy, apiPass: true, resolveRolls: async (requests) => requests.map(r => ({ key: r.key, ok: true, date: r.date, sourceUrl: `https://clerk.house.gov/evs/2025/roll${r.key.split('h')[1].padStart(3, '0')}.xml`, resolution: { outcome: 'resolved_bill', billId: '119-hr-29', subtype: null, amendment: null, reason: null } })) }), /synthetic update failure/);
    assert.equal(updateCalls, 2);
    assert.equal(await snapshot(s.conn, 'votes', 'member_id,vote_id'), before);
  }
  finally {
    s.cleanup();
  }
});

