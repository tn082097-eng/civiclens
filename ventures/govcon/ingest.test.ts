import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, isOpen, hasSetAside, ingest } from './ingest.ts';

test('cleanText strips markup and collapses whitespace', () => {
  assert.equal(cleanText('<p>Hello<br/>  world</p>'), 'Hello world');
  assert.equal(cleanText('A &amp; B &quot;q&quot;'), 'A & B "q"');
});

test('cleanText truncates with an ellipsis', () => {
  const out = cleanText('x'.repeat(100), 20);
  assert.equal(out.length, 20);
  assert.ok(out.endsWith('…'));
});

test('isOpen accepts future deadlines and rejects past or unparseable ones', () => {
  const now = Date.parse('2026-09-21T00:00:00Z');
  assert.equal(isOpen('2026-09-24T09:00:00-06:00', now), true);
  assert.equal(isOpen('2026-09-20T09:00:00-06:00', now), false);
  assert.equal(isOpen('', now), false);
  assert.equal(isOpen('not a date', now), false);
});

test('hasSetAside distinguishes a real restriction from none', () => {
  assert.equal(hasSetAside('Small Business Set Aside - Total', 'SBA'), true);
  assert.equal(hasSetAside('No Set aside used', 'NONE'), false);
  assert.equal(hasSetAside('', ''), false);
});

test('ingest filters, sorts by deadline and reports honest stats', async (t) => {
  const header = [
    'NoticeId', 'Title', 'Sol#', 'Department/Ind.Agency', 'Sub-Tier', 'Office',
    'PostedDate', 'Type', 'SetASide', 'SetASideCode', 'ResponseDeadLine',
    'NaicsCode', 'ClassificationCode', 'PopState', 'PopCity', 'Active', 'Link',
    'Description', 'PrimaryContactFullname', 'PrimaryContactEmail',
  ];
  const far = new Date(Date.now() + 30 * 864e5).toISOString();
  const near = new Date(Date.now() + 2 * 864e5).toISOString();
  const past = new Date(Date.now() - 864e5).toISOString();

  const row = (o: Record<string, string>): string =>
    header.map((h) => `"${(o[h] ?? '').replace(/"/g, '""')}"`).join(',');

  const base = {
    Title: 'T', 'Department/Ind.Agency': 'AGENCY, DEPT OF', Type: 'Solicitation',
    SetASide: 'Small Business Set Aside - Total', SetASideCode: 'SBA',
    NaicsCode: '238990', PopState: 'AZ', Active: 'Yes', Description: '<p>d</p>',
  };

  const csv = [
    header.map((h) => `"${h}"`).join(','),
    row({ ...base, NoticeId: 'far', ResponseDeadLine: far }),
    row({ ...base, NoticeId: 'near', ResponseDeadLine: near }),
    row({ ...base, NoticeId: 'expired', ResponseDeadLine: past }),
    row({ ...base, NoticeId: 'inactive', ResponseDeadLine: far, Active: 'No' }),
    row({ ...base, NoticeId: 'award', ResponseDeadLine: far, Type: 'Award Notice' }),
    row({ ...base, NoticeId: 'open-to-all', ResponseDeadLine: far, SetASide: 'No Set aside used', SetASideCode: 'NONE' }),
  ].join('\n');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(csv, { status: 200 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const out = mkdtempSync(join(tmpdir(), 'govcon-'));

  const stats = await ingest('https://example.invalid/x.csv', out);

  assert.equal(stats.rowsRead, 6);
  assert.equal(stats.active, 5, 'the inactive row is dropped');
  assert.equal(stats.actionable, 4, 'the award notice is dropped');
  assert.equal(stats.openDeadline, 3, 'the expired row is dropped');
  assert.equal(stats.published, 2, 'the open-to-all row is dropped');

  const rows = JSON.parse(readFileSync(join(out, 'opportunities.json'), 'utf8'));
  assert.deepEqual(rows.map((r: { id: string }) => r.id), ['near', 'far'],
    'soonest deadline must come first');
  assert.equal(rows[0].agency, 'AGENCY, DEPT OF');
  assert.equal(rows[0].description, 'd', 'markup is stripped');
});

test('ingest fails loudly when the extract loses a column', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('"NoticeId","Title"\n"a","b"\n', { status: 200 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    () => ingest('https://example.invalid/x.csv', '/tmp/govcon-nope'),
    /missing columns/,
  );
});
