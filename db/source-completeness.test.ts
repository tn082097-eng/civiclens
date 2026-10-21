import {test} from 'node:test';
import assert from 'node:assert/strict';
import {backfillBillIds,fetchSummary} from './load-bill-summaries.js';
import {fetchAllSponsored,loadSponsored} from './load-sponsored.js';
import {tempDb,insertMember} from './__testkit__/temp-db.js';

for (const mode of ['http-error','malformed','verified-empty'] as const) {
 test(`bill resolution distinguishes ${mode}`, async t => {
  const {conn,cleanup}=await tempDb();
  try {
   await insertMember(conn,{memberId:'jane-doe',name:'Jane Doe',chamber:'house'});
   await conn.run("INSERT INTO votes(member_id,vote_id,question,source_url,fetched_at) VALUES ('jane-doe','h1','On the motion','https://www.govtrack.us/congress/votes/119-2025/h1',CURRENT_TIMESTAMP)");
   t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(mode==='malformed'?{}:{objects:[{related_bill:null}]}),{status:mode==='http-error'?503:200}));
   const run=()=>backfillBillIds({kind:'member',slug:'jane-doe',memberId:'jane-doe',bioguideId:'X',chamber:'house'},{conn,apiPass:true});
   if(mode==='verified-empty'){const r=await run();assert.equal(r.skipped,1);}else await assert.rejects(run);
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
