import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMBER_SECTION_IDS, sectionShell, reservedStub, assembleMemberBody } from './member-sections.js';

test('registry lists the 13 sections in fixed order', () => {
  assert.deepEqual([...MEMBER_SECTION_IDS], [
    'sec-identity', 'sec-glance', 'sec-receipts', 'sec-coherence', 'sec-money-votes',
    'sec-timeline', 'sec-trades', 'sec-donors', 'sec-revolving', 'sec-outside-spending',
    'sec-peers', 'sec-patterns', 'sec-cosponsor',
  ]);
});

test('sectionShell emits an h2 with the id and escapes the title', () => {
  const html = sectionShell('sec-donors', 'Top donors & peers', '<p>x</p>');
  assert.match(html, /<h2 id="sec-donors">Top donors &amp; peers<\/h2>/);
  assert.ok(html.includes('<p>x</p>'));
});

test('reservedStub renders the not-computed-yet empty state', () => {
  const html = reservedStub('sec-money-votes', 'Money & votes');
  assert.match(html, /id="sec-money-votes"/);
  assert.match(html, /not computed yet/i);
});

test('assembleMemberBody emits each section id exactly once, in order', () => {
  const slots: Record<string, string> = {};
  for (const id of MEMBER_SECTION_IDS) slots[id] = `<h2 id="${id}">t</h2>`;
  const body = assembleMemberBody(slots);
  for (const id of MEMBER_SECTION_IDS) {
    const matches = body.match(new RegExp(`id="${id}"`, 'g')) ?? [];
    assert.equal(matches.length, 1, `${id} appears once`);
  }
  assert.ok(body.indexOf('sec-identity') < body.indexOf('sec-cosponsor'), 'order preserved');
});

test('assembleMemberBody throws when a slot is missing', () => {
  const slots: Record<string, string> = {};
  for (const id of MEMBER_SECTION_IDS) slots[id] = 'x';
  delete slots['sec-peers'];
  assert.throws(() => assembleMemberBody(slots), /missing section slot: sec-peers/);
});
