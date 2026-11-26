import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readSenateEmptyCertificate, readSenateSearchReceipt } from '../../lib/senate-ptr-receipt.js';
import { fetchSenatePtrs } from './fetch.js';

const FILING_ID = 'ab93dc59-4217-40a6-bee8-ba19deae027a';

const COLLINS_ROW = ['Susan', 'Collins', 'Collins, Susan M. (Senator)',
  `<a href="/search/view/ptr/${FILING_ID}/">Periodic Transaction Report for 03/02/2026</a>`, '03/02/2026'];
const OTHER_ROW = ['RICHARD ', 'BLUMENTHAL', 'Senator',
  '<a href="/search/view/paper/0f0f0f0f-1111-2222-3333-444444444444/">Periodic Transaction Report for 05/19/2026</a>',
  '05/19/2026'];

/**
 * Fake EFDS. Like the real index, it matches the filer's recorded first/last
 * name exactly: the filer is "Susan Collins", so a "Susan M." query finds
 * nothing even though she filed a PTR. A name-free `report_types=[11]` query
 * is the chamber-wide PTR index.
 */
function mockEfds(t: any, queries: Array<Array<string | null>>) {
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/search/home/')) {
      return new Response('<input name="csrfmiddlewaretoken" value="test-token">');
    }
    assert.ok(url.endsWith('/search/report/data/'));
    const body = new URLSearchParams(String(init?.body));
    const first = body.get('first_name'), last = body.get('last_name');
    if (!first && !last && body.get('report_types') === '[11]') {
      queries.push(['<index>', `${body.get('submitted_start_date')}..${body.get('submitted_end_date')}`]);
      const data = [COLLINS_ROW, OTHER_ROW];
      return Response.json({ result: 'ok', recordsTotal: data.length, recordsFiltered: data.length, data });
    }
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

test('regression: a zero-result name search is not certified empty when the index lists the surname', async t => {
  // Reproduces the 2026-11-24 false empty: querying the display name
  // "Susan M." / "Collins" returned zero rows although she had three PTRs, and
  // the old fetcher recorded that as a successful zero-filing search. The
  // chamber-wide index lists her filing under "Collins", which blocks it.
  const cacheDir = tempCache(t);
  const queries: Array<Array<string | null>> = [];
  mockEfds(t, queries);

  const target = { bioguideId: 'C001035', canonicalName: 'Susan M. Collins', first: 'Susan M.', last: 'Collins' };
  const result = await fetchSenatePtrs([target.canonicalName], {
    fromYear: 2026, toYear: 2026, cacheDir,
    receiptTargets: new Map([[target.canonicalName, target]]),
  });

  assert.deepEqual(queries, [['Susan M.', 'Collins'], ['<index>', '01/01/2026 00:00:00..12/31/2026 23:59:59']]);
  assert.equal(result.unconfirmedEmpty, 1);
  assert.equal(result.verifiedEmpty, 0);
  assert.equal(readSenateSearchReceipt(cacheDir, target.bioguideId), null);
  assert.equal(existsSync(join(cacheDir, '_search-receipts', 'C001035.json')), false);
  assert.equal(existsSync(join(cacheDir, '_search-receipts', 'C001035.empty.json')), false);
});

test('a zero-result search is verified-empty only when the complete index has no filing under the surname', async t => {
  const cacheDir = tempCache(t);
  const queries: Array<Array<string | null>> = [];
  mockEfds(t, queries);

  const target = { bioguideId: 'V000128', canonicalName: 'Chris Van Hollen', first: 'Chris', last: 'Van Hollen' };
  const result = await fetchSenatePtrs([target.canonicalName], {
    fromYear: 2026, toYear: 2026, cacheDir,
    receiptTargets: new Map([[target.canonicalName, target]]),
  });

  assert.equal(result.errors, 0);
  assert.equal(result.unconfirmedEmpty, 0);
  assert.equal(result.verifiedEmpty, 1);
  assert.equal(readSenateSearchReceipt(cacheDir, target.bioguideId), null);
  const verified = readSenateEmptyCertificate(cacheDir, target.bioguideId, () => ['hollen']);
  assert.equal(verified?.certificate.index.filingCount, 2);
  assert.deepEqual(verified?.certificate.surnameTokens, ['hollen']);
});

test('a name search without an official identity is never certified empty', async t => {
  const cacheDir = tempCache(t);
  const queries: Array<Array<string | null>> = [];
  mockEfds(t, queries);

  const result = await fetchSenatePtrs(['Chris Van Hollen'], { fromYear: 2026, toYear: 2026, cacheDir });

  assert.equal(result.unconfirmedEmpty, 1);
  assert.equal(result.verifiedEmpty, 0);
  assert.deepEqual(queries, [['Chris Van', 'Hollen']]);
});
