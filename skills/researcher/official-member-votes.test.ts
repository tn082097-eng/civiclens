/** SYNTHETIC controls except explicitly frozen pinned bridge sample tests. No HTTP. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {analyzeRoll,classifyRoll,normalizeMemberVotes,loadWindowRun} from './official-member-votes.js';
import {loadIdentityIndex,type IdentityIndex} from '../../lib/official-identity.js';
import {OfficialVoteFailure,type HouseRaw,type SenateRaw,type BridgeRollInput,type BridgeRollOk,type BridgeRun,type WindowRun} from '../../lib/official-vote-types.js';
import {houseSourceUrl,senateSourceUrl} from '../../lib/vote-source.js';
const hash='a'.repeat(64),identity=loadIdentityIndex();
const failure=(code:string)=>(e:unknown)=>e instanceof OfficialVoteFailure&&e.code===code;
function syntheticHouse():HouseRaw{return {chamber:'house',congress:119,session:1,roll:6,date:'2025-01-07',legis_num:'H R 29',vote_type:'YEA-AND-NAY',question:'On Passage',vote_desc:'SYNTHETIC test bill',result:'Passed',amendment_num:null,totals:{kind:'by_vote',yea:1,nay:1,present:0,not_voting:0},voters:[{id:'A000370',raw_position:'Nay'},{id:'A000055',raw_position:'Yea'}]};}
function syntheticSenate():SenateRaw{return {chamber:'senate',congress:119,session:1,roll:3,date:'2025-01-15',question:'On the Amendment',vote_title:'SYNTHETIC amendment',result:'Agreed to',document:{document_congress:'119',document_type:'S.Amdt.',document_number:'',document_name:'',amendment_number:'S.Amdt. 14',amendment_to_document_number:'S. 5'},count:{yeas:0,nays:1,present:1,absent:0},tie_breaker:{by_whom:'',vote:''},voters:[{id:'S428',raw_position:'Nay'},{id:'S354',raw_position:'Present, Giving Live Pair'}]};}
function result(raw:HouseRaw|SenateRaw):BridgeRollOk {const votes:Record<string,unknown[]>={};for(const v of raw.voters){const option=v.raw_position==='Present, Giving Live Pair'?'Present':v.raw_position;(votes[option]??=[]).push({id:v.id});}return {key:`119-2025/${raw.chamber==='house'?'h':'s'}${raw.roll}`,ok:true,raw,collector:{votes,bill:raw.chamber==='house'?{congress:119,type:'hr',number:29}:{congress:119,type:'s',number:5}}};}
function input(r:BridgeRollOk):BridgeRollInput{return {key:r.key,chamber:r.raw.chamber,congress:119,session:1,year:2025,roll:r.raw.roll,date:r.raw.date,source_url:r.raw.chamber==='house'?houseSourceUrl(2025,r.raw.roll):senateSourceUrl(119,1,r.raw.roll),path:'/SYNTHETIC/no-body-needed-here',sha256:hash};}
function args(results:BridgeRollOk[]=[result(syntheticHouse())],member='A000370',idx=identity){const chamber=results[0].raw.chamber;const run:WindowRun={contract:'civiclens.official-vote-window-run',contract_version:1,chamber,mode:'window',as_of:'2025-01-16',window:['2021-01-16','2025-01-16'],months:48,status:'complete',reason:'SYNTHETIC control; not coverage evidence',started_at:'2025-01-16T00:00:00Z',finished_at:'2025-01-16T00:00:01Z',discovery:{inventory_path:'discovery/inventory.json',inventory_sha256:hash,index_pages_verified:5},manifest_path:'acquisition/manifest.json',manifest_sha256:hash};const bridge:BridgeRun={bridge:'civiclens.congress-collector-bridge',bridge_version:1,collector:{repository:'https://github.com/unitedstates/congress',commit:'8184bcb13160da2389dea4c902de67817db681fc',vendor_manifest_sha256:hash},runtime:{python:'SYNTHETIC',lock_sha256:hash,packages:{}},network:{interfaces:[]},inference_disabled:['lookup_legislator','require_congress_legislators_repo','download'],results};return {runDir:'/SYNTHETIC',run,bridge,bridgeInputs:results.map(input),identity:idx,bioguideId:member,chamber,asOf:'2025-01-16'};}
test('synthetic voter set, option, duplicate, malformed list, identity and total cross-check failures',()=>{
 for(const mutate of [(r:BridgeRollOk)=>{(r.collector.votes as any).Yea=[];},(r:BridgeRollOk)=>{(r.collector.votes as any).Nay[0].id='UNKNOWN';},(r:BridgeRollOk)=>{(r.collector.votes as any).Nay.push({id:'A000055'});},(r:BridgeRollOk)=>{r.collector.votes={Nay:'bad'};},(r:BridgeRollOk)=>{r.raw.roll=9;},(r:BridgeRollOk)=>{(r.raw as HouseRaw).totals={kind:'by_vote',yea:2,nay:1,present:0,not_voting:0};}]){const r=result(syntheticHouse()),i=input(r);mutate(r);assert.throws(()=>analyzeRoll(i,r,identity),failure('cross_check_mismatch'));}
});
test('bridge failure is typed and propagated',()=>{const r=result(syntheticHouse());assert.throws(()=>analyzeRoll(input(r),{key:r.key,ok:false,outcome:'incomplete_fetch',reason:'SYNTHETIC'},identity),failure('incomplete_fetch'));});
test('synthetic unknown LIS and before-floor fail',()=>{const r=result(syntheticSenate());r.raw.voters[0].id='S999999';r.collector.votes={Nay:[{id:'S999999'}],Present:[{id:'S354'}]};assert.throws(()=>analyzeRoll(input(r),r,identity),failure('unmapped_voter'));const h=result(syntheticHouse());h.raw.date='2018-01-01';assert.throws(()=>analyzeRoll(input(h),h,identity),failure('date_before_floor'));});
test('synthetic duplicate-person mapping fails',()=>{const r=result(syntheticHouse());const fake:IdentityIndex={...identity,personForVoter:()=> 'A000370'};assert.throws(()=>analyzeRoll(input(r),r,fake),failure('duplicate_person'));});
test('synthetic Speaker candidate context yields other and unsupported bill identity',()=>{const raw=syntheticHouse();raw.legis_num='';raw.question='Election of the Speaker';raw.totals={kind:'by_candidate',candidates:[{name:'SYNTHETIC candidate',total:2}]};raw.voters.forEach(v=>v.raw_position='SYNTHETIC candidate');const r=result(raw);delete r.collector.bill;const analysis=analyzeRoll(input(r),r,identity);assert.equal(analysis.voters.get('A000370')?.vote,'other');assert.equal(analysis.resolution.outcome,'unsupported_record');raw.question='Another question';assert.throws(()=>analyzeRoll(input(r),r,identity),failure('unsupported_position'));});
test('synthetic Senate pair rewrite is the sole allowed rewrite',()=>{const r=result(syntheticSenate());assert.equal(analyzeRoll(input(r),r,identity).voters.get(identity.personForVoter('senate','S354',r.raw.date))?.vote,'other');(r.collector.votes as any).Present=[{id:'S428'},{id:'S354'}];(r.collector.votes as any).Nay=[];assert.throws(()=>analyzeRoll(input(r),r,identity),failure('cross_check_mismatch'));});
test('synthetic member coverage missing row stays notRecorded',()=>{const one=result(syntheticHouse()),two=result(syntheticHouse());two.key='119-2025/h7';two.raw.roll=7;two.raw.voters=two.raw.voters.slice(1);(two.raw as HouseRaw).totals={kind:'by_vote',yea:1,nay:0,present:0,not_voting:0};two.collector.votes={Yea:[{id:'A000055'}]};const out=normalizeMemberVotes(args([one,two]));assert.equal(out.votes.length,1);assert.equal(out.coverage.notRecorded,1);assert.deepEqual(out.coverage.notRecordedKeys,['119-2025/h7']);assert.equal(out.votes[0].vote,'nay');});
test('synthetic never recorded, unknown target, appears out of service, incomplete and zero required fail',()=>{const r=result(syntheticHouse());assert.throws(()=>normalizeMemberVotes(args([r],'A000371')),failure('member_never_recorded'));assert.throws(()=>normalizeMemberVotes(args([r],'UNKNOWN')),failure('unmapped_voter'));assert.throws(()=>normalizeMemberVotes(args([r],'A000370',{...identity,inService:()=>false})),failure('appears_out_of_service'));const a=args([r]);a.run.status='incomplete';assert.throws(()=>normalizeMemberVotes(a),failure('incomplete_run'));const b=args([r]);b.bridgeInputs=[];b.bridge.results=[];assert.throws(()=>normalizeMemberVotes(b),failure('zero_required_rolls'));});
test('synthetic classifier disagreement and amendment parent semantics',()=>{const r=result(syntheticHouse());(r.collector.bill as any).number=999;assert.equal(classifyRoll(r.raw,r.collector).outcome,'ambiguity');const s=result(syntheticSenate());assert.equal(classifyRoll(s.raw,s.collector).billId,'119-s-5');});
test('incomplete and zero-required saved runs throw typed failures',()=>{const dir=mkdtempSync(join(tmpdir(),'official-run-'));try{const a=args();a.run.status='incomplete';writeFileSync(join(dir,'window-run.json'),JSON.stringify(a.run));assert.throws(()=>loadWindowRun(dir),failure('incomplete_run'));a.run.status='complete';const m={contract:'civiclens.official-vote-acquisition',contract_version:1,chamber:'house',status:'acquisition_complete',required_rolls:0,records:[]};const bytes=Buffer.from(JSON.stringify(m));mkdirSync(join(dir,'acquisition'));writeFileSync(join(dir,'acquisition/manifest.json'),bytes);a.run.manifest_sha256=createHash('sha256').update(bytes).digest('hex');writeFileSync(join(dir,'window-run.json'),JSON.stringify(a.run));assert.throws(()=>loadWindowRun(dir),failure('zero_required_rolls'));}finally{rmSync(dir,{recursive:true,force:true});}});
test('real frozen bridge outputs account for every voter including out-of-service listings',()=>{
 const bridge=JSON.parse(readFileSync(new URL('../../fixtures/votes/collector-output/bridge-run-official-samples.json',import.meta.url),'utf8')) as BridgeRun;
 assert.equal(bridge.results.length,7);
 for(const r of bridge.results){assert.ok(r.ok);if(!r.ok)continue;const i=input(r);i.congress=r.raw.congress;i.date=r.raw.date;
  const a=analyzeRoll(i,r,identity);
  assert.equal(a.voters.size+a.outOfServiceListings.length,r.raw.voters.length);
  if(r.key==='119-2025/h1')assert.deepEqual(a.outOfServiceListings,[{rollKey:r.key,chamber:'house',voterId:'G000578',rawPosition:'Not Voting',date:'2025-01-03'}]);
 }
});

// SYNTHETIC listing added to a small roll; identities come from the pinned snapshot.
function withListing(id='G000578', position='Not Voting'):BridgeRollOk {
 const raw=syntheticHouse();raw.voters.push({id,raw_position:position});
 if(raw.totals.kind==='by_vote'){
  if(position==='Not Voting')raw.totals.not_voting++;
  else if(position==='Yea')raw.totals.yea++;
  else if(position==='Nay')raw.totals.nay++;
  else if(position==='Present')raw.totals.present++;
 }
 return result(raw);
}
test('known out-of-service Not Voting row is retained without attributing a vote',()=>{
 const r=withListing();const a=analyzeRoll(input(r),r,identity);
 assert.equal(a.voters.has('G000578'),false);
 assert.deepEqual(a.outOfServiceListings,[{rollKey:r.key,chamber:'house',voterId:'G000578',rawPosition:'Not Voting',date:r.raw.date}]);
 const out=normalizeMemberVotes(args([r]));
 assert.deepEqual(out.coverage.outOfServiceListings,a.outOfServiceListings);
 assert.equal(out.coverage.recorded,1);assert.equal(out.coverage.notRecorded,0);
});
test('out-of-service target gets evidence only, without an absent vote or in-service count',()=>{
 const out=normalizeMemberVotes(args([withListing()],'G000578'));
 assert.deepEqual(out.votes,[]);assert.equal(out.coverage.inServiceRolls,0);
 assert.equal(out.coverage.recorded,0);assert.equal(out.coverage.notRecorded,0);
 assert.deepEqual(out.coverage.notRecordedKeys,[]);
 assert.equal(out.coverage.outOfServiceListings?.length,1);
});
test('unknown Not Voting and actual out-of-service votes remain failures',()=>{
 const unknown=withListing('X999999');assert.throws(()=>analyzeRoll(input(unknown),unknown,identity),failure('unmapped_voter'));
 for(const position of ['Yea','Nay','Present']){
  const r=withListing('G000578',position);assert.throws(()=>analyzeRoll(input(r),r,identity),failure('voter_not_in_service'));
 }
});
test('Senate LIS listings use the same generic rule and keep strict lookup behavior',()=>{
 const raw=syntheticSenate();raw.voters.push({id:'S289',raw_position:'Not Voting'});raw.count.absent++;
 const r=result(raw);const a=analyzeRoll(input(r),r,identity);
 assert.deepEqual(a.outOfServiceListings,[{rollKey:r.key,chamber:'senate',voterId:'S289',rawPosition:'Not Voting',date:raw.date}]);
 assert.equal(a.voters.size,2);
 assert.throws(()=>identity.personForVoter('senate','S289',raw.date),failure('voter_not_in_service'));
 assert.deepEqual(analyzeRoll(input(result(syntheticHouse())),result(syntheticHouse()),identity).outOfServiceListings,[]);
});
test('listing exception never bypasses total, duplicate or collector cross-checks',()=>{
 const duplicate=withListing();duplicate.raw.voters.push({...duplicate.raw.voters[2]});
 assert.throws(()=>analyzeRoll(input(duplicate),duplicate,identity),failure('cross_check_mismatch'));
 const totals=withListing();if(totals.raw.chamber==='house'&&totals.raw.totals.kind==='by_vote')totals.raw.totals.not_voting=0;
 assert.throws(()=>analyzeRoll(input(totals),totals,identity),failure('cross_check_mismatch'));
 const collector=withListing();delete (collector.collector.votes as any)['Not Voting'];
 assert.throws(()=>analyzeRoll(input(collector),collector,identity),failure('cross_check_mismatch'));
});
