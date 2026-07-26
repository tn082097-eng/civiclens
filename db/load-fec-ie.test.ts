/**
 * FEC IE member-scope tests (Phase 1B.3). Proves member enumeration is filtered
 * BEFORE any network fetch (the fetcher is called only for the target/cycle),
 * DELETE/INSERT is restricted to that member/cycle, and a missing
 * fec_candidate_id for the selected member fails loud instead of silently
 * running a zero-result roster pass. Temp DuckDB + injected fetcher (no network).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, insertMember, snapshot } from './__testkit__/temp-db.js';
import { loadFecIe } from './load-fec-ie.js';
import type { IngestScope } from '../lib/ingest-scope.js';
import type { SuperPacIEReport } from '../lib/types.js';

function memberScope(slug: string): IngestScope {
  return { kind: 'member', slug, bioguideId: 'X', memberId: slug, chamber: 'house' };
}

function report(candidateId: string, cycle: number, amount: number): SuperPacIEReport {
  return {
    candidateId, cycle, fetchedAt: '2026-01-01T00:00:00.000Z',
    supporting: [{
      committeeId: 'C001', committeeName: 'Test PAC', committeeType: 'O',
      designation: 'U', party: 'X', supportOppose: 'S',
      totalAmount: amount, count: 1,
    } as any],
    opposing: [], totalSupporting: amount, totalOpposing: 0, filings: [],
  };
}

async function seedTwoWithFec(conn: any) {
  await insertMember(conn, { memberId: 'jane-doe', name: 'Jane Doe', chamber: 'house', fecCandidateId: 'H0DOE0001' });
  await insertMember(conn, { memberId: 'john-roe', name: 'John Roe', chamber: 'house', fecCandidateId: 'H0ROE0002' });
}

test('member mode fetches only the target candidate/cycle; other rows unchanged', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await seedTwoWithFec(conn);
    const calls: Array<{ cid: string; cycle: number }> = [];
    const fetcher = async (cid: string, cycle: number) => { calls.push({ cid, cycle }); return report(cid, cycle, 5000); };

    // Pre-seed john-roe via his own scoped run, snapshot him.
    await loadFecIe([2024], memberScope('john-roe'), { conn, fetcher });
    const roeBefore = await snapshot(conn, "(SELECT * FROM super_pac_ie WHERE member_id='john-roe')", 'member_id, cycle, committee_id');
    calls.length = 0;

    await loadFecIe([2024], memberScope('jane-doe'), { conn, fetcher });
    assert.deepEqual(calls, [{ cid: 'H0DOE0001', cycle: 2024 }], 'fetcher called ONLY for the target candidate/cycle');
    const roeAfter = await snapshot(conn, "(SELECT * FROM super_pac_ie WHERE member_id='john-roe')", 'member_id, cycle, committee_id');
    assert.equal(roeAfter, roeBefore, 'other member IE rows byte-identical');
    const jane = await snapshot(conn, "(SELECT * FROM super_pac_ie WHERE member_id='jane-doe')", 'member_id, cycle, committee_id');
    assert.match(jane, /jane-doe/);
  } finally {
    cleanup();
  }
});

test('missing fec_candidate_id for the selected member fails loud (no roster pass)', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await insertMember(conn, { memberId: 'no-fec', name: 'No Fec', chamber: 'house' /* no fecCandidateId */ });
    await insertMember(conn, { memberId: 'has-fec', name: 'Has Fec', chamber: 'house', fecCandidateId: 'H0HAS0001' });
    let called = false;
    const fetcher = async (cid: string, cycle: number) => { called = true; return report(cid, cycle, 1); };

    await assert.rejects(
      loadFecIe([2024], memberScope('no-fec'), { conn, fetcher }),
      /fec_candidate_id|no FEC candidate/i,
    );
    assert.equal(called, false, 'no network fetch when the target lacks a FEC id');
  } finally {
    cleanup();
  }
});

test('all mode fetches every member with a FEC id', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await seedTwoWithFec(conn);
    const calls: string[] = [];
    const fetcher = async (cid: string, cycle: number) => { calls.push(cid); return report(cid, cycle, 100); };

    await loadFecIe([2024], { kind: 'all' }, { conn, fetcher });
    assert.deepEqual(calls.sort(), ['H0DOE0001', 'H0ROE0002']);
  } finally {
    cleanup();
  }
});
