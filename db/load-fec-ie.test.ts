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

/**
 * `opts.aggregates` and `opts.filings` vary independently so tests can pin the
 * empty-aggregates-only / empty-filings-only / both-nonempty combinations. When
 * `opts.filings` is omitted (not merely `[]`), the report models a non-itemized
 * fetch that never requested filings at all — distinct from an itemized fetch
 * that came back genuinely empty.
 */
function report(
  candidateId: string,
  cycle: number,
  amount: number,
  opts: { aggregates?: boolean; filings?: any[] } = {},
): SuperPacIEReport {
  const includeAggregates = opts.aggregates ?? true;
  const rep: SuperPacIEReport = {
    candidateId, cycle, fetchedAt: '2026-01-01T00:00:00.000Z',
    supporting: includeAggregates ? [{
      committeeId: 'C001', committeeName: 'Test PAC', committeeType: 'O',
      designation: 'U', party: 'X', supportOppose: 'S',
      totalAmount: amount, count: 1,
    } as any] : [],
    opposing: [], totalSupporting: includeAggregates ? amount : 0, totalOpposing: 0,
  };
  if ('filings' in opts) rep.filings = opts.filings;
  else rep.filings = [];
  return rep;
}

function filing(id: string, amount: number): any {
  return {
    committeeId: 'C001', committeeName: 'Test PAC', candidateId: 'H0DOE0001',
    supportOppose: 'S', amount, expenditureDate: '2024-01-01', disbursementDate: null,
    description: 'ad buy', payeeName: 'Ad Co', pdfUrl: null, reportYear: 2024,
    electionType: 'G2024', transactionId: id,
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

test('empty aggregates array preserves existing super_pac_ie rows for that member/cycle', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await insertMember(conn, { memberId: 'jane-doe', name: 'Jane Doe', chamber: 'house', fecCandidateId: 'H0DOE0001' });

    // First run: real aggregates land.
    const goodFetcher = async (cid: string, cycle: number) => report(cid, cycle, 5000);
    await loadFecIe([2024], memberScope('jane-doe'), { conn, fetcher: goodFetcher });
    const before = await snapshot(conn, "(SELECT * FROM super_pac_ie WHERE member_id='jane-doe')", 'member_id, cycle, committee_id');
    assert.match(before, /Test PAC/);

    // Second run: FEC responds 200-OK but with zero aggregates.
    const emptyFetcher = async (cid: string, cycle: number) => report(cid, cycle, 0, { aggregates: false });
    await loadFecIe([2024], memberScope('jane-doe'), { conn, fetcher: emptyFetcher });
    const after = await snapshot(conn, "(SELECT * FROM super_pac_ie WHERE member_id='jane-doe')", 'member_id, cycle, committee_id');
    assert.equal(after, before, 'existing aggregates preserved when the fresh fetch is empty');
  } finally {
    cleanup();
  }
});

test('empty filings array preserves existing super_pac_ie_filings rows', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await insertMember(conn, { memberId: 'jane-doe', name: 'Jane Doe', chamber: 'house', fecCandidateId: 'H0DOE0001' });

    // First run: real filings land.
    const goodFetcher = async (cid: string, cycle: number) =>
      report(cid, cycle, 5000, { filings: [filing('TX1', 5000)] });
    await loadFecIe([2024], memberScope('jane-doe'), { conn, fetcher: goodFetcher });
    const before = await snapshot(conn, "(SELECT * FROM super_pac_ie_filings WHERE member_id='jane-doe')", 'member_id, cycle, transaction_id');
    assert.match(before, /TX1/);

    // Second run: FEC responds 200-OK with aggregates but zero itemized filings.
    const emptyFetcher = async (cid: string, cycle: number) =>
      report(cid, cycle, 5000, { filings: [] });
    await loadFecIe([2024], memberScope('jane-doe'), { conn, fetcher: emptyFetcher });
    const after = await snapshot(conn, "(SELECT * FROM super_pac_ie_filings WHERE member_id='jane-doe')", 'member_id, cycle, transaction_id');
    assert.equal(after, before, 'existing filings preserved when the fresh fetch has zero filings');
  } finally {
    cleanup();
  }
});

test('non-empty aggregates fully replace old rows — no stale duplicates left behind', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await insertMember(conn, { memberId: 'jane-doe', name: 'Jane Doe', chamber: 'house', fecCandidateId: 'H0DOE0001' });

    const firstFetcher = async (cid: string, cycle: number) => report(cid, cycle, 5000);
    await loadFecIe([2024], memberScope('jane-doe'), { conn, fetcher: firstFetcher });

    const secondFetcher = async (cid: string, cycle: number) => report(cid, cycle, 9000);
    await loadFecIe([2024], memberScope('jane-doe'), { conn, fetcher: secondFetcher });

    const rows = await snapshot(conn, "(SELECT * FROM super_pac_ie WHERE member_id='jane-doe')", 'member_id, cycle, committee_id');
    const parsed = JSON.parse(rows);
    assert.equal(parsed.length, 1, 'exactly one row survives — old one replaced, not duplicated');
    assert.equal(parsed[0].total_amount, 9000, 'the surviving row is the fresh one');
  } finally {
    cleanup();
  }
});

test('independence: non-empty aggregates + empty filings in one run → aggregates replaced AND filings preserved', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await insertMember(conn, { memberId: 'jane-doe', name: 'Jane Doe', chamber: 'house', fecCandidateId: 'H0DOE0001' });

    const firstFetcher = async (cid: string, cycle: number) =>
      report(cid, cycle, 5000, { filings: [filing('TX1', 5000)] });
    await loadFecIe([2024], memberScope('jane-doe'), { conn, fetcher: firstFetcher });
    const filingsBefore = await snapshot(conn, "(SELECT * FROM super_pac_ie_filings WHERE member_id='jane-doe')", 'member_id, cycle, transaction_id');
    assert.match(filingsBefore, /TX1/);

    // Same run: fresh non-empty aggregates, but zero itemized filings this time.
    const secondFetcher = async (cid: string, cycle: number) =>
      report(cid, cycle, 9000, { filings: [] });
    await loadFecIe([2024], memberScope('jane-doe'), { conn, fetcher: secondFetcher });

    const aggRows = JSON.parse(await snapshot(conn, "(SELECT * FROM super_pac_ie WHERE member_id='jane-doe')", 'member_id, cycle, committee_id'));
    assert.equal(aggRows.length, 1);
    assert.equal(aggRows[0].total_amount, 9000, 'aggregates replaced with the fresh non-empty set');

    const filingsAfter = await snapshot(conn, "(SELECT * FROM super_pac_ie_filings WHERE member_id='jane-doe')", 'member_id, cycle, transaction_id');
    assert.equal(filingsAfter, filingsBefore, 'filings preserved even though aggregates were replaced in the same run');
  } finally {
    cleanup();
  }
});

test('filings: undefined (non-itemized fetch) preserves existing filings and is distinguishable from filings: []', async () => {
  const { conn, cleanup } = await tempDb();
  try {
    await insertMember(conn, { memberId: 'jane-doe', name: 'Jane Doe', chamber: 'house', fecCandidateId: 'H0DOE0001' });

    // First run: itemized fetch with a real filing.
    const goodFetcher = async (cid: string, cycle: number) =>
      report(cid, cycle, 5000, { filings: [filing('TX1', 5000)] });
    await loadFecIe([2024], memberScope('jane-doe'), { conn, fetcher: goodFetcher });
    const before = await snapshot(conn, "(SELECT * FROM super_pac_ie_filings WHERE member_id='jane-doe')", 'member_id, cycle, transaction_id');
    assert.match(before, /TX1/);

    // Second run: a non-itemized fetch never requests filings — `filings` key absent.
    const nonItemizedFetcher = async (cid: string, cycle: number) => {
      const rep = report(cid, cycle, 5000, {});
      delete (rep as any).filings;
      return rep;
    };
    const { results } = await loadFecIe([2024], memberScope('jane-doe'), { conn, fetcher: nonItemizedFetcher });
    const after = await snapshot(conn, "(SELECT * FROM super_pac_ie_filings WHERE member_id='jane-doe')", 'member_id, cycle, transaction_id');
    assert.equal(after, before, 'existing filings preserved when the fetch never requested filings at all');
    assert.equal(results[0].filingsRequested, false, 'result distinguishes "not requested" from "requested and empty"');
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
