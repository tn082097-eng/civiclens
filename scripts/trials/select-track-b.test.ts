import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rankForStratum,
  candidateArrayFromInput,
  selectForStratum,
  selectTrackB,
  type TrackBCandidate,
} from './select-track-b.js';

const seed = 'civiclens-track-b-2026-09-08-v1';

function candidate(overrides: Partial<TrackBCandidate> & Pick<TrackBCandidate, 'bioguide' | 'chamber'>): TrackBCandidate {
  return {
    bioguide: overrides.bioguide,
    name: overrides.bioguide,
    chamber: overrides.chamber,
    fecIds: [],
    housePtrByYear: {},
    housePtrDocIdsByYear: {},
    senatePtrCount: null,
    probes: {},
    ...overrides,
  };
}

test('rankForStratum is the literal HMAC digest order with a bioguide tiebreaker', () => {
  const people = [
    candidate({ bioguide: 'C000003', chamber: 'house' }),
    candidate({ bioguide: 'A000001', chamber: 'house' }),
    candidate({ bioguide: 'B000002', chamber: 'house' }),
  ];
  const ranked = rankForStratum(people, seed, '6');
  assert.deepEqual(ranked.map(row => row.bioguide), ['B000002', 'A000001', 'C000003']);
  assert.deepEqual(ranked.map(row => row.rank), [1, 2, 3]);
  assert.deepEqual(ranked.map(row => row.digest), [
    '37ea9d30b168a8ed29de4745a8769b2babdaaaca56203de3a2a007ad6cd62876',
    '500e1f0c3c224a2195cb10fec8ab9e785819b316570f9703173b108b21908201',
    '7a7df21b0cafc44c271c0c792f58bef83bf630e6174adfdd5122bf69ba611d83',
  ]);
});

test('selection CLI accepts the prepared candidate evidence envelope', () => {
  const person = candidate({ bioguide: 'A000001', chamber: 'house' });
  assert.deepEqual(candidateArrayFromInput({ candidates: [person], excluded: [] }), [person]);
});

test('selected rank is measured before predicate disqualifications, not renumbered afterward', () => {
  const rankedFirstButTextual = candidate({
    bioguide: 'B000002', chamber: 'house', housePtrByYear: { 2025: 1 },
    probes: { scanned: { year: 2025, docId: '2', hasUsableText: true } },
  });
  const rankedSecondAndScanned = candidate({
    bioguide: 'A000001', chamber: 'house', housePtrByYear: { 2025: 1 },
    probes: { scanned: { year: 2025, docId: '1', hasUsableText: false } },
  });
  const result = selectForStratum(
    [rankedFirstButTextual, rankedSecondAndScanned], seed, '6', new Set(),
  );
  assert.equal(result.selected?.bioguide, 'A000001');
  assert.equal(result.selected?.rank, 2);
  assert.deepEqual(result.disqualified.map(row => row.bioguide), ['B000002']);
});

test('selection uses order 1,2,6,3,4,5 and never selects one person twice', () => {
  const people = [
    candidate({ bioguide: 'S000001', chamber: 'senate', senatePtrCount: 2, fecIds: ['S1'] }),
    candidate({ bioguide: 'H000002', chamber: 'house', fecIds: ['H2'] }),
    candidate({
      bioguide: 'H000003', chamber: 'house', housePtrByYear: { 2025: 1 },
      probes: { scanned: { year: 2025, docId: '300', hasUsableText: false } },
    }),
    candidate({
      bioguide: 'H000004', chamber: 'house', fecIds: ['H4'], housePtrByYear: { 2025: 12 },
      probes: { text: { year: 2025, docId: '400', hasUsableText: true } },
    }),
    candidate({ bioguide: 'S000005', chamber: 'senate', senatePtrCount: 0, fecIds: ['S5'] }),
    candidate({ bioguide: 'S000006', chamber: 'senate' }),
  ];
  const result = selectTrackB(people, seed);
  assert.equal(result.status, 'selected');
  assert.deepEqual(result.assignmentOrder, ['1', '2', '6', '3', '4', '5']);
  assert.equal(new Set(result.selections.map(row => row.bioguide)).size, 6);
  assert.deepEqual(result.selections.map(row => row.stratum).sort(), ['1', '2', '3', '4', '5', '6']);
});

test('the scanned stratum claims an overlapping no-FEC candidate before stratum 5', () => {
  const overlap = candidate({
    bioguide: 'H000010', chamber: 'house', housePtrByYear: { 2024: 1 },
    probes: { scanned: { year: 2024, docId: '10', hasUsableText: false } },
  });
  const noFecFallback = candidate({ bioguide: 'S000011', chamber: 'senate' });
  const fixed = [
    candidate({ bioguide: 'S000001', chamber: 'senate', senatePtrCount: 2, fecIds: ['S1'] }),
    candidate({ bioguide: 'H000002', chamber: 'house', fecIds: ['H2'] }),
    overlap,
    candidate({
      bioguide: 'H000004', chamber: 'house', fecIds: ['H4'], housePtrByYear: { 2025: 12 },
      probes: { text: { year: 2025, docId: '400', hasUsableText: true } },
    }),
    candidate({ bioguide: 'S000005', chamber: 'senate', senatePtrCount: 0, fecIds: ['S5'] }),
    noFecFallback,
  ];
  const result = selectTrackB(fixed, seed);
  assert.equal(result.status, 'selected');
  assert.equal(result.selections.find(row => row.stratum === '6')?.bioguide, 'H000010');
  assert.equal(result.selections.find(row => row.stratum === '5')?.bioguide, 'S000011');
});

test('overlap exhaustion is a selection conflict, never a false no-candidate closure', () => {
  const people = [
    candidate({ bioguide: 'S000001', chamber: 'senate', senatePtrCount: 2, fecIds: ['S1'] }),
    candidate({ bioguide: 'H000002', chamber: 'house', fecIds: ['H2'] }),
    candidate({
      bioguide: 'H000003', chamber: 'house', housePtrByYear: { 2025: 1 },
      probes: { scanned: { year: 2025, docId: '300', hasUsableText: false } },
    }),
    candidate({
      bioguide: 'H000004', chamber: 'house', fecIds: ['H4'], housePtrByYear: { 2025: 12 },
      probes: { text: { year: 2025, docId: '400', hasUsableText: true } },
    }),
    candidate({ bioguide: 'S000005', chamber: 'senate', senatePtrCount: 0, fecIds: ['S5'] }),
  ];
  const result = selectTrackB(people, seed);
  assert.equal(result.status, 'selection-conflict');
  assert.equal(result.failedStratum, '5');
  assert.equal(result.originalEligibleCount, 1);
});
