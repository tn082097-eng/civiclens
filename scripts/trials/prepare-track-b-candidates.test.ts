import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTrackBCandidates,
  deriveExcludedBioguides,
  parseHouseIndex,
  type HousePtrRecord,
} from './prepare-track-b-candidates.js';
import type { LegislatorIdentity } from '../../lib/legislators.js';

function legislator(overrides: Partial<LegislatorIdentity> & Pick<LegislatorIdentity, 'bioguide'>): LegislatorIdentity {
  return {
    bioguide: overrides.bioguide,
    officialFull: 'Jane Doe',
    first: 'Jane',
    last: 'Doe',
    nickname: null,
    fec: ['H0AA00001'],
    chamber: 'House',
    state: 'AA',
    district: '1',
    houseTerms: [{ stateDistrict: 'AA01', start: '2025-01-03', end: '2027-01-03' }],
    termStart: '2025-01-03',
    termEnd: '2027-01-03',
    ...overrides,
  };
}

test('parseHouseIndex keeps only periodic reports and preserves authoritative DocIDs', () => {
  const xml = `<FinancialDisclosure>\n<Member><Last>Doe</Last><First>Jane</First><FilingType>P</FilingType><StateDst>AA01</StateDst><Year>2025</Year><DocID>20000001</DocID></Member>\n<Member><Last>Doe</Last><First>Jane</First><FilingType>A</FilingType><StateDst>AA01</StateDst><Year>2025</Year><DocID>10000001</DocID></Member>\n</FinancialDisclosure>`;
  assert.deepEqual(parseHouseIndex(xml, 2025), [{
    year: 2025, docId: '20000001', first: 'Jane', last: 'Doe', stateDistrict: 'AA01',
  }]);
});

test('candidate preparation matches House PTRs by member identity and excludes frozen roster members', () => {
  const current = new Map<string, LegislatorIdentity>([
    ['D000001', legislator({ bioguide: 'D000001' })],
    ['R000002', legislator({
      bioguide: 'R000002', officialFull: 'Richard Roe', first: 'Richard', last: 'Roe',
      state: 'BB', district: '0', fec: [],
    })],
  ]);
  const housePtrs: HousePtrRecord[] = [
    { year: 2025, docId: '20000002', first: 'Jane', last: 'Doe', stateDistrict: 'AA01' },
    { year: 2025, docId: '20000001', first: 'Jane Q.', last: 'Doe', stateDistrict: 'AA01' },
    { year: 2024, docId: '19999999', first: 'Someone', last: 'Else', stateDistrict: 'CC03' },
  ];
  const result = buildTrackBCandidates({
    current,
    housePtrs,
    excludedBioguides: new Map([['R000002', ['production-db']]]),
    senateCounts: new Map(),
    probes: new Map(),
  });
  assert.deepEqual(result.candidates, [{
    bioguide: 'D000001', name: 'Jane Doe', chamber: 'house', fecIds: ['H0AA00001'],
    housePtrByYear: { 2025: 2 },
    housePtrDocIdsByYear: { 2025: ['20000001', '20000002'] },
    senatePtrCount: null,
    probes: {},
  }]);
  assert.deepEqual(result.excluded, [{ bioguide: 'R000002', reasons: ['production-db'] }]);
});

test('candidate preparation retains PTRs filed under a member historical House district', () => {
  const current = new Map<string, LegislatorIdentity>([
    ['D000001', legislator({
      bioguide: 'D000001',
      officialFull: 'Jane Doe',
      first: 'Jane',
      last: 'Doe',
      state: 'AA',
      district: '1',
      houseTerms: [
        { stateDistrict: 'AA02', start: '2021-01-03', end: '2023-01-03' },
        { stateDistrict: 'AA01', start: '2023-01-03', end: '2027-01-03' },
      ],
    })],
  ]);
  const housePtrs: HousePtrRecord[] = [
    { year: 2022, docId: '20000001', first: 'Jane', last: 'Doe', stateDistrict: 'AA02' },
    { year: 2025, docId: '20000002', first: 'Jane', last: 'Doe', stateDistrict: 'AA01' },
    { year: 2025, docId: '20000003', first: 'Jane', last: 'Doe', stateDistrict: 'BB01' },
  ];

  const result = buildTrackBCandidates({
    current,
    housePtrs,
    excludedBioguides: new Map(),
    senateCounts: new Map(),
    probes: new Map(),
  });

  assert.deepEqual(result.candidates[0].housePtrDocIdsByYear, {
    2022: ['20000001'],
    2025: ['20000002'],
  });
});

test('candidate preparation does not attach a filing to a district held only in another year', () => {
  const current = new Map<string, LegislatorIdentity>([
    ['D000001', legislator({
      bioguide: 'D000001',
      officialFull: 'Jane Doe',
      first: 'Jane',
      last: 'Doe',
      state: 'AA',
      district: '1',
      houseTerms: [
        { stateDistrict: 'AA02', start: '2019-01-03', end: '2021-01-03' },
        { stateDistrict: 'AA01', start: '2021-01-03', end: '2027-01-03' },
      ],
    })],
  ]);
  const result = buildTrackBCandidates({
    current,
    housePtrs: [
      { year: 2025, docId: '20000001', first: 'Jane', last: 'Doe', stateDistrict: 'AA02' },
      { year: 2025, docId: '20000002', first: 'Jane', last: 'Doe', stateDistrict: 'AA01' },
    ],
    excludedBioguides: new Map(),
    senateCounts: new Map(),
    probes: new Map(),
  });

  assert.deepEqual(result.candidates[0].housePtrDocIdsByYear, {
    2025: ['20000002'],
  });
});

test('Senate counts and probe evidence are joined by bioguide without changing the eligible pool', () => {
  const current = new Map<string, LegislatorIdentity>([
    ['S000001', legislator({
      bioguide: 'S000001', officialFull: 'Sam Senate', first: 'Sam', last: 'Senate',
      chamber: 'Senate', state: 'SS', district: null,
    })],
  ]);
  const probe = { year: 2025, docId: '20000009', hasUsableText: false };
  const result = buildTrackBCandidates({
    current,
    housePtrs: [],
    excludedBioguides: new Map(),
    senateCounts: new Map([['S000001', 0]]),
    probes: new Map([['S000001', { scanned: probe }]]),
  });
  assert.equal(result.candidates[0].senatePtrCount, 0);
  assert.deepEqual(result.candidates[0].probes, { scanned: probe });
});

test('exclusions union production members with every current alias match and retain unresolved names', () => {
  const current = new Map<string, LegislatorIdentity>([
    ['D000001', legislator({ bioguide: 'D000001' })],
    ['R000002', legislator({
      bioguide: 'R000002', officialFull: 'Robert Roe', first: 'Robert', last: 'Roe',
    })],
  ]);
  const result = deriveExcludedBioguides(current, ['Jane Doe', 'Nobody Here'], ['R000002']);
  assert.deepEqual([...result.excluded.entries()], [
    ['D000001', ['names.txt:Jane Doe']],
    ['R000002', ['production-db']],
  ]);
  assert.deepEqual(result.unresolvedNames, ['Nobody Here']);
});
