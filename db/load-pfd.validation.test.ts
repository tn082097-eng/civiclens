/**
 * PFD loader validation gate (pre-benchmark safety tranche, 2026-08-21).
 *
 * These pin the guarantee that an OCR-derived extraction cannot silently
 * corrupt the production transaction table:
 *
 *   1. invalid-but-plausible dates are rejected
 *   2. unknown / inverted transaction types are rejected
 *   3. unresolved fields never reach production insertion
 *   4. empty / partial / invalid input preserves existing rows
 *   5. fully valid input still follows the intended replacement path
 *
 * Context: `NoService/Projects/CivicLens/2026-08-21 OCR session reconciliation.md`.
 * The measured failure mode is a wrong-but-well-formed value (`2025-09-18` where
 * the source says `2025-07-18`), which every layer previously retained silently.
 *
 * Temp DuckDB + temp cache dir throughout; never data/civiclens.duckdb.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDb, insertMember, snapshot } from './__testkit__/temp-db.js';
import { loadPfdYear, classifyTransaction, classifyFiling } from './load-pfd.js';
import type { IngestScope } from '../lib/ingest-scope.js';

function memberScope(slug: string): IngestScope {
  return { kind: 'member', slug, bioguideId: 'X', memberId: slug, chamber: 'house' };
}

function writeFiling(cacheRoot: string, year: number, filing: any): void {
  const dir = join(cacheRoot, String(year));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${filing.filingId}.json`), JSON.stringify(filing));
}

/** A known-good transaction; individual fields get overridden per test. */
function goodTx(over: Record<string, unknown> = {}) {
  return {
    holder: 'self', asset: 'AAPL Inc', ticker: 'AAPL', assetType: 'ST',
    type: 'purchase', date: '2024-03-01', notificationDate: '2024-03-15',
    amountBand: '$1,001 - $15,000', filingStatus: 'New',
    ...over,
  };
}

function filingWith(filingId: string, name: string, sd: string, txs: any[]) {
  return {
    filingId, source: 'test',
    filer: { name, status: 'Member', stateDistrict: sd },
    signedAt: '2024-01-01',
    transactions: txs,
  };
}

async function seedMember(conn: any) {
  await insertMember(conn, {
    memberId: 'jane-doe', name: 'Jane Doe', chamber: 'house', state: 'CA', district: '12',
  });
}

// ─── 1. Invalid but plausible dates are rejected ────────────────────────────

test('plausible-but-impossible calendar dates are rejected, not coerced', () => {
  // These all match /^\d{4}-\d{2}-\d{2}$/ — a regex-only guard would pass them.
  for (const bad of ['2025-02-30', '2025-09-31', '2025-13-01', '2025-00-10', '2025-04-31']) {
    const v = classifyTransaction(goodTx({ date: bad }), 0);
    assert.equal(v.state, 'rejected', `${bad} must be rejected`);
    assert.match(v.problems.join(' '), /date/);
  }
});

test('well-formed real dates that violate cross-field invariants are rejected', () => {
  // notificationDate before the transaction it notifies — impossible in the
  // public record, and holds for 4,848/4,848 real cached rows.
  const back = classifyTransaction(
    goodTx({ date: '2024-03-15', notificationDate: '2024-03-01' }), 0);
  assert.equal(back.state, 'rejected');
  assert.match(back.problems.join(' '), /precedes/);

  // Out-of-range year: a 7→9 style OCR slip in the year field.
  const yr = classifyTransaction(
    goodTx({ date: '9024-03-01', notificationDate: '9024-03-15' }), 0);
  assert.equal(yr.state, 'rejected');
});

test('a wrong-but-valid date is NOT caught by the loader — the holdout is what catches it', () => {
  // Honest boundary: `2025-09-18` where the source says `2025-07-18` is a real
  // date and the loader cannot know it is wrong. This is precisely why the
  // frozen-holdout precision gate exists upstream of ingestion, and why this
  // tranche is "safety", not "correctness".
  const v = classifyTransaction(goodTx({ date: '2025-09-18', notificationDate: '2025-09-20' }), 0);
  assert.equal(v.state, 'verified');
});

// ─── 2. Unknown or inverted transaction types are rejected ──────────────────

test('unknown transaction types are rejected', () => {
  for (const bad of ['PURCHASE', 'Sale', 'buy', 'sold', 'x', 'purchase ', 'unknown', '']) {
    const v = classifyTransaction(goodTx({ type: bad }), 0);
    assert.notEqual(v.state, 'verified', `type ${JSON.stringify(bad)} must not be verified`);
  }
});

test('every transaction type present in the real corpus is accepted', () => {
  // Calibration guard: the enum must not be tighter than the actual record.
  for (const ok of ['purchase', 'sale', 'sale-partial', 'exchange']) {
    assert.equal(classifyTransaction(goodTx({ type: ok }), 0).state, 'verified', ok);
  }
});

test('an inverted-but-valid type is NOT caught here — column identity is a geometric check', () => {
  // The 2026-08-16 Docling inversion produced `sale` where the source said
  // `purchase`. Both are valid enum members, so the loader cannot detect it.
  // Recorded so nobody mistakes this gate for inversion protection.
  assert.equal(classifyTransaction(goodTx({ type: 'sale' }), 0).state, 'verified');
});

// ─── 3. Unresolved fields never reach production insertion ──────────────────

test('absent or blank required fields are unresolved, not rejected and not empty-string', () => {
  for (const k of ['holder', 'asset', 'type', 'date', 'notificationDate', 'amountBand']) {
    for (const empty of ['', '   ', null, undefined]) {
      const v = classifyTransaction(goodTx({ [k]: empty }), 0);
      assert.equal(v.state, 'unresolved', `${k}=${JSON.stringify(empty)} must be unresolved`);
    }
  }
});

test('unresolved rows never reach production insertion', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'pfd-cache-'));
  try {
    await seedMember(conn);
    // An abstained date — the OCR "I could not read this" case.
    writeFiling(cacheRoot, 2024, filingWith('F-1', 'Hon. Jane Doe', 'CA12', [
      goodTx({ date: '' }),
    ]));
    const res = await loadPfdYear(2024, memberScope('jane-doe'), { conn, cacheRoot });

    const rows = await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index');
    assert.equal(rows, '[]', 'no rows may be inserted');
    assert.equal(res.withheld.length, 1);
    assert.equal(res.withheld[0].state, 'unresolved');
  } finally { cleanup(); }
});

test('a filing is all-or-nothing: one bad row withholds the whole filing', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'pfd-cache-'));
  try {
    await seedMember(conn);
    // Two good rows, one impossible date. A partially-loaded filing would read
    // as a complete disclosure record, so none of it may load.
    writeFiling(cacheRoot, 2024, filingWith('F-1', 'Hon. Jane Doe', 'CA12', [
      goodTx({ ticker: 'AAPL' }),
      goodTx({ ticker: 'MSFT', date: '2025-02-30' }),
      goodTx({ ticker: 'GOOG' }),
    ]));
    const res = await loadPfdYear(2024, memberScope('jane-doe'), { conn, cacheRoot });

    const rows = await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index');
    assert.equal(rows, '[]', 'no partial insert');
    assert.equal(res.withheld[0].state, 'rejected');
  } finally { cleanup(); }
});

test('a filing missing identity is unresolved and never inserted', () => {
  assert.equal(classifyFiling({ filingId: '', filer: { name: 'Jane Doe' }, transactions: [goodTx()] }).state, 'unresolved');
  assert.equal(classifyFiling({ filingId: 'F-1', filer: { name: '' }, transactions: [goodTx()] }).state, 'unresolved');
});

// ─── 4. Empty / partial / invalid input preserves existing rows ─────────────

/** Load one good filing so there is existing production data to protect. */
async function seedExistingRows(conn: any, cacheRoot: string) {
  writeFiling(cacheRoot, 2024, filingWith('F-1', 'Hon. Jane Doe', 'CA12', [
    goodTx({ ticker: 'AAPL' }), goodTx({ ticker: 'MSFT' }),
  ]));
  await loadPfdYear(2024, memberScope('jane-doe'), { conn, cacheRoot });
  const before = await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index');
  assert.match(before, /AAPL/);
  return before;
}

test('invalid re-extraction preserves existing rows (no delete-then-fail)', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'pfd-cache-'));
  try {
    await seedMember(conn);
    const before = await seedExistingRows(conn, cacheRoot);

    // Same filing id re-extracted, now with an impossible date. The DELETE must
    // not fire: this is the FEC-IE silent-delete failure mode.
    writeFiling(cacheRoot, 2024, filingWith('F-1', 'Hon. Jane Doe', 'CA12', [
      goodTx({ ticker: 'AAPL', date: '2025-02-30' }),
    ]));
    const res = await loadPfdYear(2024, memberScope('jane-doe'), { conn, cacheRoot });

    const after = await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index');
    assert.equal(after, before, 'existing rows must survive an invalid re-extraction');
    assert.equal(res.withheld[0].state, 'rejected');
  } finally { cleanup(); }
});

test('unresolved re-extraction preserves existing rows', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'pfd-cache-'));
  try {
    await seedMember(conn);
    const before = await seedExistingRows(conn, cacheRoot);

    writeFiling(cacheRoot, 2024, filingWith('F-1', 'Hon. Jane Doe', 'CA12', [
      goodTx({ ticker: 'AAPL', notificationDate: '' }),
    ]));
    await loadPfdYear(2024, memberScope('jane-doe'), { conn, cacheRoot });

    assert.equal(
      await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index'), before,
      'existing rows must survive an abstaining re-extraction',
    );
  } finally { cleanup(); }
});

test('empty re-extraction preserves existing rows', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'pfd-cache-'));
  try {
    await seedMember(conn);
    const before = await seedExistingRows(conn, cacheRoot);

    // Zero transactions — indistinguishable from a failed OCR pass.
    writeFiling(cacheRoot, 2024, filingWith('F-1', 'Hon. Jane Doe', 'CA12', []));
    await loadPfdYear(2024, memberScope('jane-doe'), { conn, cacheRoot });

    assert.equal(
      await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index'), before,
      'an empty extraction must never wipe a populated filing',
    );
  } finally { cleanup(); }
});

test('partial re-extraction preserves existing rows rather than shrinking the filing', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'pfd-cache-'));
  try {
    await seedMember(conn);
    const before = await seedExistingRows(conn, cacheRoot);

    // Two good rows re-extracted as one good + one unreadable.
    writeFiling(cacheRoot, 2024, filingWith('F-1', 'Hon. Jane Doe', 'CA12', [
      goodTx({ ticker: 'AAPL' }),
      goodTx({ ticker: 'MSFT', amountBand: '' }),
    ]));
    await loadPfdYear(2024, memberScope('jane-doe'), { conn, cacheRoot });

    assert.equal(
      await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index'), before,
      'a partial extraction must not replace a complete filing',
    );
  } finally { cleanup(); }
});

// ─── 5. Fully valid input still follows the intended replacement path ───────

test('fully valid input replaces the filing (replacement path intact)', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'pfd-cache-'));
  try {
    await seedMember(conn);
    await seedExistingRows(conn, cacheRoot);

    // Re-extract the same filing with different, fully valid content.
    writeFiling(cacheRoot, 2024, filingWith('F-1', 'Hon. Jane Doe', 'CA12', [
      goodTx({ ticker: 'TSLA', asset: 'Tesla Inc', type: 'sale-partial' }),
    ]));
    const res = await loadPfdYear(2024, memberScope('jane-doe'), { conn, cacheRoot });

    const after = await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index');
    assert.match(after, /TSLA/, 'new content must land');
    assert.doesNotMatch(after, /AAPL/, 'superseded rows must be replaced, not accumulated');
    assert.doesNotMatch(after, /MSFT/);
    assert.equal(res.withheld.length, 0);
  } finally { cleanup(); }
});

test('valid amount bands pass and malformed ones are rejected', () => {
  for (const ok of ['$1,001 - $15,000', '$50,001 - $100,000', '$5,000,001 - $25,000,000', '$1,000']) {
    assert.equal(classifyTransaction(goodTx({ amountBand: ok }), 0).state, 'verified', ok);
  }
  for (const bad of ['15,000 - 1,001', '$15,000 - $1,001', 'unknown', '$$1,000', '1001-15000']) {
    assert.notEqual(classifyTransaction(goodTx({ amountBand: bad }), 0).state, 'verified', bad);
  }
});

// ─── A2 repair: zero-row filings must be reported, not silently skipped ────
// `classifyFiling` has always had a correct zero-row branch, but the loader's
// early `continue` fired first, so the branch was unreachable and such
// filings never appeared in `withheld`. A silent skip is indistinguishable
// from a clean run — which is exactly how the 19 launch filings loaded empty.

test('a zero-row filing is reported as withheld, not silently skipped', async () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'pfd-cache-'));
  const { conn, cleanup } = await tempDb();
  try {
    await seedMember(conn);
    writeFiling(cacheRoot, 2024, {
      filingId: 'F-EMPTY', filer: { name: 'Jane Doe', stateDistrict: 'CA12' },
      transactions: [],
    });
    const res = await loadPfdYear(2024, memberScope('jane-doe'), { conn, cacheRoot });
    assert.equal(res.totalTx, 0, 'nothing loaded');
    assert.equal(res.withheld.length, 1, 'the filing is accounted for, not dropped');
    assert.equal(res.withheld[0].filingId, 'F-EMPTY');
    assert.equal(res.withheld[0].state, 'unresolved');
    assert.match(res.withheld[0].problems.join(' '), /zero rows/);
  } finally {
    await cleanup();
  }
});

test('a zero-row re-extraction preserves the existing rows for that filing', async () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'pfd-cache-'));
  const { conn, cleanup } = await tempDb();
  try {
    await seedMember(conn);
    writeFiling(cacheRoot, 2024, {
      filingId: 'F-1', filer: { name: 'Jane Doe', stateDistrict: 'CA12' },
      transactions: [goodTx()],
    });
    await loadPfdYear(2024, memberScope('jane-doe'), { conn, cacheRoot });
    const before = await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index');

    // The same filing now extracts to zero rows — this must never DELETE.
    writeFiling(cacheRoot, 2024, {
      filingId: 'F-1', filer: { name: 'Jane Doe', stateDistrict: 'CA12' },
      transactions: [],
    });
    const res = await loadPfdYear(2024, memberScope('jane-doe'), { conn, cacheRoot });
    const after = await snapshot(conn, 'pfd_transactions', 'filing_id, tx_index');
    assert.equal(after, before, 'existing rows survive a zero-row re-extraction');
    assert.equal(res.withheld.length, 1, 'and the filing is reported, not skipped');
  } finally {
    await cleanup();
  }
});

test('a filing missing its identity is reported as withheld', async () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'pfd-cache-'));
  const { conn, cleanup } = await tempDb();
  try {
    await seedMember(conn);
    writeFiling(cacheRoot, 2024, {
      filingId: '', filer: { name: 'Jane Doe', stateDistrict: 'CA12' },
      transactions: [goodTx()],
    });
    const res = await loadPfdYear(2024, memberScope('jane-doe'), { conn, cacheRoot });
    assert.equal(res.totalTx, 0, 'a filing with no id cannot scope a replacement');
    assert.equal(res.withheld.length, 1, 'and is not silently dropped');
    assert.equal(res.withheld[0].state, 'unresolved');
    assert.match(res.withheld[0].problems.join(' '), /filingId/);
  } finally {
    await cleanup();
  }
});
