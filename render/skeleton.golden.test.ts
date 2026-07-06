import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MEMBER_SECTION_IDS, assembleMemberBody } from './member-sections.js';

function fixtureSlots(): Record<string, string> {
  const slots: Record<string, string> = {};
  for (const id of MEMBER_SECTION_IDS) slots[id] = `<h2 id="${id}">${id}</h2><p>body</p>`;
  return slots;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

test('assembleMemberBody is byte-stable across repeated renders', () => {
  assert.equal(hash(assembleMemberBody(fixtureSlots())), hash(assembleMemberBody(fixtureSlots())));
});

test('every registry id appears exactly once in assembled output', () => {
  const body = assembleMemberBody(fixtureSlots());
  for (const id of MEMBER_SECTION_IDS) {
    assert.equal((body.match(new RegExp(`id="${id}"`, 'g')) ?? []).length, 1, `${id} once`);
  }
});
