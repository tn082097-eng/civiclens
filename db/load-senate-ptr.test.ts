/**
 * Senate PTR member-scope tests (Phase 1B.2). Proves a member-scoped load writes
 * only the resolved senator's filings and cannot write another senator's rows,
 * even though the cache is arranged by year. Temp DuckDB + temp cache dir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDb, insertMember, snapshot } from './__testkit__/temp-db.ts';
import { loadSenatePtrs } from './load-senate-ptr.ts';
import type { IngestScope } from '../lib/ingest-scope.ts';

function senatorScope(slug: string): IngestScope {
  return { kind: 'member', slug, bioguideId: 'X', memberId: slug, chamber: 'senate' };
}

function writeFiling(cacheRoot: string, year: number, filing: any): void {
  const dir = join(cacheRoot, String(year));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${filing.filingId}.json`), JSON.stringify(filing));
}

function filing(filingId: string, first: string, last: string, ticker: string) {
  return {
    filingId, source: 'test', ptrUrl: `https://efdsearch.senate.gov/${filingId}`,
    filer: { firstName: first, lastName: last }, dateReceived: '2024-02-01',
    transactions: [
      { transactionDate: '2024-03-01', owner: 'self', ticker, asset: `${ticker} Inc`,
        assetType: 'Stock', type: 'Purchase', amountBand: '$1,001 - $15,000' },
    ],
  };
}

async function seedTwoSenators(conn: any) {
  await insertMember(conn, { memberId: 'maria-cantwell', name: 'Maria Cantwell', chamber: 'senate', state: 'WA' });
  await insertMember(conn, { memberId: 'patty-murray', name: 'Patty Murray', chamber: 'senate', state: 'WA' });
}

test('senate member mode writes only the target; other senator rows unchanged', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'senate-cache-'));
  try {
    await seedTwoSenators(conn);
    writeFiling(cacheRoot, 2024, filing('S-CANT-1', 'Maria', 'Cantwell', 'AAPL'));
    writeFiling(cacheRoot, 2024, filing('S-MURR-1', 'Patty', 'Murray', 'MSFT'));

    await loadSenatePtrs(senatorScope('patty-murray'), { conn, cacheRoot });
    const murrayBefore = await snapshot(
      conn, "(SELECT * FROM pfd_transactions WHERE member_id = 'patty-murray')", 'filing_id, tx_index');
    assert.match(murrayBefore, /S-MURR-1/);

    await loadSenatePtrs(senatorScope('maria-cantwell'), { conn, cacheRoot });
    const all = await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index');
    assert.match(all, /S-CANT-1/, 'target written');
    const murrayAfter = await snapshot(
      conn, "(SELECT * FROM pfd_transactions WHERE member_id = 'patty-murray')", 'filing_id, tx_index');
    assert.equal(murrayAfter, murrayBefore, 'other senator rows byte-identical');
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('senate member mode cannot write another senator (no cross-write across year dirs)', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'senate-cache-'));
  try {
    await seedTwoSenators(conn);
    writeFiling(cacheRoot, 2023, filing('S-MURR-OLD', 'Patty', 'Murray', 'TSLA'));
    writeFiling(cacheRoot, 2024, filing('S-CANT-1', 'Maria', 'Cantwell', 'AAPL'));

    const res = await loadSenatePtrs(senatorScope('maria-cantwell'), { conn, cacheRoot });
    const all = await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index');
    assert.doesNotMatch(all, /S-MURR-OLD/, 'other senator (different year) never written');
    assert.match(all, /S-CANT-1/);
    assert.equal(res.unmatched, 0);
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('senate all mode writes every senator', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'senate-cache-'));
  try {
    await seedTwoSenators(conn);
    writeFiling(cacheRoot, 2024, filing('S-CANT-1', 'Maria', 'Cantwell', 'AAPL'));
    writeFiling(cacheRoot, 2024, filing('S-MURR-1', 'Patty', 'Murray', 'MSFT'));

    await loadSenatePtrs({ kind: 'all' }, { conn, cacheRoot });
    const all = await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index');
    assert.match(all, /S-CANT-1/);
    assert.match(all, /S-MURR-1/);
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});
