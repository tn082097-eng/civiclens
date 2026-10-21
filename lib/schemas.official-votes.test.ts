// SYNTHETIC rows and provenance for offline contract tests, not coverage evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoteSchema, VoteCoverageSchema, ResearcherOutputSchema, ResearcherArtifactSchema } from './schemas.js';
export function officialVote(overrides: Record<string, unknown> = {}) {
  return { billTitle: 'H R 29: Test bill', vote: 'yea', rawPosition: 'Yea', date: '2025-01-07', source: 'clerk.house.gov', sourceUrl: 'https://clerk.house.gov/evs/2025/roll006.xml', sourceSha256: 'a'.repeat(64), confidence: 1, rollKey: '119-2025/h6', chamber: 'house', congress: 119, session: 1, roll: 6, question: 'On Passage', resolution: { outcome: 'resolved_bill', billId: '119-hr-29', subtype: null, amendment: null, reason: null }, ...overrides };
}
export function coverage(recorded = 0) {
  return { outcome: 'ok', source: 'official', chamber: 'house', bioguideId: 'X000001', asOf: '2026-10-16', window: { start: '2022-10-16', end: '2026-10-16', months: 48 }, requiredRolls: recorded, analyzedRolls: recorded, inServiceRolls: recorded, recorded, notRecorded: 0, notRecordedKeys: [], acquisition: { runDir: '/synthetic/run', manifestSha256: 'a'.repeat(64), inventorySha256: 'b'.repeat(64) }, collector: { commit: 'a'.repeat(40), lockSha256: 'a'.repeat(64), vendorManifestSha256: 'a'.repeat(64) }, identity: { commit: 'a'.repeat(40), snapshotSha256: 'a'.repeat(64), floor: '2022-01-01' } };
}
export function artifact(votes: unknown[], voteCoverage?: unknown) {
  return { source: 'congress.gov', fetchedAt: '2026-10-16T12:00:00.000Z', target: { name: 'Test Member', type: 'politician' }, warnings: [], data: { id: 'test-member', name: 'Test Member', party: 'Independent', state: 'TX', chamber: 'house', role: 'Representative', bio: 'A synthetic biography used only for isolated contract tests.'.repeat(2), inOffice: true, bills: [], votes, donors: [], controversies: [], connections: [], ...(voteCoverage === undefined ? {} : { voteCoverage }) } };
}
test('official metadata and other positions survive both researcher schemas', () => {
  const v = officialVote({ vote: 'other', rawPosition: 'Johnson (LA)' });
  for (const schema of [ResearcherOutputSchema, ResearcherArtifactSchema]) {
    const parsed = schema.parse(artifact([v], coverage(1)));
    assert.deepEqual(parsed.data.votes[0], v);
    assert.deepEqual((parsed.data as any).voteCoverage, coverage(1));
  }
});
test('legacy rows stay valid, official URLs cannot masquerade as legacy', () => {
  const v = { billTitle: 'Test vote', vote: 'yea', date: '2025-01-07', source: 'govtrack.us', confidence: 1, sourceUrl: 'https://www.govtrack.us/congress/votes/119-2025/h6' };
  assert.equal(VoteSchema.safeParse(v).success, true);
  assert.equal(VoteSchema.safeParse({ ...v, vote: 'other' }).success, false);
  assert.equal(VoteSchema.safeParse({ ...v, sourceUrl: 'https://www.senate.gov/anything' }).success, false);
});
test('official rows reject partial or contradictory metadata and resolution invariants', () => {
  const v = officialVote();
  for (const field of ['rawPosition', 'sourceSha256', 'rollKey', 'chamber', 'congress', 'session', 'roll', 'question', 'resolution']) {
    const partial: any = { ...v };
    delete partial[field];
    assert.equal(VoteSchema.safeParse(partial).success, false, field);
  }
  for (const patch of [{ roll: 7 }, { source: 'senate.gov' }, { sourceUrl: 'https://clerk.house.gov/evs/2025/roll007.xml' }, { sourceSha256: 'BAD' }, { rawPosition: '' }, { resolution: { ...v.resolution, billId: '118-hr-29' } }, { resolution: { ...v.resolution, subtype: 'quorum' } }, { resolution: { ...v.resolution, reason: 'unexpected' } }, { resolution: { outcome: 'authoritative_non_bill', billId: null, subtype: null, amendment: null, reason: null } }, { resolution: { outcome: 'unsupported_record', billId: null, subtype: null, amendment: null, reason: null } }])
    assert.equal(VoteSchema.safeParse({ ...v, ...patch }).success, false, JSON.stringify(patch));
});
test('Senate official source and non-bill classification validate', () => {
  const v = officialVote({ chamber: 'senate', source: 'senate.gov', roll: 655, rollKey: '119-2025/s655', sourceUrl: 'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_00655.xml', resolution: { outcome: 'authoritative_non_bill', billId: null, subtype: 'nomination', amendment: null, reason: null } });
  assert.equal(VoteSchema.safeParse(v).success, true);
});
test('coverage rejects partial and inconsistent success receipts', () => {
  for (const c of [{ outcome: 'ok' }, { ...coverage(), requiredRolls: 1 }, { ...coverage(), recorded: 1 }, { ...coverage(), window: { start: '2022-10-17', end: '2026-10-16', months: 48 } }])
    assert.equal(ResearcherOutputSchema.safeParse(artifact([], c)).success, false);
});

test('coverage retains listing evidence and rejects contradictory or duplicate listings',()=>{
  const listing={rollKey:'119-2025/h1',chamber:'house',voterId:'G000578',rawPosition:'Not Voting',date:'2025-01-03'};
  const c={...coverage(1),outOfServiceListings:[listing]};
  assert.deepEqual(VoteCoverageSchema.parse(c).outOfServiceListings,[listing]);
  const artifactValue=artifact([officialVote()],c);
  assert.deepEqual(ResearcherOutputSchema.parse(artifactValue).data.voteCoverage?.outOfServiceListings,[listing]);
  for(const patch of [{rawPosition:'Yea'},{voterId:'UNKNOWN'},{chamber:'senate'},{rollKey:'119-2025/s1'},{rollKey:'119-2025/h01'},{date:'2024-01-03'},{date:'2030-01-03'}]){
    assert.equal(VoteCoverageSchema.safeParse({...c,outOfServiceListings:[{...listing,...patch}]}).success,false,JSON.stringify(patch));
  }
  assert.equal(VoteCoverageSchema.safeParse({...c,outOfServiceListings:[listing,listing]}).success,false);
  assert.equal(VoteCoverageSchema.safeParse({...c,outOfServiceListings:[listing,{...listing,rollKey:'119-2025/h2'}]}).success,false);
  assert.equal(VoteCoverageSchema.safeParse({...c,outOfServiceListings:[{...listing,rollKey:'119-2025/s1',chamber:'senate',voterId:'S033'}]}).success,false);
  assert.equal(VoteCoverageSchema.safeParse({...coverage(0),outOfServiceListings:[listing]}).success,false);
});
