import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readSenateSearchReceipt } from '../../lib/senate-ptr-receipt.js';
import { fetchSenatePtrs } from './fetch.js';

const FILING_ID = 'ab93dc59-4217-40a6-bee8-ba19deae027a';

/**
 * Fake EFDS. Like the real index, it matches the filer's recorded first/last
 * name exactly: the filer is "Susan Collins", so a "Susan M." query finds
 * nothing even though she filed a PTR.
 */
function mockEfds(t: any, queries: Array<Array<string | null>>) {
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/search/home/')) {
      return new Response('<input name="csrfmiddlewaretoken" value="test-token">');
    }
    assert.ok(url.endsWith('/search/report/data/'));
    const body = new URLSearchParams(String(init?.body));
    const first = body.get('first_name'), last = body.get('last_name');
    queries.push([first, last]);
    const data = first === 'Susan' && last === 'Collins'
      ? [['Susan', 'Collins', 'Senator',
          `<a href="/search/view/ptr/${FILING_ID}/">PTR</a>`, '03/02/2026']]
      : [];
    return Response.json({ result: 'ok', data });
  });
}

function tempCache(t: any): string {
  const cacheDir = mkdtempSync(join(tmpdir(), 'civiclens-senate-search-'));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  return cacheDir;
}

test('member-ID search uses the verified first/last names and records the found filings', async t => {
  const cacheDir = tempCache(t);
  const queries: Array<Array<string | null>> = [];
  mockEfds(t, queries);
  // Pre-cache the filing so the test does not need the PTR HTML page.
  mkdirSync(join(cacheDir, '2026'), { recursive: true });
  writeFileSync(join(cacheDir, '2026', `susan-m-collins-${FILING_ID}.json`), '{}');

  const target = { bioguideId: 'C001035', canonicalName: 'Susan M. Collins', first: 'Susan', last: 'Collins' };
  const result = await fetchSenatePtrs([target.canonicalName], {
    fromYear: 2026, toYear: 2026, cacheDir,
    receiptTargets: new Map([[target.canonicalName, target]]),
  });

  assert.equal(result.errors, 0);
  assert.equal(result.unconfirmedEmpty, 0);
  assert.deepEqual(queries, [['Susan', 'Collins']]);
  const receipt = readSenateSearchReceipt(cacheDir, target.bioguideId);
  assert.equal(receipt?.canonicalName, target.canonicalName);
  assert.deepEqual(receipt?.filingIds, [FILING_ID]);
});

test('regression: a zero-result name search does not write a verified-empty receipt', async t => {
  // Reproduces the 2026-11-24 false empty: querying the display name
  // "Susan M." / "Collins" returned zero rows although she had three PTRs, and
  // the old fetcher recorded that as a successful zero-filing search.
  const cacheDir = tempCache(t);
  const queries: Array<Array<string | null>> = [];
  mockEfds(t, queries);

  const target = { bioguideId: 'C001035', canonicalName: 'Susan M. Collins', first: 'Susan M.', last: 'Collins' };
  const result = await fetchSenatePtrs([target.canonicalName], {
    fromYear: 2026, toYear: 2026, cacheDir,
    receiptTargets: new Map([[target.canonicalName, target]]),
  });

  assert.deepEqual(queries, [['Susan M.', 'Collins']]);
  assert.equal(result.unconfirmedEmpty, 1);
  assert.equal(readSenateSearchReceipt(cacheDir, target.bioguideId), null);
  assert.equal(existsSync(join(cacheDir, '_search-receipts', 'C001035.json')), false);
});
