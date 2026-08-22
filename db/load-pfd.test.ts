/**
 * PFD member-scope tests (Phase 1B.1). A two-member fixture proves that a
 * member-scoped load writes ONLY the target's filings and leaves every other
 * member's rows byte-for-byte unchanged. Uses a temp DuckDB + a temp cache dir;
 * never data/civiclens.duckdb.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDb, insertMember, snapshot } from './__testkit__/temp-db.js';
import { loadPfdYear } from './load-pfd.js';
import type { IngestScope } from '../lib/ingest-scope.js';

function memberScope(slug: string): IngestScope {
  return { kind: 'member', slug, bioguideId: 'X', memberId: slug, chamber: 'house' };
}

/** Write one PFD filing JSON into <cacheRoot>/<year>/<filingId>.json. */
function writeFiling(cacheRoot: string, year: number, filing: any): void {
  const dir = join(cacheRoot, String(year));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${filing.filingId}.json`), JSON.stringify(filing));
}

function filing(filingId: string, name: string, sd: string, ticker: string) {
  return {
    filingId, source: 'test',
    filer: { name, status: 'Member', stateDistrict: sd },
    signedAt: '2024-01-01',
    transactions: [
      // notificationDate is present on 4,848/4,848 real cached House PFD
      // transactions and is required by the loader's validation gate
      // (db/load-pfd.ts), so the fixture carries it too.
      { holder: 'self', asset: `${ticker} Inc`, ticker, assetType: 'ST',
        type: 'purchase', date: '2024-03-01', notificationDate: '2024-03-15',
        amountBand: '$1,001 - $15,000' },
    ],
  };
}

async function seedTwoMembers(conn: any) {
  await insertMember(conn, { memberId: 'jane-doe', name: 'Jane Doe', chamber: 'house', state: 'CA', district: '12' });
  await insertMember(conn, { memberId: 'john-roe', name: 'John Roe', chamber: 'house', state: 'NY', district: '3' });
}

test('member mode writes only the target filings; other member rows unchanged', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'pfd-cache-'));
  try {
    await seedTwoMembers(conn);
    writeFiling(cacheRoot, 2024, filing('F-DOE-1', 'Hon. Jane Doe', 'CA12', 'AAPL'));
    writeFiling(cacheRoot, 2024, filing('F-ROE-1', 'Hon. John Roe', 'NY03', 'MSFT'));

    // First: load John Roe so his rows exist, then snapshot them.
    await loadPfdYear(2024, memberScope('john-roe'), { conn, cacheRoot });
    const roeBefore = await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index');
    assert.match(roeBefore, /F-ROE-1/);
    assert.doesNotMatch(roeBefore, /F-DOE-1/);

    // Now load Jane Doe. John Roe's rows must be untouched.
    const res = await loadPfdYear(2024, memberScope('jane-doe'), { conn, cacheRoot });
    const all = await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index');
    assert.match(all, /F-DOE-1/, 'target filing written');
    // John Roe rows still present and identical to before.
    const roeAfter = await snapshot(
      conn, '(SELECT * FROM pfd_transactions WHERE member_id = \'john-roe\')', 'filing_id, tx_index',
    );
    assert.equal(roeAfter, roeBefore, 'other-member rows byte-identical after target load');
    assert.equal(res.unmatched, 0);
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('member mode ignores unrelated unmatched filers (no failure, no writes for them)', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'pfd-cache-'));
  try {
    await seedTwoMembers(conn);
    writeFiling(cacheRoot, 2024, filing('F-DOE-1', 'Hon. Jane Doe', 'CA12', 'AAPL'));
    // An unrelated filer with no members row at all (would be "unmatched" in all-mode).
    writeFiling(cacheRoot, 2024, filing('F-STRANGER', 'Hon. Someone Else', 'TX99', 'TSLA'));

    const res = await loadPfdYear(2024, memberScope('jane-doe'), { conn, cacheRoot });
    const all = await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index');
    assert.match(all, /F-DOE-1/);
    assert.doesNotMatch(all, /F-STRANGER/, 'unrelated filer never written in member mode');
    assert.equal(res.unmatched, 0, 'unrelated unmatched filers do not fail a member run');
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('member mode with zero matching target filings is an explicit result, not silent success', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'pfd-cache-'));
  try {
    await seedTwoMembers(conn);
    writeFiling(cacheRoot, 2024, filing('F-ROE-1', 'Hon. John Roe', 'NY03', 'MSFT'));

    const res = await loadPfdYear(2024, memberScope('jane-doe'), { conn, cacheRoot });
    assert.equal(res.totalTx, 0, 'no target transactions');
    assert.equal(res.targetMatched, 0, 'zero target filings surfaced explicitly');
    const all = await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index');
    assert.doesNotMatch(all, /F-ROE-1/, 'non-target filing not written under member scope');
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('all mode writes every filer', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'pfd-cache-'));
  try {
    await seedTwoMembers(conn);
    writeFiling(cacheRoot, 2024, filing('F-DOE-1', 'Hon. Jane Doe', 'CA12', 'AAPL'));
    writeFiling(cacheRoot, 2024, filing('F-ROE-1', 'Hon. John Roe', 'NY03', 'MSFT'));

    await loadPfdYear(2024, { kind: 'all' }, { conn, cacheRoot });
    const all = await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index');
    assert.match(all, /F-DOE-1/);
    assert.match(all, /F-ROE-1/);
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});
