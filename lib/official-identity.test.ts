import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
