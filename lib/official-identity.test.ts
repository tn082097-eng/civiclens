import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadIdentityIndex, IDENTITY_SNAPSHOT_PATH} from './official-identity.js';
import {OfficialVoteFailure} from './official-vote-types.js';
const code = (c:string) => (e:unknown) => e instanceof OfficialVoteFailure && e.stage === 'identity' && e.code === c;
test('frozen official XML voter ids resolve through dated pinned identity', () => {
 const index=loadIdentityIndex();
 const senate=readFileSync(new URL('../fixtures/votes/official-samples/senate-amendment-119-1-roll00003.xml',import.meta.url),'utf8');
 assert.ok(senate.includes('<lis_member_id>S428</lis_member_id>'));
 const person=index.personForVoter('senate','S428','2025-01-15');
 assert.ok(index.inService(person,'senate','2025-01-15'));
 const house=readFileSync(new URL('../fixtures/votes/official-samples/house-bill-2025-roll006.xml',import.meta.url),'utf8');
 assert.ok(house.includes('name-id="A000370"'));
 assert.equal(index.personForVoter('house','A000370','2025-01-07'),'A000370');
});
test('identity fails for unknown voters and unknown target identities',()=>{
 const i=loadIdentityIndex();
 assert.throws(()=>i.personForVoter('senate','S999999','2025-01-15'),code('unmapped_voter'));
 assert.throws(()=>i.inService('UNKNOWN','house','2025-01-15'),code('unmapped_voter'));
});
test('identity floor and out-of-service voter fail closed',()=>{
 const i=loadIdentityIndex();
 assert.throws(()=>i.personForVoter('house','A000370','2018-12-31'),code('date_before_floor'));
 assert.throws(()=>i.inService('A000370','house','2018-12-31'),code('date_before_floor'));
 assert.throws(()=>i.personForVoter('senate','S428','2024-01-15'),code('voter_not_in_service'));
 assert.throws(()=>i.inService('A000370','house','2025-02-30'),code('invalid_date'));
});
test('snapshot hash is verified before parsing',()=>{
 const dir=mkdtempSync(join(tmpdir(),'official-identity-'));
 try { const path=join(dir,'snapshot.json');writeFileSync(path,readFileSync(IDENTITY_SNAPSHOT_PATH));writeFileSync(path,'\n',{flag:'a'});
 assert.throws(()=>loadIdentityIndex(path),code('snapshot_hash_mismatch')); } finally {rmSync(dir,{recursive:true,force:true});}
});
// Boundary cases from the 2026-11-24 pin refresh (SOURCES.md). The previous pin
// ended both appointed senators on 2026-11-03 although official Senate XML
// records them voting through 2026-11-20. The 2026-11-26 re-capture of the same
// commit moved as_of after an official-roster cross-check.
test('pinned snapshot identity and as_of limit',()=>{
 const i=loadIdentityIndex();
 assert.equal(i.commit,'2b1fe728159fe5f5e145277794106e800719eb50');
 assert.equal(i.asOf,'2026-11-26');
 assert.equal(i.personForVoter('senate','S428','2026-11-26'),i.personForVoter('senate','S428','2025-01-15'));
 assert.throws(()=>i.personForVoter('senate','S428','2026-11-27'),code('date_after_snapshot'));
 assert.throws(()=>i.inService('A000370','house','2026-11-27'),code('date_after_snapshot'));
});
test('the 2026-11-24 snapshot stays byte-identical except as_of, and the loader rejects it',()=>{
 const old=fileURLToPath(new URL('../fixtures/votes/identity/legislators-2b1fe72-voting-terms.json',import.meta.url));
 const oldBytes=readFileSync(old,'utf8'),newBytes=readFileSync(IDENTITY_SNAPSHOT_PATH,'utf8');
 assert.equal(oldBytes.replace('"as_of": "2026-11-24"','"as_of": "2026-11-26"'),newBytes);
 assert.throws(()=>loadIdentityIndex(old,'c5c8509eb23ad9e414644810cfef5f160508b87a1cd4a3472ebea2af1fa2fe46'),code('invalid_snapshot'));
});
test('Husted (S438) serves through the November 2026 rolls',()=>{
 const i=loadIdentityIndex();
 for(const d of ['2025-01-21','2026-11-03','2026-11-04','2026-11-20','2026-11-26'])assert.equal(i.personForVoter('senate','S438',d),'H001104');
 assert.throws(()=>i.personForVoter('senate','S438','2025-01-20'),code('voter_not_in_service'));
});
test('Moody (S439) has no gap between appointment and special-election terms',()=>{
 const i=loadIdentityIndex();
 for(const d of ['2026-11-03','2026-11-04','2026-11-20','2026-11-26'])assert.equal(i.personForVoter('senate','S439',d),'M001244');
});
test('superseded d5af3d2 snapshot is rejected by the current contract',()=>{
 const old=fileURLToPath(new URL('../fixtures/votes/identity/legislators-d5af3d2-voting-terms.json',import.meta.url));
 assert.throws(()=>loadIdentityIndex(old,'582e5b3e825b54b323c7720cac0f39d6d92e42baf1c009ccb78702a863ac9fe8'),code('invalid_snapshot'));
});
