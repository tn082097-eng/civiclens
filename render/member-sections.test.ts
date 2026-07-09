import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMBER_SECTION_IDS, sectionShell, reservedStub, assembleMemberBody,
  renderMoneyVotesSection, type MoneyVotesData,
} from './member-sections.js';

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

test('renderMoneyVotesSection: empty data gets explicit empty-state AND the not-computed notice', () => {
  const html = renderMoneyVotesSection({ mappedTotal: 0, themes: [] });
  assert.match(html, /id="sec-money-votes"/);
  assert.match(html, /No mapped donor-industry data/);
  assert.match(html, /Not yet computed/);
  assert.match(html, /implies no causation/);
  assert.ok(!html.includes('<table>'), 'no table without data');
});

test('renderMoneyVotesSection: themes render as rows, escaped, with the not-computed notice', () => {
  const d: MoneyVotesData = {
    mappedTotal: 4_300_000,
    themes: [
      { theme: 'Banks & Finance', total: 2_800_809, share: 0.65, focusedBills: 31, cycles: '2024' },
      { theme: 'Real <Estate>', total: 435_000, share: 0.10, focusedBills: 0, cycles: '2022–2024' },
    ],
  };
  const html = renderMoneyVotesSection(d);
  assert.match(html, /Banks &amp; Finance/);
  assert.match(html, /Real &lt;Estate&gt;/, 'theme names are escaped');
  assert.match(html, /65%/);
  assert.match(html, /31/);
  assert.match(html, /Not yet computed/, 'part (b) present even with evidence');
  assert.match(html, /#sec-patterns/, 'cross-links to the patterns section');
  assert.ok(!/\bp\s*=|permutation|significant/i.test(html), 'no fabricated statistics language');
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
