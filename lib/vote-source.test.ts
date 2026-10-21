/**
 * Contract tests for lib/vote-source.ts
 * Test-first implementation per official-votes-contract-2026-10-08
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  VoteSourceError,
  VOTE_ACQUISITION_CONTRACT,
  VOTE_ACQUISITION_CONTRACT_VERSION,
  COVERAGE_MONTHS,
  FROZEN_EVIDENCE_WINDOW,
  type Chamber,
  type RollIdentity,
  sessionYear,
  rollKey,
  parseRollKey,
  houseSourceUrl,
  senateSourceUrl,
  type ObservedRoll,
  checkRollIdentity,
  isIsoDate,
  subtractCalendarMonths,
  coverageWindow,
  inWindow,
  type NormalizedPosition,
  type PositionContext,
  normalizePosition,
  memberParticipation,
  type Participation,
  BILL_TYPES,
  type BillType,
  type BillRef,
  type NonBillSubtype,
  RESOLUTION_OUTCOMES,
  type ResolutionOutcome,
  type RollResolution,
  isResolved,
  type HouseRollMetadata,
  classifyHouseRoll,
  type SenateDocumentFields,
  classifySenateRoll,
} from './vote-source.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '..', 'fixtures', 'votes');

// ─── Section 1: Canonical identity ────────────────────────────────────────

test('sessionYear: 119/1 → 2025', () => {
  assert.equal(sessionYear(119, 1), 2025);
});

test('sessionYear: 118/2 → 2024', () => {
  assert.equal(sessionYear(118, 2), 2024);
});

test('sessionYear: invalid congress throws VoteSourceError', () => {
  assert.throws(() => sessionYear(0, 1), VoteSourceError);
  assert.throws(() => sessionYear(-1, 1), VoteSourceError);
});

test('sessionYear: invalid session throws VoteSourceError', () => {
  assert.throws(() => sessionYear(119, 0), VoteSourceError);
  assert.throws(() => sessionYear(119, 3), VoteSourceError);
});

test('rollKey: house chamber produces h letter', () => {
  const id: RollIdentity = { chamber: 'house', congress: 119, session: 1, roll: 1 };
  assert.equal(rollKey(id), '119-2025/h1');
});

test('rollKey: invalid runtime chamber throws VoteSourceError (T20 finding 5)', () => {
  for (const chamber of ['wrong', '', 'House', undefined, null]) {
    assert.throws(
      () => rollKey({ chamber: chamber as any, congress: 119, session: 1, roll: 1 }),
      VoteSourceError,
      `chamber ${JSON.stringify(chamber)} must be rejected`
    );
  }
});

test('rollKey: senate chamber produces s letter', () => {
  const id: RollIdentity = { chamber: 'senate', congress: 119, session: 1, roll: 1 };
  assert.equal(rollKey(id), '119-2025/s1');
});

test('rollKey: roll without leading zeros', () => {
  const id: RollIdentity = { chamber: 'house', congress: 119, session: 1, roll: 1234 };
  assert.equal(rollKey(id), '119-2025/h1234');
});

test('rollKey: identical key from shuffled records', () => {
  const records: RollIdentity[] = [
    { chamber: 'house', congress: 119, session: 1, roll: 1 },
    { chamber: 'house', congress: 119, session: 1, roll: 2 },
    { chamber: 'house', congress: 119, session: 1, roll: 3 },
  ];
  const shuffled = [records[2], records[0], records[1]];
  assert.equal(rollKey(records[0]), rollKey(shuffled[1]));
  assert.equal(rollKey(records[1]), rollKey(shuffled[2]));
  assert.equal(rollKey(records[2]), rollKey(shuffled[0]));
});

test('rollKey: roll 0 throws', () => {
  const id: RollIdentity = { chamber: 'house', congress: 119, session: 1, roll: 0 };
  assert.throws(() => rollKey(id), VoteSourceError);
});

test('rollKey: roll -1 throws', () => {
  const id: RollIdentity = { chamber: 'house', congress: 119, session: 1, roll: -1 };
  assert.throws(() => rollKey(id), VoteSourceError);
});

test('rollKey: roll 1.5 throws', () => {
  const id: RollIdentity = { chamber: 'house', congress: 119, session: 1, roll: 1.5 };
  assert.throws(() => rollKey(id), VoteSourceError);
});

test('rollKey: roll NaN throws', () => {
  const id: RollIdentity = { chamber: 'house', congress: 119, session: 1, roll: NaN };
  assert.throws(() => rollKey(id), VoteSourceError);
});

test('rollKey: congress 0 throws', () => {
  const id: RollIdentity = { chamber: 'house', congress: 0, session: 1, roll: 1 };
  assert.throws(() => rollKey(id), VoteSourceError);
});

test('rollKey: congress 1.5 throws', () => {
  const id: RollIdentity = { chamber: 'house', congress: 1.5, session: 1, roll: 1 };
  assert.throws(() => rollKey(id), VoteSourceError);
});

test('parseRollKey: valid house key round-trips', () => {
  const key = '119-2025/h1';
  const parsed = parseRollKey(key);
  assert.deepEqual(parsed, {
    chamber: 'house',
    congress: 119,
    session: 1,
    roll: 1,
    year: 2025,
  });
  assert.equal(rollKey(parsed), key);
});

test('parseRollKey: valid senate key round-trips', () => {
  const key = '119-2025/s5';
  const parsed = parseRollKey(key);
  assert.deepEqual(parsed, {
    chamber: 'senate',
    congress: 119,
    session: 1,
    roll: 5,
    year: 2025,
  });
});

test('parseRollKey: leading zero roll rejects', () => {
  assert.throws(() => parseRollKey('119-2025/h01'), /strict|leading|zero/i);
});

test('parseRollKey: inconsistent year rejects', () => {
  assert.throws(() => parseRollKey('119-2024/h1'), /inconsistent|year|session/i);
});

test('parseRollKey: bad chamber letter rejects', () => {
  assert.throws(() => parseRollKey('119-2025/x1'), /chamber|letter|invalid/i);
});

test('parseRollKey: extra text rejects', () => {
  assert.throws(() => parseRollKey('119-2025/h1-extra'), /strict|extra|format/i);
});

test('parseRollKey: roll 0 rejects', () => {
  assert.throws(() => parseRollKey('119-2025/h0'), /zero|invalid|positive/i);
});

// ─── Section 2: URLs ──────────────────────────────────────────────────────

test('houseSourceUrl: roll 1 produces padded 001', () => {
  assert.equal(
    houseSourceUrl(2025, 1),
    'https://clerk.house.gov/evs/2025/roll001.xml'
  );
});

test('houseSourceUrl: roll 1234 unpadded', () => {
  assert.equal(
    houseSourceUrl(2025, 1234),
    'https://clerk.house.gov/evs/2025/roll1234.xml'
  );
});

test('senateSourceUrl: congress 119, session 1, roll 1', () => {
  assert.equal(
    senateSourceUrl(119, 1, 1),
    'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_00001.xml'
  );
});

test('senateSourceUrl: congress 119, session 1, roll 5', () => {
  assert.equal(
    senateSourceUrl(119, 1, 5),
    'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_00005.xml'
  );
});

test('houseSourceUrl: roll 0 throws', () => {
  assert.throws(() => houseSourceUrl(2025, 0), VoteSourceError);
});

test('houseSourceUrl: roll 1.5 throws', () => {
  assert.throws(() => houseSourceUrl(2025, 1.5), VoteSourceError);
});

test('senateSourceUrl: roll 0 throws', () => {
  assert.throws(() => senateSourceUrl(119, 1, 0), VoteSourceError);
});

// ─── Section 3: checkRollIdentity ──────────────────────────────────────────

test('checkRollIdentity: identical match returns ok:true', () => {
  const identity: ObservedRoll = {
    chamber: 'house',
    congress: 119,
    session: 1,
    roll: 1,
    date: '2025-01-03',
  };
  assert.deepEqual(checkRollIdentity(identity, identity), { ok: true });
});

test('checkRollIdentity: chamber mismatch returns mismatches array naming field', () => {
  const expected: ObservedRoll = {
    chamber: 'house',
    congress: 119,
    session: 1,
    roll: 1,
    date: '2025-01-03',
  };
  const observed: ObservedRoll = {
    chamber: 'senate',
    congress: 119,
    session: 1,
    roll: 1,
    date: '2025-01-03',
  };
  const result = checkRollIdentity(expected, observed);
  assert.equal(result.ok, false);
  assert.ok((result as any).mismatches.includes('chamber'));
});

test('checkRollIdentity: congress mismatch', () => {
  const expected: ObservedRoll = {
    chamber: 'house',
    congress: 119,
    session: 1,
    roll: 1,
    date: '2025-01-03',
  };
  const observed: ObservedRoll = {
    chamber: 'house',
    congress: 118,
    session: 1,
    roll: 1,
    date: '2025-01-03',
  };
  const result = checkRollIdentity(expected, observed);
  assert.equal(result.ok, false);
  assert.ok((result as any).mismatches.includes('congress'));
});

test('checkRollIdentity: session mismatch', () => {
  const expected: ObservedRoll = {
    chamber: 'house',
    congress: 119,
    session: 1,
    roll: 1,
    date: '2025-01-03',
  };
  const observed: ObservedRoll = {
    chamber: 'house',
    congress: 119,
    session: 2,
    roll: 1,
    date: '2025-01-03',
  };
  const result = checkRollIdentity(expected, observed);
  assert.equal(result.ok, false);
  assert.ok((result as any).mismatches.includes('session'));
});

test('checkRollIdentity: roll mismatch', () => {
  const expected: ObservedRoll = {
    chamber: 'house',
    congress: 119,
    session: 1,
    roll: 1,
    date: '2025-01-03',
  };
  const observed: ObservedRoll = {
    chamber: 'house',
    congress: 119,
    session: 1,
    roll: 2,
    date: '2025-01-03',
  };
  const result = checkRollIdentity(expected, observed);
  assert.equal(result.ok, false);
  assert.ok((result as any).mismatches.includes('roll'));
});

test('checkRollIdentity: date mismatch', () => {
  const expected: ObservedRoll = {
    chamber: 'house',
    congress: 119,
    session: 1,
    roll: 1,
    date: '2025-01-03',
  };
  const observed: ObservedRoll = {
    chamber: 'house',
    congress: 119,
    session: 1,
    roll: 1,
    date: '2025-01-04',
  };
  const result = checkRollIdentity(expected, observed);
  assert.equal(result.ok, false);
  assert.ok((result as any).mismatches.includes('date'));
});

// ─── Section 4: Coverage window ────────────────────────────────────────────

test('subtractCalendarMonths: 2026-09-26 − 48 → 2022-09-26', () => {
  assert.equal(subtractCalendarMonths('2026-09-26', 48), '2022-09-26');
});

test('subtractCalendarMonths: 2024-02-29 − 12 → 2023-02-28 (leap clamp)', () => {
  assert.equal(subtractCalendarMonths('2024-02-29', 12), '2023-02-28');
});

test('subtractCalendarMonths: 2028-02-29 − 48 → 2024-02-29', () => {
  assert.equal(subtractCalendarMonths('2028-02-29', 48), '2024-02-29');
});

test('subtractCalendarMonths: 2026-03-31 − 1 → 2026-02-28', () => {
  assert.equal(subtractCalendarMonths('2026-03-31', 1), '2026-02-28');
});

test('subtractCalendarMonths: 2024-03-31 − 1 → 2024-02-29', () => {
  assert.equal(subtractCalendarMonths('2024-03-31', 1), '2024-02-29');
});

test('subtractCalendarMonths: invalid date throws', () => {
  assert.throws(() => subtractCalendarMonths('2026-02-30', 1), VoteSourceError);
  assert.throws(() => subtractCalendarMonths('2026-9-26', 1), VoteSourceError);
});

test('isIsoDate: valid YYYY-MM-DD returns true', () => {
  assert.equal(isIsoDate('2026-09-26'), true);
});

test('isIsoDate: non-string returns false', () => {
  assert.equal(isIsoDate(20260926), false);
});

test('inWindow: inclusive start boundary', () => {
  const window = { start: '2022-09-26', end: '2026-09-26' };
  assert.equal(inWindow('2022-09-26', window), true);
});

test('inWindow: inclusive end boundary', () => {
  const window = { start: '2022-09-26', end: '2026-09-26' };
  assert.equal(inWindow('2026-09-26', window), true);
});

test('inWindow: day before start is false', () => {
  const window = { start: '2022-09-26', end: '2026-09-26' };
  assert.equal(inWindow('2022-09-25', window), false);
});

test('inWindow: day after end is false', () => {
  const window = { start: '2022-09-26', end: '2026-09-26' };
  assert.equal(inWindow('2026-09-27', window), false);
});

test('inWindow: invalid date throws', () => {
  const window = { start: '2022-09-26', end: '2026-09-26' };
  assert.throws(() => inWindow('2026-02-30', window), VoteSourceError);
});

test('FROZEN_EVIDENCE_WINDOW equals coverageWindow("2026-09-26")', () => {
  const computed = coverageWindow('2026-09-26', 48);
  assert.deepEqual(computed, FROZEN_EVIDENCE_WINDOW);
});

test('FROZEN_EVIDENCE_WINDOW has correct fields', () => {
  assert.equal(FROZEN_EVIDENCE_WINDOW.asOf, '2026-09-26');
  assert.equal(FROZEN_EVIDENCE_WINDOW.start, '2022-09-26');
  assert.equal(FROZEN_EVIDENCE_WINDOW.end, '2026-09-26');
  assert.equal(FROZEN_EVIDENCE_WINDOW.months, 48);
});

test('coverageWindow default months is 48', () => {
  const window = coverageWindow('2026-09-26');
  assert.equal(window.months, 48);
});

// ─── Section 5: Positions ────────────────────────────────────────────────

test('normalizePosition: "Yea" → yea', () => {
  const result = normalizePosition('Yea', 'standard');
  assert.equal(result.ok, true);
  assert.equal((result as any).position, 'yea');
  assert.equal((result as any).rawPosition, 'Yea');
});

test('normalizePosition: " Yea " with spaces preserves rawPosition', () => {
  const result = normalizePosition(' Yea ', 'standard');
  assert.equal(result.ok, true);
  assert.equal((result as any).rawPosition, ' Yea ');
  assert.equal((result as any).position, 'yea');
});

test('normalizePosition: "Aye" → yea', () => {
  const result = normalizePosition('Aye', 'standard');
  assert.equal((result as any).position, 'yea');
});

test('normalizePosition: "Nay" → nay', () => {
  const result = normalizePosition('Nay', 'standard');
  assert.equal((result as any).position, 'nay');
});

test('normalizePosition: "No" → nay', () => {
  const result = normalizePosition('No', 'standard');
  assert.equal((result as any).position, 'nay');
});

test('normalizePosition: "Present" → abstain', () => {
  const result = normalizePosition('Present', 'standard');
  assert.equal((result as any).position, 'abstain');
});

test('normalizePosition: "Not Voting" → absent', () => {
  const result = normalizePosition('Not Voting', 'standard');
  assert.equal((result as any).position, 'absent');
});

test('normalizePosition: "Guilty" → other', () => {
  const result = normalizePosition('Guilty', 'standard');
  assert.equal((result as any).position, 'other');
});

test('normalizePosition: "Not Guilty" → other', () => {
  const result = normalizePosition('Not Guilty', 'standard');
  assert.equal((result as any).position, 'other');
});

test('normalizePosition: "Present, Giving Live Pair" → other', () => {
  const result = normalizePosition('Present, Giving Live Pair', 'standard');
  assert.equal((result as any).position, 'other');
});

test('normalizePosition: "Guilty" never becomes nay', () => {
  const result = normalizePosition('Guilty', 'standard');
  assert.notEqual((result as any).position, 'nay');
  assert.notEqual((result as any).position, 'absent');
});

test('normalizePosition: candidate name "Jeffries" in election context → other', () => {
  const result = normalizePosition('Jeffries', 'election');
  assert.equal(result.ok, true);
  assert.equal((result as any).position, 'other');
});

test('normalizePosition: unsupported token in standard context', () => {
  const result = normalizePosition('Unknown', 'standard');
  assert.equal(result.ok, false);
  assert.equal((result as any).outcome, 'unsupported_record');
});

test('normalizePosition: empty string in standard context unsupported', () => {
  const result = normalizePosition('', 'standard');
  assert.equal(result.ok, false);
});

test('normalizePosition: empty string in election context unsupported', () => {
  const result = normalizePosition('', 'election');
  assert.equal(result.ok, false);
});

test('memberParticipation: recorded member with standard position', () => {
  const rows = [
    { memberId: 'member1', rawPosition: 'Yea' },
  ];
  const result = memberParticipation(rows, 'member1', 'standard');
  assert.equal((result as any).status, 'recorded');
  assert.equal((result as any).position, 'yea');
});

test('memberParticipation: missing member returns not_recorded', () => {
  const rows = [
    { memberId: 'member1', rawPosition: 'Yea' },
  ];
  const result = memberParticipation(rows, 'member2', 'standard');
  assert.equal((result as any).status, 'not_recorded');
  assert.notEqual((result as any).status, 'absent');
  assert.equal((result as any).position, undefined);
});

test('memberParticipation: duplicate member rows → ambiguity', () => {
  const rows = [
    { memberId: 'member1', rawPosition: 'Yea' },
    { memberId: 'member1', rawPosition: 'Nay' },
  ];
  const result = memberParticipation(rows, 'member1', 'standard');
  assert.equal((result as any).status, 'ambiguity');
});

test('memberParticipation: unsupported position token', () => {
  const rows = [
    { memberId: 'member1', rawPosition: 'UnknownVote' },
  ];
  const result = memberParticipation(rows, 'member1', 'standard');
  assert.equal((result as any).status, 'unsupported_position');
});

// ─── Section 6: classifyHouseRoll ──────────────────────────────────────────

test('classifyHouseRoll: "H R 1234" → hr type', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'H R 1234',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal(result.outcome, 'resolved_bill');
  assert.equal((result as any).bill.type, 'hr');
  assert.equal((result as any).bill.number, 1234);
});

test('classifyHouseRoll: "H RES 5" → hres type', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'H RES 5',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal((result as any).bill.type, 'hres');
});

test('classifyHouseRoll: "H J RES 7" → hjres type', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'H J RES 7',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal((result as any).bill.type, 'hjres');
});

test('classifyHouseRoll: "H CON RES 3" → hconres type', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'H CON RES 3',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal((result as any).bill.type, 'hconres');
});

test('classifyHouseRoll: "S 5" → s type', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'S 5',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal((result as any).bill.type, 's');
});

test('classifyHouseRoll: "S RES 9" → sres type', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'S RES 9',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal((result as any).bill.type, 'sres');
});

test('classifyHouseRoll: "S J RES 2" → sjres type', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'S J RES 2',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal((result as any).bill.type, 'sjres');
});

test('classifyHouseRoll: "S CON RES 4" → sconres type', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'S CON RES 4',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal((result as any).bill.type, 'sconres');
});

test('classifyHouseRoll: dotted form "H. R. 2365" normalized', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'H. R. 2365',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal(result.outcome, 'resolved_bill');
  assert.equal((result as any).bill.type, 'hr');
  assert.equal((result as any).bill.number, 2365);
});

test('classifyHouseRoll: congress carried from metadata', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'H R 1',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal((result as any).bill.congress, 119);
});

test('classifyHouseRoll: amendment_num preserved', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'H R 1',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: 'Amendment 42',
  };
  const result = classifyHouseRoll(meta);
  assert.equal((result as any).amendment, 'Amendment 42');
});

test('classifyHouseRoll: QUORUM + QUORUM → authoritative_non_bill quorum', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'QUORUM',
    vote_type: 'QUORUM',
    question: 'Call by States',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal(result.outcome, 'authoritative_non_bill');
  assert.equal((result as any).subtype, 'quorum');
});

test('classifyHouseRoll: QUORUM + non-QUORUM vote_type → ambiguity', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'QUORUM',
    vote_type: 'YEA-AND-NAY',
    question: 'Call by States',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal(result.outcome, 'ambiguity');
});

test('classifyHouseRoll: JOURNAL → authoritative_non_bill journal', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'JOURNAL',
    vote_type: 'YEA-AND-NAY',
    question: 'On Approval of the Journal',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal(result.outcome, 'authoritative_non_bill');
  assert.equal((result as any).subtype, 'journal');
});

test('classifyHouseRoll: ADJOURN → authoritative_non_bill adjourn', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'ADJOURN',
    vote_type: 'YEA-AND-NAY',
    question: 'Motion to Adjourn',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal(result.outcome, 'authoritative_non_bill');
  assert.equal((result as any).subtype, 'adjourn');
});

test('classifyHouseRoll: empty legis_num → unsupported_record', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: '',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal(result.outcome, 'unsupported_record');
  assert.notEqual(result.outcome, 'authoritative_non_bill');
});

test('classifyHouseRoll: "On Motion to Table" with unrecognized legis_num → unsupported', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'MOTION',
    vote_type: 'YEA-AND-NAY',
    question: 'On Motion to Table',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal(result.outcome, 'unsupported_record');
});

test('classifyHouseRoll: "On Cloture" with unrecognized legis_num → unsupported', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'CLOTURE',
    vote_type: 'YEA-AND-NAY',
    question: 'On Cloture',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal(result.outcome, 'unsupported_record');
});

test('classifyHouseRoll: "H R 0" not resolved_bill', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'H R 0',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.notEqual(result.outcome, 'resolved_bill');
});

test('classifyHouseRoll: "H R 12a" not resolved_bill', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'H R 12a',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.notEqual(result.outcome, 'resolved_bill');
});

test('classifyHouseRoll: frozen official case (2025 roll 001)', () => {
  const xmlPath = join(FIXTURES_DIR, 'house-acquisition', 'house-2025-roll001.xml');
  const bytes = readFileSync(xmlPath);

  const sha = createHash('sha256').update(bytes).digest('hex');
  assert.equal(
    sha,
    '876aa39e6cfe58942eb5a3b24628975b288e6c5fca8d8e0257dfcd7d180163fd',
    'SHA256 mismatch for frozen House fixture'
  );

  // Extract legis-num and vote-type via regex
  const xmlStr = bytes.toString('utf-8');
  const legisMatch = xmlStr.match(/<legis-num>([^<]+)<\/legis-num>/);
  const voteTypeMatch = xmlStr.match(/<vote-type>([^<]+)<\/vote-type>/);

  assert.ok(legisMatch, 'Could not extract legis-num from frozen fixture');
  assert.ok(voteTypeMatch, 'Could not extract vote-type from frozen fixture');

  const legis_num = legisMatch[1];
  const vote_type = voteTypeMatch[1];

  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num,
    vote_type,
    question: 'Call by States',
    amendment_num: null,
  };

  const result = classifyHouseRoll(meta);
  assert.equal(result.outcome, 'authoritative_non_bill', 'Expected quorum classification');
  assert.equal((result as any).subtype, 'quorum');
});

test('classifyHouseRoll (SYNTHETIC): "H.R. 2365" dotted form resolves', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'H.R. 2365',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal(result.outcome, 'resolved_bill');
  assert.equal((result as any).bill.type, 'hr');
  assert.equal((result as any).bill.number, 2365);
});

test('classifyHouseRoll (SYNTHETIC): "H.Res. 5" dotted form resolves', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'H.Res. 5',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal(result.outcome, 'resolved_bill');
  assert.equal((result as any).bill.type, 'hres');
  assert.equal((result as any).bill.number, 5);
});

test('classifyHouseRoll (SYNTHETIC): "H.J.Res. 7" dotted form resolves', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'H.J.Res. 7',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal(result.outcome, 'resolved_bill');
  assert.equal((result as any).bill.type, 'hjres');
  assert.equal((result as any).bill.number, 7);
});

test('classifyHouseRoll (SYNTHETIC): "H.Con.Res. 10" dotted form resolves', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'H.Con.Res. 10',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal(result.outcome, 'resolved_bill');
  assert.equal((result as any).bill.type, 'hconres');
  assert.equal((result as any).bill.number, 10);
});

test('classifyHouseRoll (SYNTHETIC): "S.Res. 9" dotted form resolves', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'S.Res. 9',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal(result.outcome, 'resolved_bill');
  assert.equal((result as any).bill.type, 'sres');
  assert.equal((result as any).bill.number, 9);
});

test('classifyHouseRoll (SYNTHETIC): "S.J.Res. 2" dotted form resolves', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'S.J.Res. 2',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal(result.outcome, 'resolved_bill');
  assert.equal((result as any).bill.type, 'sjres');
  assert.equal((result as any).bill.number, 2);
});

test('classifyHouseRoll (SYNTHETIC): "S.Con.Res. 4" dotted form resolves', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'S.Con.Res. 4',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.equal(result.outcome, 'resolved_bill');
  assert.equal((result as any).bill.type, 'sconres');
  assert.equal((result as any).bill.number, 4);
});

test('classifyHouseRoll: raw field echoes inputs', () => {
  const meta: HouseRollMetadata = {
    congress: 119,
    legis_num: 'H R 1234',
    vote_type: 'YEA-AND-NAY',
    question: 'On Passage',
    amendment_num: null,
  };
  const result = classifyHouseRoll(meta);
  assert.ok((result as any).raw);
  assert.equal((result as any).raw.legis_num, 'H R 1234');
  assert.equal((result as any).raw.vote_type, 'YEA-AND-NAY');
});

test('isResolved: resolved_bill is resolved', () => {
  const r: RollResolution = {
    outcome: 'resolved_bill',
    bill: { congress: 119, type: 'hr', number: 1 },
    amendment: null,
    raw: {},
  };
  assert.equal(isResolved(r), true);
});

test('isResolved: authoritative_non_bill is resolved', () => {
  const r: RollResolution = {
    outcome: 'authoritative_non_bill',
    subtype: 'quorum',
    raw: {},
  };
  assert.equal(isResolved(r), true);
});

test('isResolved: unsupported_record not resolved', () => {
  const r: RollResolution = {
    outcome: 'unsupported_record',
    reason: 'test',
    raw: {},
  };
  assert.equal(isResolved(r), false);
});

test('isResolved: ambiguity not resolved', () => {
  const r: RollResolution = {
    outcome: 'ambiguity',
    reason: 'test',
    raw: {},
  };
  assert.equal(isResolved(r), false);
});

test('isResolved: malformed_source not resolved', () => {
  const r: RollResolution = {
    outcome: 'malformed_source',
    reason: 'test',
    raw: {},
  };
  assert.equal(isResolved(r), false);
});

// ─── Section 7: classifySenateRoll ───────────────────────────────────────

test('classifySenateRoll: "S." documentType → s type', () => {
  const fields: SenateDocumentFields = {
    congress: 119,
    documentCongress: '119',
    documentType: 'S.',
    documentNumber: '5',
    documentName: 'Some Bill',
    amendmentNumber: '',
    amendmentToDocumentNumber: '',
  };
  const result = classifySenateRoll(fields);
  assert.equal(result.outcome, 'resolved_bill');
  assert.equal((result as any).bill.type, 's');
  assert.equal((result as any).bill.number, 5);
});

test('classifySenateRoll: "H.R." documentType → hr type', () => {
  const fields: SenateDocumentFields = {
    congress: 119,
    documentCongress: '119',
    documentType: 'H.R.',
    documentNumber: '123',
    documentName: 'House Bill',
    amendmentNumber: '',
    amendmentToDocumentNumber: '',
  };
  const result = classifySenateRoll(fields);
  assert.equal((result as any).bill.type, 'hr');
});

test('classifySenateRoll: "S.J.Res." → sjres type', () => {
  const fields: SenateDocumentFields = {
    congress: 119,
    documentCongress: '119',
    documentType: 'S.J.Res.',
    documentNumber: '10',
    documentName: 'Joint Resolution',
    amendmentNumber: '',
    amendmentToDocumentNumber: '',
  };
  const result = classifySenateRoll(fields);
  assert.equal((result as any).bill.type, 'sjres');
});

test('classifySenateRoll: "H.J.Res." → hjres type', () => {
  const fields: SenateDocumentFields = {
    congress: 119,
    documentCongress: '119',
    documentType: 'H.J.Res.',
    documentNumber: '7',
    documentName: 'House Joint Resolution',
    amendmentNumber: '',
    amendmentToDocumentNumber: '',
  };
  const result = classifySenateRoll(fields);
  assert.equal((result as any).bill.type, 'hjres');
});

test('classifySenateRoll: "S.Con.Res." → sconres type', () => {
  const fields: SenateDocumentFields = {
    congress: 119,
    documentCongress: '119',
    documentType: 'S.Con.Res.',
    documentNumber: '2',
    documentName: 'Concurrent Resolution',
    amendmentNumber: '',
    amendmentToDocumentNumber: '',
  };
  const result = classifySenateRoll(fields);
  assert.equal((result as any).bill.type, 'sconres');
});

test('classifySenateRoll: "H.Con.Res." → hconres type', () => {
  const fields: SenateDocumentFields = {
    congress: 119,
    documentCongress: '119',
    documentType: 'H.Con.Res.',
    documentNumber: '4',
    documentName: 'House Concurrent Resolution',
    amendmentNumber: '',
    amendmentToDocumentNumber: '',
  };
  const result = classifySenateRoll(fields);
  assert.equal((result as any).bill.type, 'hconres');
});

test('classifySenateRoll: "S.Res." → sres type', () => {
  const fields: SenateDocumentFields = {
    congress: 119,
    documentCongress: '119',
    documentType: 'S.Res.',
    documentNumber: '3',
    documentName: 'Senate Resolution',
    amendmentNumber: '',
    amendmentToDocumentNumber: '',
  };
  const result = classifySenateRoll(fields);
  assert.equal((result as any).bill.type, 'sres');
});

test('classifySenateRoll: "H.Res." → hres type', () => {
  const fields: SenateDocumentFields = {
    congress: 119,
    documentCongress: '119',
    documentType: 'H.Res.',
    documentNumber: '6',
    documentName: 'House Resolution',
    amendmentNumber: '',
    amendmentToDocumentNumber: '',
  };
  const result = classifySenateRoll(fields);
  assert.equal((result as any).bill.type, 'hres');
});

test('classifySenateRoll (SYNTHETIC): "PN" → nomination', () => {
  const fields: SenateDocumentFields = {
    congress: 119,
    documentCongress: '119',
    documentType: 'PN',
    documentNumber: '42',
    documentName: 'Nominee',
    amendmentNumber: '',
    amendmentToDocumentNumber: '',
  };
  const result = classifySenateRoll(fields);
  assert.equal(result.outcome, 'authoritative_non_bill');
  assert.equal((result as any).subtype, 'nomination');
});

test('classifySenateRoll (SYNTHETIC): "Treaty Doc." → treaty', () => {
  const fields: SenateDocumentFields = {
    congress: 119,
    documentCongress: '119',
    documentType: 'Treaty Doc.',
    documentNumber: '1',
    documentName: 'Some Treaty',
    amendmentNumber: '',
    amendmentToDocumentNumber: '',
  };
  const result = classifySenateRoll(fields);
  assert.equal(result.outcome, 'authoritative_non_bill');
  assert.equal((result as any).subtype, 'treaty');
});

test('classifySenateRoll (SYNTHETIC): documentCongress ≠ vote congress → ambiguity', () => {
  const fields: SenateDocumentFields = {
    congress: 119,
    documentCongress: '118',
    documentType: 'S.',
    documentNumber: '5',
    documentName: 'Bill',
    amendmentNumber: '',
    amendmentToDocumentNumber: '',
  };
  const result = classifySenateRoll(fields);
  assert.equal(result.outcome, 'ambiguity');
});

test('classifySenateRoll (SYNTHETIC): empty document + amendmentToDocumentNumber "S. 5" → resolved', () => {
  const fields: SenateDocumentFields = {
    congress: 119,
    documentCongress: '119',
    documentType: '',
    documentNumber: '',
    documentName: '',
    amendmentNumber: '',
    amendmentToDocumentNumber: 'S. 5',
  };
  const result = classifySenateRoll(fields);
  assert.equal(result.outcome, 'resolved_bill');
  assert.equal((result as any).bill.type, 's');
  assert.equal((result as any).bill.number, 5);
  assert.ok((result as any).amendment);
});

test('classifySenateRoll (SYNTHETIC): document + disagreeing amendment → ambiguity', () => {
  const fields: SenateDocumentFields = {
    congress: 119,
    documentCongress: '119',
    documentType: 'S.',
    documentNumber: '5',
    documentName: 'Bill',
    amendmentNumber: '',
    amendmentToDocumentNumber: 'H.R. 12',
  };
  const result = classifySenateRoll(fields);
  assert.equal(result.outcome, 'ambiguity');
});

test('classifySenateRoll: all fields empty → unsupported_record', () => {
  const fields: SenateDocumentFields = {
    congress: 119,
    documentCongress: '119',
    documentType: '',
    documentNumber: '',
    documentName: '',
    amendmentNumber: '',
    amendmentToDocumentNumber: '',
  };
  const result = classifySenateRoll(fields);
  assert.equal(result.outcome, 'unsupported_record');
});

test('classifySenateRoll: unknown documentType "X." → unsupported_record', () => {
  const fields: SenateDocumentFields = {
    congress: 119,
    documentCongress: '119',
    documentType: 'X.',
    documentNumber: '1',
    documentName: 'Unknown',
    amendmentNumber: '',
    amendmentToDocumentNumber: '',
  };
  const result = classifySenateRoll(fields);
  assert.equal(result.outcome, 'unsupported_record');
});

test('classifySenateRoll: malformed number "abc" → malformed_source', () => {
  const fields: SenateDocumentFields = {
    congress: 119,
    documentCongress: '119',
    documentType: 'S.',
    documentNumber: 'abc',
    documentName: 'Bad Number',
    amendmentNumber: '',
    amendmentToDocumentNumber: '',
  };
  const result = classifySenateRoll(fields);
  assert.equal(result.outcome, 'malformed_source');
});

test('classifySenateRoll: frozen official case (119/1 roll 1)', () => {
  const xmlPath = join(FIXTURES_DIR, 'official-samples', 'senate-119-1-roll00001.xml');
  const bytes = readFileSync(xmlPath);

  // Verify SHA256 from source-receipts.json for senate-vote.xml
  const sha = createHash('sha256').update(bytes).digest('hex');
  assert.equal(
    sha,
    '9d71d78a54c83522babd743209ca4a1a27baa2df122d6830c50ec2aa512ea17e',
    'SHA256 mismatch for frozen Senate fixture'
  );

  // Extract fields via regex
  const xmlStr = bytes.toString('utf-8');
  const congMatch = xmlStr.match(/<document_congress>([^<]*)<\/document_congress>/);
  const typeMatch = xmlStr.match(/<document_type>([^<]*)<\/document_type>/);
  const numMatch = xmlStr.match(/<document_number>([^<]*)<\/document_number>/);
  const nameMatch = xmlStr.match(/<document_name>([^<]*)<\/document_name>/);
  const amendMatch = xmlStr.match(/<amendment_to_document_number>([^<]*)<\/amendment_to_document_number>/);

  assert.ok(typeMatch, 'Could not extract document_type from frozen Senate fixture');

  const documentCongress = congMatch ? congMatch[1] : '';
  const documentType = typeMatch[1];
  const documentNumber = numMatch ? numMatch[1] : '';
  const documentName = nameMatch ? nameMatch[1] : '';
  const amendmentToDocumentNumber = amendMatch ? amendMatch[1] : '';

  const fields: SenateDocumentFields = {
    congress: 119,
    documentCongress,
    documentType,
    documentNumber,
    documentName,
    amendmentNumber: '',
    amendmentToDocumentNumber,
  };

  const result = classifySenateRoll(fields);
  // Spec says even with cloture question, it resolves as s 5
  assert.equal(result.outcome, 'resolved_bill');
  assert.equal((result as any).bill.type, 's');
  assert.equal((result as any).bill.number, 5);
});

test('classifySenateRoll: raw field echoes inputs', () => {
  const fields: SenateDocumentFields = {
    congress: 119,
    documentCongress: '119',
    documentType: 'S.',
    documentNumber: '5',
    documentName: 'Bill',
    amendmentNumber: 'A1',
    amendmentToDocumentNumber: 'S. 6',
  };
  const result = classifySenateRoll(fields);
  assert.ok((result as any).raw);
});

// ─── Contract constants ────────────────────────────────────────────────────

test('VOTE_ACQUISITION_CONTRACT constant', () => {
  assert.equal(VOTE_ACQUISITION_CONTRACT, 'civiclens.official-vote-acquisition');
});

test('VOTE_ACQUISITION_CONTRACT_VERSION constant', () => {
  assert.equal(VOTE_ACQUISITION_CONTRACT_VERSION, 1);
});

test('COVERAGE_MONTHS constant', () => {
  assert.equal(COVERAGE_MONTHS, 48);
});

test('BILL_TYPES includes all 8 types', () => {
  assert.deepEqual(BILL_TYPES, ['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres', 'hres', 'sres']);
});

test('RESOLUTION_OUTCOMES includes all 7 outcomes', () => {
  assert.deepEqual(RESOLUTION_OUTCOMES, [
    'resolved_bill',
    'authoritative_non_bill',
    'unsupported_record',
    'ambiguity',
    'malformed_source',
    'incomplete_fetch',
    'source_failure',
  ]);
});

// ─── Section 8: Input-validation regressions (RED) ───────────────────────
// Scope: official-votes-contract-2026-10-08 repair. All constructed data in
// this section is SYNTHETIC. These tests are expected to fail until
// lib/vote-source.ts validates months, window bounds, and Senate numbers.

const REPO_ROOT = join(HERE, '..');
const VOTE_SOURCE_URL = pathToFileURL(join(REPO_ROOT, 'lib', 'vote-source.ts')).href;
const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

/**
 * Runs subtractCalendarMonths('2026-03-31', <monthsExpr>) in a child tsx process.
 * Some inputs (Infinity, 2**53, Number.MAX_VALUE, ...) make the month-rollback
 * while-loop non-terminating, so they must never run in the test runner process.
 * The child is spawned detached so that on timeout the whole process group
 * (tsx parent plus its node grandchild) can be SIGKILLed; killing only the
 * parent would leave a spinning orphan behind.
 */
function runSubtractMonthsInChild(monthsExpr: string) {
  const code = [
    '(async () => {',
    `  const { subtractCalendarMonths, VoteSourceError } = await import(${JSON.stringify(VOTE_SOURCE_URL)});`,
    '  let threw = false, isVoteSourceError = false, name = null;',
    '  try {',
    `    subtractCalendarMonths('2026-03-31', ${monthsExpr});`,
    '  } catch (e) {',
    '    threw = true;',
    '    isVoteSourceError = e instanceof VoteSourceError;',
    '    name = e && e.name;',
    '  }',
    "  process.stdout.write('SYNTHETIC_RESULT ' + JSON.stringify({ threw, isVoteSourceError, name }) + '\\n');",
    '})();',
  ].join('\n');

  // Non-literal options object: @types/node SpawnSyncOptions omits `detached`
  // (it is honored at runtime), so an inline literal would fail excess-property checks.
  const spawnOpts = {
    timeout: 10000,
    killSignal: 'SIGKILL' as const,
    encoding: 'utf-8' as const,
    detached: true,
  };
  const result = spawnSync(TSX_BIN, ['-e', code], spawnOpts);

  // Reap the process group (ESRCH when the group already exited is ignored).
  // Guard on a positive integer pid: when spawn fails pid is undefined or 0,
  // and kill(-0) / kill(0) would signal the test runner's own process group.
  if (Number.isInteger(result.pid) && result.pid > 0) {
    try {
      process.kill(-result.pid, 'SIGKILL');
    } catch {
      // group already gone
    }
  }
  return result;
}

interface ChildMonthsResult {
  threw: boolean;
  isVoteSourceError: boolean;
  name: string | null;
}

function parseChildMonthsResult(stdout: string): ChildMonthsResult | undefined {
  const line = stdout.split('\n').find((l) => l.startsWith('SYNTHETIC_RESULT '));
  if (line === undefined) return undefined;
  return JSON.parse(line.slice('SYNTHETIC_RESULT '.length)) as ChildMonthsResult;
}

function assertChildMonthsThrowsVoteSourceError(monthsExpr: string): void {
  const result = runSubtractMonthsInChild(monthsExpr);
  const diag =
    `signal=${result.signal} status=${result.status} ` +
    `error=${result.error ? result.error.message : 'none'} stderr=${JSON.stringify(result.stderr)}`;

  assert.equal(
    result.signal,
    null,
    `months=${monthsExpr}: child was killed (non-terminating rollback loop?) ${diag}`
  );
  assert.equal(result.status, 0, `months=${monthsExpr}: child did not exit cleanly ${diag}`);

  const parsed = parseChildMonthsResult(result.stdout);
  assert.ok(parsed, `months=${monthsExpr}: child printed no result; stdout=${JSON.stringify(result.stdout)} ${diag}`);
  assert.equal(
    parsed.isVoteSourceError,
    true,
    `months=${monthsExpr}: expected VoteSourceError, got threw=${parsed.threw} name=${parsed.name} ${diag}`
  );
}

// subtractCalendarMonths: months validation (in-process, these terminate on old code)

test('subtractCalendarMonths (regression): months -1 throws VoteSourceError', () => {
  assert.throws(() => subtractCalendarMonths('2026-03-31', -1), VoteSourceError);
});

test('subtractCalendarMonths (regression): months 1.5 throws VoteSourceError', () => {
  assert.throws(() => subtractCalendarMonths('2026-03-31', 1.5), VoteSourceError);
});

test('subtractCalendarMonths (regression): months NaN throws VoteSourceError', () => {
  assert.throws(() => subtractCalendarMonths('2026-03-31', NaN), VoteSourceError);
});

// subtractCalendarMonths: non-terminating inputs (each runs in a bounded child process)

test('subtractCalendarMonths (regression, child): months Infinity throws VoteSourceError without hanging', () => {
  assertChildMonthsThrowsVoteSourceError('Infinity');
});

test('subtractCalendarMonths (regression, child): months -Infinity throws VoteSourceError without hanging', () => {
  assertChildMonthsThrowsVoteSourceError('-Infinity');
});

test('subtractCalendarMonths (regression, child): months 2**53 throws VoteSourceError without hanging', () => {
  assertChildMonthsThrowsVoteSourceError('2 ** 53');
});

test('subtractCalendarMonths (regression, child): months -(2**53) throws VoteSourceError without hanging', () => {
  assertChildMonthsThrowsVoteSourceError('-(2 ** 53)');
});

test('subtractCalendarMonths (regression, child): months Number.MAX_VALUE throws VoteSourceError without hanging', () => {
  assertChildMonthsThrowsVoteSourceError('Number.MAX_VALUE');
});

// subtractCalendarMonths: control (should already pass)

test('subtractCalendarMonths control: valid clamping and zero months unchanged', () => {
  assert.equal(subtractCalendarMonths('2026-03-31', 1), '2026-02-28');
  assert.equal(subtractCalendarMonths('2024-03-31', 1), '2024-02-29');
  assert.equal(subtractCalendarMonths('2026-09-26', 48), '2022-09-26');
  assert.equal(subtractCalendarMonths('2026-09-26', 0), '2026-09-26');
});

// inWindow: window bounds validation (SYNTHETIC dates)

test('inWindow (regression): invalid window start "2025-13-01" throws VoteSourceError', () => {
  assert.throws(
    () => inWindow('2025-06-15', { start: '2025-13-01', end: '2025-12-31' }),
    VoteSourceError
  );
});

test('inWindow (regression): non-date window start "not-a-date" throws VoteSourceError', () => {
  assert.throws(
    () => inWindow('2025-06-15', { start: 'not-a-date', end: '2025-12-31' }),
    VoteSourceError
  );
});

test('inWindow (regression): invalid window end "2025-02-30" throws VoteSourceError', () => {
  assert.throws(
    () => inWindow('2025-06-15', { start: '2025-01-01', end: '2025-02-30' }),
    VoteSourceError
  );
});

test('inWindow (regression): reversed window boundaries throw VoteSourceError', () => {
  assert.throws(
    () => inWindow('2025-06-15', { start: '2025-12-31', end: '2025-01-01' }),
    VoteSourceError
  );
});

// inWindow: control (should already pass)

test('inWindow control: inclusive boundaries and one-day window are valid', () => {
  const window = { start: '2025-01-01', end: '2025-12-31' };
  assert.equal(inWindow('2025-01-01', window), true);
  assert.equal(inWindow('2025-12-31', window), true);

  const oneDay = { start: '2025-06-15', end: '2025-06-15' };
  assert.equal(inWindow('2025-06-15', oneDay), true);
});

// classifySenateRoll: malformed numbers and congress (SYNTHETIC, based on frozen S. 5 field set)

function synthSenateS5(overrides: Partial<SenateDocumentFields> = {}): SenateDocumentFields {
  return {
    congress: 119,
    documentCongress: '119',
    documentType: 'S.',
    documentNumber: '5',
    documentName: 'Bill',
    amendmentNumber: '',
    amendmentToDocumentNumber: '',
    ...overrides,
  };
}

function assertSenateMalformed(fields: SenateDocumentFields, label: string): void {
  const result = classifySenateRoll(fields);
  assert.equal(result.outcome, 'malformed_source', `${label}: must be malformed_source`);
  assert.equal((result as any).bill, undefined, `${label}: must not carry a resolved bill`);
}

test('classifySenateRoll (regression, SYNTHETIC): documentNumber "5abc" → malformed_source', () => {
  assertSenateMalformed(synthSenateS5({ documentNumber: '5abc' }), 'documentNumber "5abc"');
});

test('classifySenateRoll (regression, SYNTHETIC): documentNumber "05" → malformed_source', () => {
  assertSenateMalformed(synthSenateS5({ documentNumber: '05' }), 'documentNumber "05"');
});

test('classifySenateRoll (regression, SYNTHETIC): documentNumber "5.5" → malformed_source', () => {
  assertSenateMalformed(synthSenateS5({ documentNumber: '5.5' }), 'documentNumber "5.5"');
});

test('classifySenateRoll (regression, SYNTHETIC): documentNumber "5e2" → malformed_source', () => {
  assertSenateMalformed(synthSenateS5({ documentNumber: '5e2' }), 'documentNumber "5e2"');
});

test('classifySenateRoll (regression, SYNTHETIC): documentNumber "9007199254740993" (unsafe integer) → malformed_source', () => {
  assertSenateMalformed(
    synthSenateS5({ documentNumber: '9007199254740993' }),
    'documentNumber "9007199254740993"'
  );
});

test('classifySenateRoll (regression, SYNTHETIC): documentNumber " 5" (leading space) → malformed_source', () => {
  assertSenateMalformed(synthSenateS5({ documentNumber: ' 5' }), 'documentNumber " 5"');
});

test('classifySenateRoll (regression, SYNTHETIC): documentCongress "abc" with vote congress 119 → malformed_source', () => {
  assertSenateMalformed(synthSenateS5({ documentCongress: 'abc' }), 'documentCongress "abc"');
});

test('classifySenateRoll (regression, SYNTHETIC): documentCongress "119abc" with vote congress 119 → malformed_source', () => {
  assertSenateMalformed(synthSenateS5({ documentCongress: '119abc' }), 'documentCongress "119abc"');
});

// classifySenateRoll: controls (should already pass)

test('classifySenateRoll control (SYNTHETIC): documentCongress "118" with vote congress 119 → ambiguity', () => {
  const result = classifySenateRoll(synthSenateS5({ documentCongress: '118' }));
  assert.equal(result.outcome, 'ambiguity');
});

test('classifySenateRoll control (SYNTHETIC): unmodified S. 5 fields → resolved_bill s 5 congress 119', () => {
  const result = classifySenateRoll(synthSenateS5());
  assert.equal(result.outcome, 'resolved_bill');
  assert.equal((result as any).bill.type, 's');
  assert.equal((result as any).bill.number, 5);
  assert.equal((result as any).bill.congress, 119);
});

// classifySenateRoll: amendment-parent congress + safe-integer follow-up (SYNTHETIC, 2026-10-15)

const FOLLOWUP_PREFIX = 'classifySenateRoll followup (SYNTHETIC):';

function fallbackFields(overrides: Partial<SenateDocumentFields> = {}): SenateDocumentFields {
  return {
    congress: 119,
    documentCongress: '119',
    documentType: '',
    documentNumber: '',
    documentName: '',
    amendmentNumber: '',
    amendmentToDocumentNumber: 'S. 5',
    ...overrides,
  };
}

// A. Fallback path (no document type/number) must validate documentCongress against vote congress.

test(`${FOLLOWUP_PREFIX} fallback documentCongress "118" with parent "S. 5" → ambiguity`, () => {
  const result = classifySenateRoll(fallbackFields({ documentCongress: '118' }));
  assert.equal(result.outcome, 'ambiguity');
  assert.equal((result as any).bill, undefined, 'must not carry a resolved bill');
});

const FALLBACK_CONGRESS_MALFORMED_CASES: { label: string; documentCongress: string }[] = [
  { label: 'documentCongress "abc" with parent "S. 5" → malformed_source', documentCongress: 'abc' },
  { label: 'documentCongress "119abc" with parent "S. 5" → malformed_source', documentCongress: '119abc' },
  { label: 'documentCongress "9007199254740993" with parent "S. 5" → malformed_source', documentCongress: '9007199254740993' },
  { label: 'documentCongress "0" with parent "S. 5" → malformed_source', documentCongress: '0' },
];

for (const c of FALLBACK_CONGRESS_MALFORMED_CASES) {
  test(`${FOLLOWUP_PREFIX} fallback ${c.label}`, () => {
    assertSenateMalformed(fallbackFields({ documentCongress: c.documentCongress }), c.label);
  });
}

// B. Fallback path with unsafe parent designation must be malformed_source (no silent parseInt rounding).

const FALLBACK_UNSAFE_PARENT_CASES: { label: string; fields: SenateDocumentFields }[] = [
  {
    label: 'parent "S. 9007199254740993" with documentCongress "119" → malformed_source',
    fields: fallbackFields({ amendmentToDocumentNumber: 'S. 9007199254740993' }),
  },
  {
    label: 'parent "S. " + 400-digit number with documentCongress "119" → malformed_source',
    fields: fallbackFields({ amendmentToDocumentNumber: 'S. ' + '1'.repeat(400) }),
  },
  {
    label: 'parent "H.R. 9007199254740993" with documentCongress "119" → malformed_source',
    fields: fallbackFields({ amendmentToDocumentNumber: 'H.R. 9007199254740993' }),
  },
  {
    label: 'parent "S. 9007199254740993" with empty documentCongress → malformed_source',
    fields: fallbackFields({ documentCongress: '', amendmentToDocumentNumber: 'S. 9007199254740993' }),
  },
];

for (const c of FALLBACK_UNSAFE_PARENT_CASES) {
  test(`${FOLLOWUP_PREFIX} fallback ${c.label}`, () => {
    assertSenateMalformed(c.fields, c.label);
  });
}

// C. Valid direct document with unsafe parent must be rejected by parent validation, not ignored or ambiguous.

const DIRECT_UNSAFE_PARENT_CASES: { label: string; fields: SenateDocumentFields }[] = [
  {
    label: 'direct S. 5 with parent "S. 9007199254740993" → malformed_source',
    fields: synthSenateS5({ amendmentToDocumentNumber: 'S. 9007199254740993' }),
  },
  {
    label: 'direct S. 5 with parent "S. " + 400-digit number → malformed_source',
    fields: synthSenateS5({ amendmentToDocumentNumber: 'S. ' + '1'.repeat(400) }),
  },
];

for (const c of DIRECT_UNSAFE_PARENT_CASES) {
  test(`${FOLLOWUP_PREFIX} ${c.label}`, () => {
    assertSenateMalformed(c.fields, c.label);
  });
}

// Passing controls for the same follow-up surface (must hold before and after GREEN).

test(`${FOLLOWUP_PREFIX} control fallback documentCongress "119" with parent "S. 5" → resolved s 5, amendment "S. 5"`, () => {
  const result = classifySenateRoll(fallbackFields());
  assert.equal(result.outcome, 'resolved_bill');
  assert.deepEqual((result as any).bill, { congress: 119, type: 's', number: 5 });
  assert.equal((result as any).amendment, 'S. 5');
});

test(`${FOLLOWUP_PREFIX} control fallback empty documentCongress with parent "S. 5" → resolved s 5`, () => {
  const result = classifySenateRoll(fallbackFields({ documentCongress: '' }));
  assert.equal(result.outcome, 'resolved_bill');
  assert.deepEqual((result as any).bill, { congress: 119, type: 's', number: 5 });
  assert.equal((result as any).amendment, 'S. 5');
});

test(`${FOLLOWUP_PREFIX} control fallback parent "S. 9007199254740991" → resolved s number 9007199254740991`, () => {
  const result = classifySenateRoll(fallbackFields({ amendmentToDocumentNumber: 'S. 9007199254740991' }));
  assert.equal(result.outcome, 'resolved_bill');
  assert.deepEqual((result as any).bill, { congress: 119, type: 's', number: 9007199254740991 });
});

test(`${FOLLOWUP_PREFIX} control direct documentNumber "9007199254740991" with matching parent → resolved s number 9007199254740991`, () => {
  const result = classifySenateRoll(
    synthSenateS5({ documentNumber: '9007199254740991', amendmentToDocumentNumber: 'S. 9007199254740991' })
  );
  assert.equal(result.outcome, 'resolved_bill');
  assert.deepEqual((result as any).bill, { congress: 119, type: 's', number: 9007199254740991 });
});

const FALLBACK_SMALL_PARENT_CASES: { parent: string; type: BillType; number: number }[] = [
  { parent: 'H.R. 12', type: 'hr', number: 12 },
  { parent: 'S.J.Res. 3', type: 'sjres', number: 3 },
  { parent: 'H.J.Res. 4', type: 'hjres', number: 4 },
  { parent: 'S.Con.Res. 6', type: 'sconres', number: 6 },
  { parent: 'H.Con.Res. 7', type: 'hconres', number: 7 },
  { parent: 'S.Res. 8', type: 'sres', number: 8 },
  { parent: 'H.Res. 9', type: 'hres', number: 9 },
];

for (const c of FALLBACK_SMALL_PARENT_CASES) {
  test(`${FOLLOWUP_PREFIX} control fallback parent "${c.parent}" → resolved ${c.type} ${c.number}`, () => {
    const result = classifySenateRoll(fallbackFields({ amendmentToDocumentNumber: c.parent }));
    assert.equal(result.outcome, 'resolved_bill');
    assert.deepEqual((result as any).bill, { congress: 119, type: c.type, number: c.number });
  });
}

test(`${FOLLOWUP_PREFIX} control direct S. 5 with parent "S. 6" → ambiguity`, () => {
  const result = classifySenateRoll(synthSenateS5({ amendmentToDocumentNumber: 'S. 6' }));
  assert.equal(result.outcome, 'ambiguity');
});

test(`${FOLLOWUP_PREFIX} control direct S. 5 with parent "H.R. 12" → ambiguity`, () => {
  const result = classifySenateRoll(synthSenateS5({ amendmentToDocumentNumber: 'H.R. 12' }));
  assert.equal(result.outcome, 'ambiguity');
});

test(`${FOLLOWUP_PREFIX} control direct S. 5 with parent "S. 5" and amendmentNumber "S.Amdt. 1" → resolved s 5 amendment "S.Amdt. 1"`, () => {
  const result = classifySenateRoll(
    synthSenateS5({ amendmentToDocumentNumber: 'S. 5', amendmentNumber: 'S.Amdt. 1' })
  );
  assert.equal(result.outcome, 'resolved_bill');
  assert.deepEqual((result as any).bill, { congress: 119, type: 's', number: 5 });
  assert.equal((result as any).amendment, 'S.Amdt. 1');
});

const NON_BILL_CONTROL_CASES: { documentType: string; subtype: string }[] = [
  { documentType: 'PN', subtype: 'nomination' },
  { documentType: 'Treaty Doc.', subtype: 'treaty' },
];

for (const c of NON_BILL_CONTROL_CASES) {
  test(`${FOLLOWUP_PREFIX} control documentType "${c.documentType}" with parent "S. 9007199254740993" → authoritative_non_bill ${c.subtype}`, () => {
    const result = classifySenateRoll(
      synthSenateS5({
        documentType: c.documentType,
        documentNumber: '7',
        documentCongress: '118',
        amendmentToDocumentNumber: 'S. 9007199254740993',
      })
    );
    assert.equal(result.outcome, 'authoritative_non_bill');
    assert.equal((result as any).subtype, c.subtype);
  });
}

test(`${FOLLOWUP_PREFIX} control direct documentNumber "5abc" takes precedence over parent and congress → malformed_source with malformed document number reason`, () => {
  const fields = synthSenateS5({
    documentNumber: '5abc',
    documentCongress: '118',
    amendmentToDocumentNumber: 'S. 9007199254740993',
  });
  assertSenateMalformed(fields, 'documentNumber "5abc" with congress 118 and unsafe parent');
  assert.match((classifySenateRoll(fields) as any).reason, /malformed document number/);
});

const FALLBACK_UNSUPPORTED_CASES: { label: string; parent: string }[] = [
  { label: 'parent "X. 5"', parent: 'X. 5' },
  { label: 'parent "S. 05"', parent: 'S. 05' },
  { label: 'parent ""', parent: '' },
];

for (const c of FALLBACK_UNSUPPORTED_CASES) {
  test(`${FOLLOWUP_PREFIX} control fallback ${c.label} → unsupported_record`, () => {
    const result = classifySenateRoll(fallbackFields({ amendmentToDocumentNumber: c.parent }));
    assert.equal(result.outcome, 'unsupported_record');
  });
}
