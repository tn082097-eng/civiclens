import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLanding, type PublishedManifest } from './landing.js';

function manifest(overrides: Partial<PublishedManifest['members'][0]> = {}): PublishedManifest {
  return {
    members: [{
      slug: 'josh-gottheimer',
      name: 'Josh Gottheimer',
      party: 'Democrat',
      chamber: 'house',
      state: 'NJ',
      stats: { trades: 1923, votes: 2000, sponsored: 194, cosponsored: 3243, donors: 99 },
      dataThrough: '2026-06-30',
      ...overrides,
    }],
  };
}

test('renderLanding: member card carries name, sub-line, formatted inventory numbers, link', () => {
  const html = renderLanding(manifest());
  assert.match(html, /Josh Gottheimer/);
  assert.match(html, /Democrat · NJ · House/);
  assert.match(html, /1,923/);
  assert.match(html, /3,243/);
  assert.match(html, /href="members\/josh-gottheimer\.html"/);
  assert.match(html, /data through <span class="mono">2026-06-30<\/span>/);
});

test('renderLanding: inventory language only — no detector/signal claims on the front door', () => {
  const html = renderLanding(manifest());
  assert.ok(!/\bp\s*=|permutation|significant|flagged|suspicious/i.test(html));
  assert.match(html, /do not\s+establish causation or statistical significance/i);
  assert.match(html, /Single-member beta/);
});

test('renderLanding: escapes member fields', () => {
  const html = renderLanding(manifest({ name: '<b>Evil</b>', party: 'A&B' }));
  assert.ok(!html.includes('<b>Evil</b>'));
  assert.match(html, /&lt;b&gt;Evil&lt;\/b&gt;/);
  assert.match(html, /A&amp;B/);
});

test('renderLanding: rejects unsafe slugs and malformed dates (href/attr safety)', () => {
  assert.throws(() => renderLanding(manifest({ slug: '../etc' })), /unsafe member slug/);
  assert.throws(() => renderLanding(manifest({ slug: 'a"onclick' })), /unsafe member slug/);
  assert.throws(() => renderLanding(manifest({ dataThrough: '30 June' })), /bad dataThrough/);
});

test('renderLanding: rejects non-integer or negative counts', () => {
  const bad = manifest();
  bad.members[0].stats.trades = -1;
  assert.throws(() => renderLanding(bad), /bad manifest count/);
  bad.members[0].stats.trades = 1.5;
  assert.throws(() => renderLanding(bad), /bad manifest count/);
});

test('renderLanding: empty manifest fails loudly, count line pluralizes', () => {
  assert.throws(() => renderLanding({ members: [] }), /manifest is empty/);
  assert.match(renderLanding(manifest()), />1 member</);
  const two = manifest();
  two.members.push({ ...manifest().members[0], slug: 'nancy-pelosi', name: 'Nancy Pelosi' });
  assert.match(renderLanding(two), />2 members</);
});

test('renderLanding: null dataThrough renders without a data-through claim', () => {
  const html = renderLanding(manifest({ dataThrough: null }));
  assert.ok(!/data through/.test(html));
});
