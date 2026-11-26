import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectSenatePtrIndex,
  findSurnameCandidates,
  identitySurnameTokens,
  parseSenateIndexRow,
  validateSenatePtrIndex,
  type SenateIndexPageFetcher,
} from './senate-ptr-index.js';

const AT = '2026-11-26T12:00:00.000Z';

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function row(n: number, date: string, first = 'Pat', last = `Filer${n}`, kind = 'ptr', office?: string) {
  const [y, m, d] = date.split('-');
  return [first, last, office ?? `${last}, ${first} (Senator)`,
    `<a href="/search/view/${kind}/${uuid(n)}/">Periodic Transaction Report for ${m}/${d}/${y}</a>`,
    `${m}/${d}/${y}`];
}

/** Fake EFDS that answers by date window from a fixed row set, honoring the 100-row page cap. */
function fakeIndex(rows: unknown[][], opts: { overlap?: boolean } = {}) {
  const windows: string[] = [];
  const fetchPage: SenateIndexPageFetcher = async ({ from, to }) => {
    windows.push(`${from}..${to}`);
    const inWindow = rows.filter(r => {
      const [m, d, y] = String(r[4]).split('/');
      const iso = `${y}-${m}-${d}`;
      return iso >= from && iso <= to;
    });
    const page = inWindow.slice(0, 100);
    // The real endpoint's pages can repeat rows; simulate a repeated row.
    if (opts.overlap && page.length > 1) page[page.length - 1] = page[0];
    return { recordsTotal: inWindow.length, data: page };
  };
  return { fetchPage, windows };
}

test('a window over the page limit is split by date until each window fits one page', async () => {
  const rows = Array.from({ length: 150 }, (_, i) =>
    row(i, `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`));
  const { fetchPage, windows } = fakeIndex(rows);
  const index = await collectSenatePtrIndex(fetchPage, 2026, 2026, AT);

  assert.equal(index.filingCount, 150);
  assert.ok(windows.length > 1);
  assert.equal(index.windows.reduce((n, w) => n + w.recordsTotal, 0), 150);
  assert.equal(index.windows[0].from, '2026-01-01');
  assert.equal(index.windows.at(-1)!.to, '2026-12-31');
  assert.deepEqual(validateSenatePtrIndex(structuredClone(index)), index);
});

test('a page that repeats a row instead of listing every filing rejects the index', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(i, '2026-03-02'));
  const { fetchPage } = fakeIndex(rows, { overlap: true });
  await assert.rejects(collectSenatePtrIndex(fetchPage, 2026, 2026, AT),
    /returned 20 rows \(19 distinct\) for recordsTotal 20/);
});

test('a non-PTR row means the report filter was not applied and rejects the index', () => {
  const annual = ['Susan M', 'Collins', 'Collins, Susan M. (Senator)',
    '<a href="/search/view/annual/2cf70262-d7c1-42e3-b171-a9a81976d919/">Annual Report for CY 2025</a>',
    '05/15/2026'];
  assert.throws(() => parseSenateIndexRow(annual), /not a PTR/);
});

test('more PTRs on one day than one page holds cannot be listed completely', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => row(i, '2026-05-15'));
  const { fetchPage } = fakeIndex(rows);
  await assert.rejects(collectSenatePtrIndex(fetchPage, 2026, 2026, AT),
    /lists 101 PTRs on 2026-05-15, more than one page holds/);
});

test('an empty chamber-wide index is a source failure, not evidence', async () => {
  const { fetchPage } = fakeIndex([]);
  await assert.rejects(collectSenatePtrIndex(fetchPage, 2026, 2026, AT), /index for 2026-2026 is empty/);
});

test('a stored index whose filings were edited fails its digest', async () => {
  const { fetchPage } = fakeIndex([row(1, '2026-02-01'), row(2, '2026-03-01')]);
  const index = await collectSenatePtrIndex(fetchPage, 2026, 2026, AT);
  const tampered = structuredClone(index);
  tampered.filings = tampered.filings.slice(1);
  tampered.filingCount = 1;
  assert.throws(() => validateSenatePtrIndex(tampered), /digest does not match/);
});

test('surname candidates ignore first names, include paper filings, and read the office name', async () => {
  const { fetchPage } = fakeIndex([
    row(1, '2026-03-02', 'Susan M', 'Collins'),
    row(2, '2026-05-19', 'RICHARD ', 'BLUMENTHAL', 'paper', 'Senator'),
    row(3, '2026-06-01', 'Chris', 'Hollen', 'ptr', 'Hollen, Chris Van (Senator)'),
  ]);
  const index = await collectSenatePtrIndex(fetchPage, 2026, 2026, AT);

  const collins = identitySurnameTokens({ last: 'Collins', officialFull: 'Susan M. Collins' });
  assert.deepEqual(collins, ['collins']);
  assert.deepEqual(findSurnameCandidates(index, collins).map(f => f.filingId), [uuid(1)]);

  assert.deepEqual(findSurnameCandidates(index, ['blumenthal']).map(f => f.kind), ['paper']);

  const vanHollen = identitySurnameTokens({ last: 'Van Hollen', officialFull: 'Chris Van Hollen' });
  assert.deepEqual(vanHollen, ['hollen']);
  assert.equal(findSurnameCandidates(index, vanHollen).length, 1);

  assert.deepEqual(identitySurnameTokens({ last: 'McConnell', officialFull: 'Mitch McConnell' }), ['mcconnell']);
  assert.deepEqual(findSurnameCandidates(index, ['mcconnell']), []);
});

test('frozen EFDS responses: every PTR row parses, paper rows count, an annual row is rejected', async () => {
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const dir = 'fixtures/senate-ptr/efds-index-2026-11-26';
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8'));
  const load = (file: string) => {
    const bytes = readFileSync(`${dir}/${file}`);
    const entry = manifest.files.find((f: any) => f.file === file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, file);
    return JSON.parse(bytes.toString('utf8'));
  };
  const h1 = load('ptr-anyfiler-2026H1.json'), h2 = load('ptr-anyfiler-2026H2.json');
  const year = load('ptr-anyfiler-2026.json');
  assert.equal(h1.recordsTotal + h2.recordsTotal, year.recordsTotal);
  assert.equal(year.data.length, 100, 'one page is capped at 100 rows');

  const filings = [...h1.data, ...h2.data].map(parseSenateIndexRow);
  assert.equal(new Set(filings.map(f => f.filingId)).size, 148);
  assert.ok(filings.some(f => f.kind === 'paper'));
  const index = { filings };
  assert.equal(findSurnameCandidates(index, ['collins']).length, 3);
  assert.deepEqual(
    [...new Set(findSurnameCandidates(index, ['blumenthal']).map(f => f.kind))].sort(), ['paper', 'ptr']);
  assert.equal(findSurnameCandidates(index, ['hollen']).length, 0);

  const leaked = load('all-2026-last-collins.json');
  assert.ok(leaked.data.some((r: string[]) => r[3].includes('/search/view/annual/')));
  assert.throws(() => leaked.data.map(parseSenateIndexRow), /not a PTR/);
  assert.equal(load('all-2026-susan-m-collins.json').recordsTotal, 0);
});
