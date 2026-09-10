import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSenateSearchReceipt,
  writeCompleteSenateSearchReceipt,
  writeSenateSearchReceipt,
} from './senate-ptr-receipt.js';

test('a successful Senate PTR search is recorded as a target- and range-specific receipt', () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'senate-receipt-'));
  try {
    writeSenateSearchReceipt(cacheRoot, {
      bioguideId: 'C001096',
      canonicalName: 'Kevin Cramer',
      fromYear: 2023,
      toYear: 2026,
      filingIds: [],
      fetchedAt: '2026-09-09T12:00:00.000Z',
    });

    const raw = JSON.parse(readFileSync(
      join(cacheRoot, '_search-receipts', 'C001096.json'),
      'utf8',
    ));
    assert.deepEqual(raw, {
      schemaVersion: 1,
      kind: 'senate-ptr-search',
      status: 'success',
      bioguideId: 'C001096',
      canonicalName: 'Kevin Cramer',
      fromYear: 2023,
      toYear: 2026,
      filingIds: [],
      filingCount: 0,
      sourceUrl: 'https://efdsearch.senate.gov/search/report/data/',
      fetchedAt: '2026-09-09T12:00:00.000Z',
    });
    assert.deepEqual(readSenateSearchReceipt(cacheRoot, 'C001096'), raw);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('a malformed Senate search receipt is rejected rather than treated as evidence', () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'senate-receipt-'));
  try {
    assert.throws(
      () => writeSenateSearchReceipt(cacheRoot, {
        bioguideId: 'C001096',
        canonicalName: 'Kevin Cramer',
        fromYear: 2026,
        toYear: 2023,
        filingIds: [],
        fetchedAt: '2026-09-09T12:00:00.000Z',
      }),
      /invalid Senate PTR search year range/,
    );
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('an incomplete PTR download does not replace an earlier successful receipt', () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'senate-receipt-'));
  try {
    const original = writeSenateSearchReceipt(cacheRoot, {
      bioguideId: 'C001096',
      canonicalName: 'Kevin Cramer',
      fromYear: 2023,
      toYear: 2025,
      filingIds: [],
      fetchedAt: '2026-09-08T12:00:00.000Z',
    });

    const result = writeCompleteSenateSearchReceipt(cacheRoot, {
      bioguideId: 'C001096',
      canonicalName: 'Kevin Cramer',
      fromYear: 2023,
      toYear: 2026,
      filingIds: ['S-FOUND-1', 'S-FOUND-2'],
      completedFilingIds: ['S-FOUND-1'],
      fetchedAt: '2026-09-09T12:00:00.000Z',
    });

    assert.equal(result, null);
    assert.deepEqual(readSenateSearchReceipt(cacheRoot, 'C001096'), original);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});
