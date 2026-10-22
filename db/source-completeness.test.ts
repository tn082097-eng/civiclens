import {test} from 'node:test';
import assert from 'node:assert/strict';
import {backfillBillIds,fetchSummary} from './load-bill-summaries.js';
import {fetchAllSponsored,loadSponsored} from './load-sponsored.js';
import {tempDb,insertMember,snapshot} from './__testkit__/temp-db.js';
import {OfficialVoteFailure} from '../lib/official-vote-types.js';

// SYNTHETIC resolver outcomes; legacy URLs are provenance, never active fetches.
for (const mode of ['http-error','malformed','authoritative-non-bill','unsupported-record'] as const) {
 test(`official bill resolution distinguishes ${mode}`, async t => {
  const {conn,cleanup}=await tempDb();
  try {
   await insertMember(conn,{memberId:'jane-doe',name:'Jane Doe',chamber:'house'});
   await conn.run("INSERT INTO votes(member_id,vote_id,date,question,source_url,fetched_at) VALUES ('jane-doe','119-2025/h6','2025-01-07','On the motion','https://www.govtrack.us/congress/votes/119-2025/h6',CURRENT_TIMESTAMP)");
   const before=await snapshot(conn,'votes','member_id,vote_id');
   const fetch=t.mock.method(globalThis,'fetch',async()=>{throw Error('unexpected direct network request');});
   let resolverCalled=false;
   const run=()=>backfillBillIds({kind:'member',slug:'jane-doe',memberId:'jane-doe',bioguideId:'H001047',chamber:'house'},{conn,officialPass:true,resolveRolls:async requests=>{
    resolverCalled=true;assert.deepEqual(requests,[{key:'119-2025/h6',date:'2025-01-07'}]);
    if(mode==='http-error'||mode==='malformed')return [{key:requests[0].key,ok:false,failure:{stage:'acquisition',code:mode==='http-error'?'http_error':'malformed_source',message:`SYNTHETIC ${mode}`}}];
    return [{key:requests[0].key,date:requests[0].date,ok:true,sourceUrl:'https://clerk.house.gov/evs/2025/roll006.xml',resolution:mode==='authoritative-non-bill'?{outcome:'authoritative_non_bill',billId:null,subtype:'quorum',amendment:null,reason:null}:{outcome:'unsupported_record',billId:null,subtype:null,amendment:null,reason:'SYNTHETIC unsupported source identity'}}];
   }});
   if(mode==='authoritative-non-bill'||mode==='unsupported-record'){
    const r=await run();assert.equal(r.skipped,1);assert.equal(r.officialResolved,0);
    assert.equal(r.nonBill,mode==='authoritative-non-bill'?1:0);assert.equal(r.unresolved,mode==='unsupported-record'?1:0);
   }else await assert.rejects(run,(e:unknown)=>e instanceof OfficialVoteFailure&&e.code==='legacy_roll_resolution_failed'&&e.details.some(d=>d.includes(mode==='http-error'?'http_error':'malformed_source')));
   assert.equal(resolverCalled,true);assert.equal(fetch.mock.callCount(),0);
   assert.equal(await snapshot(conn,'votes','member_id,vote_id'),before);
  } finally {cleanup();}
 });
}

test('summary fallback HTTP failure cannot become an empty summary',async t=>{
 let n=0;t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({summaries:[]}),{status:++n===1?200:503}));
 await assert.rejects(()=>fetchSummary('119-hr-1'));
});

test('sponsored pagination must reach the advertised total',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({sponsoredLegislation:[{congress:119,type:'HR',number:1}],pagination:{count:2}})));
 await assert.rejects(()=>fetchAllSponsored('X','not-a-real-key'),/incomplete|count/i);
});

test('a sponsored fetch failure propagates through the loader',async t=>{
 const {conn,cleanup}=await tempDb();try{
  await insertMember(conn,{memberId:'jane-doe',name:'Jane Doe',chamber:'house',bioguideId:'X'});
  t.mock.method(globalThis,'fetch',async()=>new Response('',{status:503}));
  await assert.rejects(()=>loadSponsored({memberId:'jane-doe',conn,apiKey:'test-only'}),/503/);
 }finally{cleanup();}
});
