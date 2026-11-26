/** Hash-pinned, dated identity. This snapshot is provenance, not name inference.
 * Dates are trusted only within [floor, as_of]; as_of is the capture date of the
 * pinned inputs, so later dates fail closed until the pin is refreshed. */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {OfficialVoteFailure} from './official-vote-types.js';
import {isIsoDate, type Chamber} from './vote-source.js';
export const IDENTITY_SNAPSHOT_PATH=fileURLToPath(new URL('../fixtures/votes/identity/legislators-2b1fe72-voting-terms.json',import.meta.url));
export const IDENTITY_SNAPSHOT_SHA256='c5c8509eb23ad9e414644810cfef5f160508b87a1cd4a3472ebea2af1fa2fe46';
export interface IdentityIndex {
 commit:string;snapshotSha256:string;floor:string;asOf:string;
 personForVoter(chamber:Chamber,voterId:string,date:string):string;
 inService(bioguide:string,chamber:Chamber,date:string):boolean;
}
interface Person {bioguide:string;lis:string|null;terms:Array<{chamber:Chamber;start:string;end:string;state:string;district:number|null}>}
function fail(code:string,message:string):never {throw new OfficialVoteFailure('identity',code,message);}
export function loadIdentityIndex(path=IDENTITY_SNAPSHOT_PATH,expectedSha256=IDENTITY_SNAPSHOT_SHA256):IdentityIndex {
 let bytes:Buffer;try{bytes=readFileSync(path);}catch(e){return fail('snapshot_unreadable',String(e));}
 const hash=createHash('sha256').update(bytes).digest('hex');
 if(hash!==expectedSha256)return fail('snapshot_hash_mismatch','identity snapshot differs from pinned hash');
 let snapshot:any;try{snapshot=JSON.parse(bytes.toString('utf8'));}catch(e){return fail('invalid_snapshot',String(e));}
 if(snapshot?.contract!=='civiclens.official-vote-identity'||snapshot.version!==2||snapshot.source?.commit!=='2b1fe728159fe5f5e145277794106e800719eb50'||snapshot.floor!=='2019-01-03'||snapshot.as_of!=='2026-11-24'||!Array.isArray(snapshot.people)||snapshot.people.length===0)fail('invalid_snapshot','invalid identity contract');
 const byBio=new Map<string,Person>(),byLis=new Map<string,Person>();
 for(const p of snapshot.people as Person[]){
  if(!p||typeof p.bioguide!=='string'||!/^[A-Z]\d{6}$/.test(p.bioguide)||byBio.has(p.bioguide)||!Array.isArray(p.terms)||!p.terms.length)fail('invalid_snapshot','missing or duplicate person');
  if(p.lis!==null&&(typeof p.lis!=='string'||!/^S\d+$/.test(p.lis)||byLis.has(p.lis)))fail('invalid_snapshot','invalid or duplicate LIS');
  for(const t of p.terms)if(!['house','senate'].includes(t.chamber)||!isIsoDate(t.start)||!isIsoDate(t.end)||t.start>t.end||t.end<snapshot.floor)fail('invalid_snapshot','invalid dated term');
  byBio.set(p.bioguide,p);if(p.lis!==null)byLis.set(p.lis,p);
 }
 function validate(chamber:Chamber,date:string){if(!['house','senate'].includes(chamber))fail('unsupported_chamber',String(chamber));if(!isIsoDate(date))fail('invalid_date',String(date));if(date<snapshot.floor)fail('date_before_floor',`${date} before ${snapshot.floor}`);if(date>snapshot.as_of)fail('date_after_snapshot',`${date} after snapshot as_of ${snapshot.as_of}`);}
 function serves(p:Person,chamber:Chamber,date:string){return p.terms.some(t=>t.chamber===chamber&&t.start<=date&&date<=t.end);}
 return {commit:snapshot.source.commit,snapshotSha256:hash,floor:snapshot.floor,asOf:snapshot.as_of,
  personForVoter(chamber,voterId,date){validate(chamber,date);const p=(chamber==='house'?byBio:byLis).get(voterId);if(!p)fail('unmapped_voter',`${chamber} ${voterId}`);if(!serves(p,chamber,date))fail('voter_not_in_service',`${voterId} on ${date}`);return p.bioguide;},
  inService(bioguide,chamber,date){validate(chamber,date);const p=byBio.get(bioguide);if(!p)fail('unmapped_voter',`unknown target ${bioguide}`);return serves(p,chamber,date);},
 };
}
