import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkIdentityRoster } from './identity-roster-check.js';

const house = (seats: Array<[string, string]>) => `<MemberData><members>${seats.map(([sd, b]) =>
  `<member><statedistrict>${sd}</statedistrict><member-info><bioguideID>${b}</bioguideID></member-info></member>`).join('')}</members></MemberData>`;
const senate = (ids: string[]) => `<contact_information>${ids.map(b => `<member><bioguide_id>${b}</bioguide_id></member>`).join('')}</contact_information>`;
const term = (chamber: 'house' | 'senate', state: string, district: number | null, start = '2025-01-03', end = '2027-01-03') =>
  ({ chamber, state, district, start, end });
const snapshot = {
  people: [
    { bioguide: 'H000001', terms: [term('house', 'TX', 2)] },
    { bioguide: 'H000002', terms: [term('house', 'AS', 0)] },
    { bioguide: 'H000003', terms: [term('house', 'FL', 20, '2025-01-03', '2026-04-21')] },
    { bioguide: 'S000001', terms: [term('senate', 'OH', null)] },
  ],
};

test('a snapshot matching the official lists passes, with the Clerk AQ alias and a vacancy', () => {
  const r = checkIdentityRoster(snapshot, house([['TX02', 'H000001'], ['AQ00', 'H000002'], ['FL20', '']]), senate(['S000001']), '2026-11-26');
  assert.equal(r.pass, true);
  assert.deepEqual(r.house.vacancies, ['FL20']);
  assert.equal(r.house.snapshot, 2);
});

test('a departure the snapshot missed, a wrong seat or a held vacancy fails', () => {
  const missed = checkIdentityRoster(snapshot, house([['TX02', 'H000001'], ['FL20', '']]), senate(['S000001']), '2026-11-26');
  assert.equal(missed.pass, false);
  assert.deepEqual(missed.house.onlySnapshot, ['H000002']);
  const moved = checkIdentityRoster(snapshot, house([['TX03', 'H000001'], ['AQ00', 'H000002']]), senate(['S000001']), '2026-11-26');
  assert.deepEqual(moved.house.seatMismatch, ['H000001: Clerk TX03, snapshot TX02']);
  const held = checkIdentityRoster(snapshot, house([['TX02', 'H000001'], ['AQ00', 'H000002'], ['FL20', '']]), senate(['S000001']), '2026-04-01');
  assert.deepEqual(held.house.heldVacancies, ['FL20']);
  assert.equal(held.pass, false);
});

test('a senator missing from either side fails', () => {
  const r = checkIdentityRoster(snapshot, house([['TX02', 'H000001'], ['AQ00', 'H000002']]), senate(['S000001', 'S000002']), '2026-11-26');
  assert.deepEqual(r.senate.onlyOfficial, ['S000002']);
  assert.equal(r.pass, false);
});

test('empty or malformed official lists are errors, not passes', () => {
  assert.throws(() => checkIdentityRoster(snapshot, '<members></members>', senate(['S000001']), '2026-11-26'), /no <member>/);
  assert.throws(() => checkIdentityRoster(snapshot, house([['TX02', 'H000001']]), '<x/>', '2026-11-26'), /no <bioguide_id>/);
  assert.throws(() => checkIdentityRoster(snapshot, house([['TX02', 'H000001'], ['TX03', 'H000001']]), senate(['S000001']), '2026-11-26'), /repeats/);
});
