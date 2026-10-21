/**
 * Cosponsorship fetch-completeness tests.
 *
 * Stratum 4 (Chris Van Hollen): the member-scoped cosponsorship fetch
 * "terminated incomplete before target rows were loaded", yet the step reported
 * success and the run continued. Two distinct silent-success holes produced
 * that:
 *
 *   1. A per-member fetch error was caught, printed as a warning, and the loop
 *      moved on — the process still exited 0.
 *   2. `fetchAllCosponsored` broke out of pagination whenever a page came back
 *      short, even when the upstream `pagination.count` said more rows existed.
 *      A truncated page therefore produced a SILENTLY partial bill list that
 *      was then written as if it were the member's complete cosponsorship set.
 *
 * The rule pinned here: an incomplete or terminated fetch fails that member
 * non-zero and is never reported as a successful load. Because the writer is
 * additive (INSERT … ON CONFLICT DO NOTHING, no delete/replace), existing good
 * target rows survive untouched — these tests assert that too, so a future
 * change to replacement semantics cannot silently start destroying data on
 * partial input.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, insertMember, snapshot } from './__testkit__/temp-db.js';
import { loadCosponsored, type CosponsoredPage } from './load-cosponsored.js';

function bill(congress: number, type: string, number: number) {
  return {
    congress, type, number,
    title: `${type.toUpperCase()} ${number}`,
    introducedDate: '2025-03-01',
    latestAction: { text: 'Introduced in Senate' },
  };
}

async function seed(conn: any) {
  await insertMember(conn, {
    memberId: 'chris-van-hollen', name: 'Chris Van Hollen',
    chamber: 'senate', state: 'MD', bioguideId: 'V000128',
  });
}

/** A pre-existing, already-good cosponsor row for the target. */
async function seedExistingRow(conn: any) {
  await conn.run(
    `INSERT INTO bills (member_id, bill_id, title, status, sponsor_role, introduced_at, source_url, fetched_at)
     VALUES ('chris-van-hollen', '119/s/1', 'Existing Good Row', 'introduced', 'cosponsor', '2025-01-01', 'https://example.gov/1', '2026-01-01T00:00:00.000Z')`,
  );
}

test('a fetch that terminates mid-pagination fails the member and is not reported as loaded', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await seed(conn);
    await seedExistingRow(conn);
    const before = await snapshot(conn, 'bills', 'member_id, bill_id');

    // Page 1 arrives, page 2 aborts — the observed "terminated incomplete" shape.
    const fetchPage = async (_bio: string, offset: number): Promise<CosponsoredPage> => {
      if (offset === 0) return { items: [bill(119, 's', 100)], totalCount: 2 };
      throw new Error('The operation was aborted due to timeout');
    };

    const res = await loadCosponsored({ conn, fetchPage, pageSize: 1, memberId: 'chris-van-hollen' });

    assert.equal(res.errored, 1, 'the terminated fetch is counted as an error');
    assert.equal(res.exitCode !== 0, true, 'an incomplete fetch must exit non-zero');
    assert.ok(
      res.members.some(m => m.memberId === 'chris-van-hollen' && m.state === 'failed'),
      'the member is reported failed, not as a successful load',
    );

    const after = await snapshot(conn, 'bills', 'member_id, bill_id');
    assert.equal(after, before, 'existing good target rows are preserved on incomplete input');
  } finally { cleanup(); }
});

test('a short page while upstream reports more rows is incomplete, not a successful end-of-results', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await seed(conn);
    await seedExistingRow(conn);
    const before = await snapshot(conn, 'bills', 'member_id, bill_id');

    // Upstream says 900 rows exist; the first page returns a truncated 1.
    // The old break condition treated this as "done" and wrote a partial set.
    const fetchPage = async (): Promise<CosponsoredPage> => ({
      items: [bill(119, 's', 100)],
      totalCount: 900,
    });

    const res = await loadCosponsored({ conn, fetchPage, pageSize: 250, memberId: 'chris-van-hollen' });

    assert.equal(res.exitCode !== 0, true, 'a truncated result set must not report success');
    assert.equal(res.errored, 1);
    assert.ok(
      res.members.some(m => m.state === 'failed' && /incomplete/i.test(m.error ?? '')),
      'the failure names incompleteness explicitly rather than inventing an end-of-results',
    );

    const after = await snapshot(conn, 'bills', 'member_id, bill_id');
    assert.equal(after, before, 'no partial write on an incomplete fetch');
  } finally { cleanup(); }
});

test('a complete multi-page fetch loads every row and exits zero', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await seed(conn);

    const pages: CosponsoredPage[] = [
      { items: [bill(119, 's', 100)], totalCount: 2 },
      { items: [bill(119, 's', 200)], totalCount: 2 },
    ];
    const fetchPage = async (_bio: string, offset: number) => pages[offset]!;

    const res = await loadCosponsored({ conn, fetchPage, pageSize: 1, memberId: 'chris-van-hollen' });

    assert.equal(res.exitCode, 0);
    assert.equal(res.errored, 0);
    assert.equal(res.totalInserted, 2, 'both pages were loaded');

    const rows = await conn.run(
      `SELECT bill_id FROM bills WHERE member_id = 'chris-van-hollen' ORDER BY bill_id`);
    const ids = (await rows.getRowObjects()).map((r: any) => String(r.bill_id));
    assert.deepEqual(ids, ['119/s/100', '119/s/200']);
  } finally { cleanup(); }
});

test('a genuine zero-result fetch is a verified-empty success, not a failure', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await seed(conn);

    // A successful, complete search that legitimately found nothing. This must
    // stay distinguishable from a terminated fetch — the same distinction the
    // Senate PTR loader draws for a source-backed zero-filing result.
    const fetchPage = async (): Promise<CosponsoredPage> => ({ items: [], totalCount: 0 });

    const res = await loadCosponsored({ conn, fetchPage, pageSize: 250, memberId: 'chris-van-hollen' });

    assert.equal(res.exitCode, 0, 'a corroborated empty result is not an error');
    assert.equal(res.errored, 0);
    assert.equal(res.totalInserted, 0);
    assert.ok(
      res.members.some(m => m.state === 'verified-empty'),
      'the empty result is recorded explicitly rather than being indistinguishable from a silent skip',
    );
  } finally { cleanup(); }
});

test('a member with no bioguide is reported, not silently skipped', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await insertMember(conn, {
      memberId: 'no-bioguide', name: 'No Bioguide', chamber: 'house', state: 'MD',
    });

    const fetchPage = async (): Promise<CosponsoredPage> => {
      throw new Error('must not be called without a bioguide');
    };

    const res = await loadCosponsored({ conn, fetchPage, memberId: 'no-bioguide' });

    assert.ok(
      res.members.some(m => m.memberId === 'no-bioguide' && m.state === 'skipped'),
      'the unfetchable member is accounted for in the report',
    );
    assert.notEqual(res.exitCode, 0, 'a required member that could not be fetched fails closed');
  } finally { cleanup(); }
});
