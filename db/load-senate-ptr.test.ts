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
import { tempDb, insertMember, snapshot } from './__testkit__/temp-db.js';
import { loadSenatePtrs } from './load-senate-ptr.js';
import type { IngestScope } from '../lib/ingest-scope.js';

function senatorScope(slug: string): IngestScope {
  return { kind: 'member', slug, bioguideId: 'X', memberId: slug, chamber: 'senate' };
}

function writeSearchReceipt(
  cacheRoot: string,
  overrides: Partial<{
    bioguideId: string;
    canonicalName: string;
    filingIds: string[];
    filingCount: number;
  }> = {},
): void {
  const dir = join(cacheRoot, '_search-receipts');
  mkdirSync(dir, { recursive: true });
  const receipt = {
    schemaVersion: 1,
    kind: 'senate-ptr-search',
    status: 'success',
    bioguideId: overrides.bioguideId ?? 'X',
    canonicalName: overrides.canonicalName ?? 'Maria Cantwell',
    fromYear: 2023,
    toYear: 2026,
    filingIds: overrides.filingIds ?? [],
    filingCount: overrides.filingCount ?? overrides.filingIds?.length ?? 0,
    sourceUrl: 'https://efdsearch.senate.gov/search/report/data/',
    fetchedAt: '2026-09-09T12:00:00.000Z',
  };
  writeFileSync(join(dir, 'X.json'), JSON.stringify(receipt));
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

test('member mode accepts a source-verified empty Senate PTR search and changes no rows', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'senate-cache-'));
  try {
    await insertMember(conn, { memberId: 'maria-cantwell', name: 'Maria Cantwell', chamber: 'senate', state: 'WA' });
    writeSearchReceipt(cacheRoot);
    const before = await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index');

    const result = await loadSenatePtrs(senatorScope('maria-cantwell'), { conn, cacheRoot });

    assert.equal(result.verifiedEmpty, true);
    assert.equal(result.totalTx, 0);
    assert.equal(result.targetMatched, 0);
    assert.equal(await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index'), before);
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('member mode rejects an empty cache without a successful search receipt', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'senate-cache-'));
  try {
    await assert.rejects(
      loadSenatePtrs(senatorScope('maria-cantwell'), { conn, cacheRoot }),
      /successful Senate PTR search receipt/,
    );
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('member mode rejects a verified-empty receipt for another bioguide', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'senate-cache-'));
  try {
    writeSearchReceipt(cacheRoot, { bioguideId: 'Y' });
    await assert.rejects(
      loadSenatePtrs(senatorScope('maria-cantwell'), { conn, cacheRoot }),
      /does not match target bioguide X/,
    );
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('all mode cannot use a member receipt to treat an empty cache as verified empty', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'senate-cache-'));
  try {
    writeSearchReceipt(cacheRoot);
    await assert.rejects(
      loadSenatePtrs({ kind: 'all' }, { conn, cacheRoot }),
      /No year directories/,
    );
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('member mode rejects a receipt whose indexed filing JSON is missing', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'senate-cache-'));
  try {
    writeSearchReceipt(cacheRoot, { filingIds: ['S-MISSING-1'] });
    await assert.rejects(
      loadSenatePtrs(senatorScope('maria-cantwell'), { conn, cacheRoot }),
      /indexed filing JSON missing.*S-MISSING-1/,
    );
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('member mode reports a zero-transaction indexed filing as unresolved', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'senate-cache-'));
  try {
    await insertMember(conn, { memberId: 'maria-cantwell', name: 'Maria Cantwell', chamber: 'senate', state: 'WA' });
    writeSearchReceipt(cacheRoot, { filingIds: ['S-EMPTY-1'] });
    writeFiling(cacheRoot, 2024, {
      ...filing('S-EMPTY-1', 'Maria', 'Cantwell', 'AAPL'),
      transactions: [],
    });

    await assert.rejects(
      loadSenatePtrs(senatorScope('maria-cantwell'), { conn, cacheRoot }),
      /S-EMPTY-1.*zero transactions.*unresolved/,
    );
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('a zero-transaction filing is rejected before an earlier target filing can commit', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'senate-cache-'));
  try {
    await insertMember(conn, { memberId: 'maria-cantwell', name: 'Maria Cantwell', chamber: 'senate', state: 'WA' });
    writeSearchReceipt(cacheRoot, { filingIds: ['S-GOOD-1', 'S-EMPTY-1'] });
    writeFiling(cacheRoot, 2023, filing('S-GOOD-1', 'Maria', 'Cantwell', 'AAPL'));
    writeFiling(cacheRoot, 2024, {
      ...filing('S-EMPTY-1', 'Maria', 'Cantwell', 'MSFT'),
      transactions: [],
    });
    const before = await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index');

    await assert.rejects(
      loadSenatePtrs(senatorScope('maria-cantwell'), { conn, cacheRoot }),
      /S-EMPTY-1.*zero transactions.*unresolved/,
    );

    assert.equal(
      await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index'),
      before,
      'the valid earlier filing must not commit when the member batch is unresolved',
    );
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});
