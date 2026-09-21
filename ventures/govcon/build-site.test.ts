import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite, esc, formatDeadline, daysUntil } from './build-site.ts';
import type { Opportunity } from './ingest.ts';

const NOW = Date.parse('2026-09-21T12:00:00Z');
const inDays = (n: number): string => new Date(NOW + n * 864e5).toISOString();

function opp(o: Partial<Opportunity>): Opportunity {
  return {
    id: 'x', title: 'Widget repair', sol: 'S1', agency: 'AGRICULTURE, DEPARTMENT OF',
    subTier: 'FOREST SERVICE', office: 'Region 3', posted: '2026-09-01', type: 'Solicitation',
    setAside: 'Small Business Set Aside - Total', setAsideCode: 'SBA',
    deadline: inDays(10), naics: '238990', psc: 'Z2PZ', popState: 'AZ', popCity: 'Prescott',
    link: 'https://sam.gov/opp/1', contact: 'A B', email: 'a@b.gov',
    description: 'Repair the fence', ...o,
  };
}

test('esc neutralises HTML', () => {
  assert.equal(esc('<script>"x"&\'y\'</script>'),
    '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;');
});

test('deadline urgency buckets', () => {
  assert.equal(daysUntil(inDays(5), NOW), 5);
  assert.equal(formatDeadline(inDays(0.5), NOW).urgency, 'now');
  assert.equal(formatDeadline(inDays(4), NOW).urgency, 'soon');
  assert.equal(formatDeadline(inDays(20), NOW).urgency, 'ok');
  assert.equal(formatDeadline(inDays(60), NOW).urgency, 'far');
});

test('builds the expected page set and never emits an unescaped title', () => {
  const data: Opportunity[] = [
    opp({ id: '1', title: 'Fence <b>repair</b> & "cleanout"' }),
    opp({ id: '2', popState: 'TX', popCity: 'Austin', naics: '541511' }),
    opp({ id: '3', setAside: 'HUBZone', setAsideCode: 'HZC', popState: 'TX' }),
    opp({ id: '4', setAside: 'HUBZone', setAsideCode: 'HZC', popState: 'TX' }),
    opp({ id: '5', setAside: 'HUBZone', setAsideCode: 'HZC', popState: 'TX' }),
    opp({ id: '6', popState: '', popCity: '' }),
  ];
  const out = mkdtempSync(join(tmpdir(), 'site-'));
  const r = buildSite(data, out, NOW, 'https://ex.github.io');

  for (const f of ['index.html', 'about/index.html', 'state/index.html', '404.html',
    'style.css', 'robots.txt', 'sitemap.xml', 'search-index.json', 'search.js',
    'state/arizona/index.html', 'state/texas/index.html',
    'sector/23/index.html', 'sector/54/index.html',
    'program/small-business/index.html', 'program/hubzone/index.html']) {
    assert.ok(existsSync(join(out, f)), `missing ${f}`);
  }

  // Three HUBZone notices in TX clears the >=3 bar, so the cross page exists.
  assert.ok(existsSync(join(out, 'program/hubzone/texas/index.html')), 'cross page');
  // Arizona has one small-business notice, below the bar — no thin page.
  assert.ok(!existsSync(join(out, 'program/small-business/arizona/index.html')), 'thin page suppressed');

  const home = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(home.includes('Fence &lt;b&gt;repair&lt;/b&gt; &amp; &quot;cleanout&quot;'),
    'title must be escaped in output');
  assert.ok(!home.includes('<b>repair</b>'), 'raw markup must not reach the page');
  assert.ok(home.includes('Location not specified'), 'blank state handled honestly');

  assert.equal(r.opportunities, 6);
  assert.ok(r.pages >= 10, `expected a real page set, got ${r.pages}`);

  const sitemap = readFileSync(join(out, 'sitemap.xml'), 'utf8');
  assert.ok(sitemap.includes('https://ex.github.io/'), 'sitemap uses the real origin');
  assert.equal((sitemap.match(/<loc>/g) ?? []).length, r.pages, 'every page is in the sitemap');

  const idx = JSON.parse(readFileSync(join(out, 'search-index.json'), 'utf8'));
  assert.equal(idx.length, 6);
  assert.ok(!('description' in idx[0]), 'index stays slim');
  assert.equal(idx[0].p, 'small-business');
});

test('about page reports the live count, not a frozen one', () => {
  const out = mkdtempSync(join(tmpdir(), 'site-'));
  buildSite([opp({ id: '1' }), opp({ id: '2' })], out, NOW, 'https://ex.github.io');
  const about = readFileSync(join(out, 'about/index.html'), 'utf8');
  assert.ok(about.includes('<strong>2</strong>'), 'count must come from the data');
});

test('an empty facet renders an honest message rather than a blank page', () => {
  const out = mkdtempSync(join(tmpdir(), 'site-'));
  buildSite([opp({ id: '1' })], out, NOW, 'https://ex.github.io');
  const p = readFileSync(join(out, 'program/wosb/index.html'), 'utf8');
  assert.ok(p.includes('Nothing open here right now'), 'empty state is explicit');
});
