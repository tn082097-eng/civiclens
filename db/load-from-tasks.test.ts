/**
 * Donor-write safety: a research refresh must never delete good donor rows
 * because the upstream fetch came back empty.
 *
 * Regression for 2026-07-28: a `--refresh-research` run for Lois Frankel hit
 * OpenFEC's "no committee for candidate H2FL22080" soft failure, returned zero
 * donors, and the unconditional `DELETE FROM donors WHERE member_id = ?` wiped
 * 100 existing rows. Votes refreshed fine, so the loss was silent — the page
 * would simply have rendered an empty donor section.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, insertMember, snapshot } from './__testkit__/temp-db.js';
import { usableDonors } from './load-from-tasks.js';

/** The write the loader performs, expressed exactly as loadOne does it. */
async function writeDonors(conn: any, memberId: string, donors: unknown): Promise<number> {
  const fetched = usableDonors(donors);
  if (fetched.length > 0) {
    await conn.run(`DELETE FROM donors WHERE member_id = ?`, [memberId]);
  }
  for (const dn of fetched) {
    await conn.run(
      `INSERT OR REPLACE INTO donors
         (member_id, donor_name, donor_canonical, donor_type, amount, latest_date,
          cycles, source, source_url, confidence, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [memberId, dn.name, String(dn.name).toLowerCase(), null,
       Number(dn.amount ?? 0), null, null, null, null, null,
       '2026-07-28T00:00:00.000Z'],
    );
  }
  return fetched.length;
}

test('usableDonors: keeps named rows, drops nameless/blank ones', () => {
  assert.equal(usableDonors([{ name: 'ACME PAC' }, { name: 'Widget Co' }]).length, 2);
  assert.equal(usableDonors([{ name: 'ACME PAC' }, { amount: 5 }, { name: '' }]).length, 1);
});

test('usableDonors: non-array input is empty, never a crash', () => {
  for (const bad of [undefined, null, {}, 'donors', 42]) {
    assert.deepEqual(usableDonors(bad as unknown), []);
  }
});

test('empty fetch PRESERVES existing donor rows (the Frankel regression)', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await insertMember(conn, { memberId: 'lois-frankel', name: 'Lois Frankel', chamber: 'house' });
    const n = await writeDonors(conn, 'lois-frankel',
      [{ name: 'ACME PAC', amount: 100 }, { name: 'Widget Co', amount: 250 }]);
    assert.equal(n, 2);
    const before = await snapshot(conn, 'donors', 'donor_name');

    // OpenFEC soft failure: the researcher artifact carries an empty array.
    const written = await writeDonors(conn, 'lois-frankel', []);

    assert.equal(written, 0, 'nothing written');
    const after = await snapshot(conn, 'donors', 'donor_name');
    assert.equal(after, before, 'existing donor rows must survive an empty fetch');
  } finally {
    cleanup();
  }
});

test('non-empty fetch still REPLACES the previous rows (latest fetch wins)', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await insertMember(conn, { memberId: 'jane-doe', name: 'Jane Doe', chamber: 'house' });
    await writeDonors(conn, 'jane-doe', [{ name: 'Old PAC', amount: 1 }]);
    await writeDonors(conn, 'jane-doe', [{ name: 'New PAC', amount: 2 }, { name: 'Newer PAC', amount: 3 }]);

    const rows = await snapshot(conn, 'donors', 'donor_name');
    assert.ok(!rows.includes('Old PAC'), 'superseded donor is gone');
    assert.ok(rows.includes('New PAC') && rows.includes('Newer PAC'), 'new rows present');
  } finally {
    cleanup();
  }
});

test('an empty fetch for one member never touches another member', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await insertMember(conn, { memberId: 'jane-doe', name: 'Jane Doe', chamber: 'house' });
    await insertMember(conn, { memberId: 'john-roe', name: 'John Roe', chamber: 'house' });
    await writeDonors(conn, 'jane-doe', [{ name: 'Jane PAC', amount: 10 }]);
    await writeDonors(conn, 'john-roe', [{ name: 'John PAC', amount: 20 }]);

    await writeDonors(conn, 'jane-doe', []);

    const rows = await snapshot(conn, 'donors', 'donor_name');
    assert.ok(rows.includes('John PAC'), "the other member's rows are untouched");
    assert.ok(rows.includes('Jane PAC'), "the empty-fetch member keeps its rows too");
  } finally {
    cleanup();
  }
});
