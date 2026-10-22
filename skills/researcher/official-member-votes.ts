/** Strict offline normalization. Acquisition completeness and member participation are separate gates. */
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {classifyHouseRoll,classifySenateRoll,normalizePosition,parseRollKey,rollKey,sessionYear,houseSourceUrl,senateSourceUrl,coverageWindow,isIsoDate,type Chamber,type NormalizedPosition} from '../../lib/vote-source.js';
import {OfficialVoteFailure,type OfficialVoteStage,type WindowRun,type BridgeRollInput,type BridgeRollOk,type BridgeRollFail,type BridgeRun,type HouseRaw,type SenateRaw,type OfficialVoteResolution,type OfficialMemberVotes,type OfficialVoteRecord,type OutOfServiceListing} from '../../lib/official-vote-types.js';
import type {IdentityIndex} from '../../lib/official-identity.js';
import {validateAcquisitionManifest,verifyResponseBodies,type AcquisitionManifest,type AcquisitionResponse} from './official-votes.js';

export interface AcquisitionManifestLike {
 contract:string;contract_version:number;chamber:Chamber;status:string;
 started_at:string;finished_at:string|null;window:[string,string]|null;window_policy:{as_of:string|null;months:number|null};
 inventory_sha256:string;index_pages_verified:number;published_rolls:number;required_rolls:number;attempted_rolls:number;max_rolls:number|null;safety_cap_applied:boolean;counts:Record<string,number>;
 acquisition_semantics:string;normalized_votes_validated:boolean;member_coverage_validated:boolean;bill_resolution_validated:boolean;collector_revision:unknown;
 records:Array<{key:string;chamber:Chamber;congress:number;session:1|2;year:number;roll:number;date:string;status:string|null;url:string;page:number;index_receipt:Record<string,unknown>;source_url:string;in_window:boolean;attempted:boolean;attempted_at:string|null;outcome:string;reason:string|null;response:AcquisitionResponse|null;metadata:Record<string,unknown>|null}>;
}
export interface RollAnalysis {input:BridgeRollInput;raw:HouseRaw|SenateRaw;resolution:OfficialVoteResolution;voters:Map<string,{vote:NormalizedPosition;rawPosition:string}>;outOfServiceListings:OutOfServiceListing[]}
const PIN='8184bcb13160da2389dea4c902de67817db681fc';
const SHA=/^[a-f0-9]{64}$/;
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const obj=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const count=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0;
function fail(stage:OfficialVoteStage,code:string,msg:string,details:string[]=[]):never{throw new OfficialVoteFailure(stage,code,msg,details);}
function ensure(condition:unknown,stage:OfficialVoteStage,code:string,msg:string):asserts condition {if(!condition)fail(stage,code,msg);}
function readSafe(root:string,name:string):{path:string;body:Buffer}{
 ensure(typeof name==='string'&&name.length&&!isAbsolute(name)&&!name.includes('..')&&!name.includes('\\'),'acquisition','unsafe_path',String(name));
 const base=realpathSync(root),path=resolve(base,name);ensure(!relative(base,path).startsWith('..'),'acquisition','unsafe_path',name);
 let p=path;while(p!==base){ensure(!lstatSync(p).isSymbolicLink(),'acquisition','unsafe_path','symlink source');p=dirname(p);}
 return {path,body:readFileSync(path)};
}
function jsonFile(root:string,name:string,expected?:string):any{const {body}=readSafe(root,name);if(expected!==undefined)ensure(SHA.test(expected)&&sha(body)===expected,'acquisition','hash_mismatch',name);return JSON.parse(body.toString('utf8'));}
function canonical(r:any,chamber:Chamber){const id=parseRollKey(r.key);ensure(id.chamber===chamber&&r.chamber===chamber&&id.congress===r.congress&&id.session===r.session&&id.year===r.year&&id.roll===r.roll&&isIsoDate(r.date)&&r.date.slice(0,4)===String(id.year),'acquisition','invalid_manifest',`roll identity ${r.key}`);return id;}
function source(r:{chamber:Chamber;year:number;roll:number;congress:number;session:1|2}){return r.chamber==='house'?houseSourceUrl(r.year,r.roll):senateSourceUrl(r.congress,r.session,r.roll);}
function equal(a:unknown,b:unknown):boolean {if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>equal(v,b[i]));if(obj(a)&&obj(b)){const ka=Object.keys(a).sort(),kb=Object.keys(b).sort();return equal(ka,kb)&&ka.every(k=>equal(a[k],b[k]));}return a===b;}
function validateCompleteManifest(m:AcquisitionManifestLike,run:WindowRun,runDir:string){
 ensure(obj(m)&&m.contract==='civiclens.official-vote-acquisition'&&m.contract_version===1&&m.chamber===run.chamber,'acquisition','invalid_manifest','manifest contract/chamber');
 ensure(m.status==='acquisition_complete','acquisition','incomplete_manifest','manifest did not complete');
 ensure(Array.isArray(m.records),'acquisition','invalid_manifest','missing records');
 ensure(m.required_rolls>0&&m.records.some(r=>r.in_window),'coverage','zero_required_rolls','no required rolls');
 ensure(m.acquisition_semantics==='downloaded_and_identity_checked_only'&&m.normalized_votes_validated===false&&m.member_coverage_validated===false&&m.bill_resolution_validated===false&&m.collector_revision===null,'acquisition','invalid_manifest','manifest semantics');
 ensure(typeof m.started_at==='string'&&!!m.started_at&&typeof m.finished_at==='string'&&!!m.finished_at&&SHA.test(m.inventory_sha256)&&count(m.index_pages_verified)&&m.max_rolls===null&&m.safety_cap_applied===false,'acquisition','invalid_manifest','manifest fields or cap');
 if(run.mode==='window')ensure(equal(m.window,run.window)&&m.window_policy?.as_of===run.as_of&&m.window_policy?.months===48,'coverage','window_mismatch','manifest must cover exact 48 calendar months');
 else ensure(m.window===null&&m.window_policy?.as_of===null&&m.window_policy?.months===null,'acquisition','invalid_manifest','rolls manifest window must be null');
 const keys=new Set<string>();const counts:Record<string,number>={};let required=0,attempted=0;
 for(const r of m.records){
  ensure(obj(r),'acquisition','invalid_manifest','invalid record');canonical(r,run.chamber);
  ensure(!keys.has(r.key),'acquisition','invalid_manifest','duplicate key');keys.add(r.key);
  ensure(typeof r.in_window==='boolean'&&typeof r.attempted==='boolean'&&(r.status===null||typeof r.status==='string')&&typeof r.url==='string'&&Number.isSafeInteger(r.page)&&r.page>0&&obj(r.index_receipt)&&(r.reason===null||typeof r.reason==='string'),'acquisition','invalid_manifest','record field types');
  ensure(r.source_url===source(r),'acquisition','invalid_manifest','noncanonical source URL');
  const expected=run.mode==='rolls'||(run.window![0]<=r.date&&r.date<=run.window![1]);ensure(r.in_window===expected,'acquisition','invalid_manifest','wrong window selection');
  counts[r.outcome]=(counts[r.outcome]??0)+1;if(r.in_window)required++;if(r.attempted)attempted++;
  if(!r.in_window){ensure(r.outcome==='excluded_outside_window'&&r.attempted===false&&r.attempted_at===null&&r.response===null&&r.metadata===null,'acquisition','invalid_manifest','outside-window record was not excluded');continue;}
  ensure(r.outcome==='acquired','acquisition','incomplete_manifest',`${r.key}: ${r.outcome}`);
  const p=r.response,t=r.metadata;
  ensure(r.attempted===true&&typeof r.attempted_at==='string'&&!!r.attempted_at&&obj(p)&&obj(t),'acquisition','invalid_manifest','acquired record lacks receipt/metadata');
  ensure(p.http_status===200&&p.body_complete===true&&p.read_error===null&&p.final_url===r.source_url&&p.url===r.source_url&&typeof p.content_type==='string'&&count(p.bytes)&&p.bytes>0&&p.bytes<=5*1024*1024&&SHA.test(p.sha256)&&typeof p.attempted_at==='string'&&typeof p.received_at==='string','acquisition','invalid_manifest','invalid acquired response');
  const retained=readSafe(resolve(runDir,'acquisition'),p.path);ensure(retained.body.length===p.bytes&&sha(retained.body)===p.sha256,'acquisition','response_body_mismatch',r.key);
  ensure(t.key===r.key&&t.chamber===r.chamber&&t.congress===r.congress&&t.session===r.session&&t.roll===r.roll&&t.date===r.date,'acquisition','invalid_manifest','metadata identity mismatch');
  const strings=r.chamber==='house'?['legis_num','question','vote_type','result','vote_desc']:['question','vote_title','result','document_type','document_number','document_congress','amendment_number','amendment_to_document_number'];
  ensure(strings.every(f=>typeof t[f]==='string')&&Number.isSafeInteger(t.recorded_vote_count)&&Number(t.recorded_vote_count)>0&&obj(t.position_tokens)&&Object.values(t.position_tokens).every(v=>Number.isSafeInteger(v)&&Number(v)>0)&&Object.values(t.position_tokens).reduce<number>((n,v)=>n+Number(v),0)===t.recorded_vote_count,'acquisition','invalid_manifest','metadata types/counts');
  if(r.chamber==='house')ensure(['amendment_num','amendment_author'].every(f=>t[f]===null||typeof t[f]==='string'),'acquisition','invalid_manifest','amendment types');
 }
 ensure(m.published_rolls===m.records.length&&m.required_rolls===required&&m.attempted_rolls===attempted&&equal(m.counts,counts),'acquisition','invalid_manifest','manifest count mismatch');
 if(run.chamber==='house'&&run.mode==='window'){
  const verdict=validateAcquisitionManifest(m,{window:{start:run.window![0],end:run.window![1]},coverageMonths:48});
  ensure(verdict.verdict==='complete','acquisition','invalid_manifest','House shared manifest validator rejected manifest');
  ensure(verifyResponseBodies(m as unknown as AcquisitionManifest,resolve(runDir,'acquisition')).length===0,'acquisition','response_body_mismatch','House response verification failed');
 }
}

/** Reconcile every saved page/menu, inventory row and acquisition record. No selected-fixture shortcut. */
function validateDiscovery(runDir:string,run:WindowRun,m:AcquisitionManifestLike){
 const d=run.discovery;ensure(obj(d)&&typeof d.inventory_path==='string'&&typeof d.inventory_sha256==='string'&&count(d.index_pages_verified),'discovery','invalid_inventory','missing discovery');
 const packet=jsonFile(runDir,d.inventory_path,d.inventory_sha256);ensure(obj(packet)&&equal(packet.window,run.window)&&Array.isArray(packet.summary)&&Array.isArray(packet.receipts)&&Array.isArray(packet.inventory),'discovery','invalid_inventory','packet shape/window');
 const expectedYears=Array.from({length:Number(run.window![1].slice(0,4))-Number(run.window![0].slice(0,4))+1},(_,n)=>Number(run.window![0].slice(0,4))+n);
 ensure(equal(packet.summary.map((s:any)=>s.year).sort(),expectedYears)&&packet.receipts.length===d.index_pages_verified&&d.index_pages_verified===m.index_pages_verified&&m.inventory_sha256===d.inventory_sha256,'discovery','invalid_inventory','session or receipt coverage mismatch');
 const discoveryRoot=dirname(resolve(runDir,d.inventory_path));let selected=0;const rawRows:any[]=[];const receiptByYearPage=new Map<string,any>();const paths=new Set<string>();
 for(const summary of packet.summary){
  const year=summary.year,c=(year-1789)/2;const congress=Math.floor(c)+1,session=year%2?1:2;
  const receipts=packet.receipts.filter((r:any)=>run.chamber==='house'?r.url?.includes(`CongressNum=${congress}&Session=${session===1?'1st':'2nd'}&`):r.url===`https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_${congress}_${session}.xml`);
  ensure(Number.isSafeInteger(summary.published_total)&&summary.published_total>0&&summary.pages===(run.chamber==='house'?Math.ceil(summary.published_total/10):1)&&receipts.length===summary.pages,'discovery','invalid_inventory','missing complete session pages');
  const sessionRows:any[]=[];const pages=new Set<number>();
  for(const receipt of receipts){
   ensure(obj(receipt)&&!paths.has(receipt.path)&&receipt.status===200&&SHA.test(receipt.sha256)&&typeof receipt.fetched_at==='string'&&Number.isFinite(Date.parse(receipt.fetched_at)),'discovery','invalid_inventory','invalid/duplicate receipt');paths.add(receipt.path);
   const {body}=readSafe(discoveryRoot,receipt.path);ensure(sha(body)===receipt.sha256&&(receipt.bytes===undefined||body.length===receipt.bytes)&&receipt.body_complete!==false&&(receipt.read_error===undefined||receipt.read_error===null)&&(receipt.final_url===undefined||receipt.final_url===receipt.url),'discovery','invalid_inventory','page receipt/body mismatch');
   const text=body.toString('utf8');ensure(!/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(text),'discovery','invalid_inventory','unsupported XML entity');
   if(run.chamber==='house'){
    const match=/^https:\/\/clerk\.house\.gov\/Votes\/MemberVotes\?CongressNum=(\d+)&Session=(1st|2nd)&Page=([1-9]\d*)$/.exec(receipt.url);ensure(match&&Number(match[1])===congress&&match[2]===(session===1?'1st':'2nd'),'discovery','invalid_inventory','listing identity');const page=Number(match[3]);ensure(!pages.has(page)&&page<=summary.pages,'discovery','invalid_inventory','duplicate page');pages.add(page);
    const counters=[...text.matchAll(/class="pagination_info">\s*(\d+)\s*-\s*(\d+)\s+of\s+(\d+) Results/g)].map(v=>[Number(v[1]),Number(v[2]),Number(v[3])]);const start=(page-1)*10+1,end=Math.min(page*10,summary.published_total);
    ensure(counters.length>0&&counters.every(v=>equal(v,[start,end,summary.published_total]))&&equal(receipt.range,[start,end])&&receipt.total===summary.published_total,'discovery','invalid_inventory','listing counter/total mismatch');
    for(const block of text.split('<div class="role-call-vote">').slice(1)){
     const row=/Roll Call Number:\s*<a href="\/Votes\/(\d{4})(\d+)[^"]*"[^>]*>(\d+)<\/a>/.exec(block),date=/([A-Z][a-z]{2}) (\d{1,2}), (\d{4}),/.exec(block),status=/<label>Status:<\/label>\s*([^<]+)/.exec(block);ensure(row&&date&&Number(row[1])===year&&Number(row[2])===Number(row[3]),'discovery','invalid_inventory','unparsed listing row');const month=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(date[1])+1;const day=`${date[3]}-${String(month).padStart(2,'0')}-${date[2].padStart(2,'0')}`;ensure(isIsoDate(day)&&day.slice(0,4)===String(year),'discovery','invalid_inventory','listing date');sessionRows.push({year,roll:Number(row[2]),date:day,status:status?decodeEntities(status[1]).trim()||null:null,url:`https://clerk.house.gov/Votes/${year}${Number(row[2])}`,page});
    }
    ensure(sessionRows.filter(r=>r.page===page).length===end-start+1,'discovery','invalid_inventory','listing row count mismatch');receiptByYearPage.set(`${year}/${page}`,receipt);
   }else{
    ensure(/<vote_summary[\s>]/.test(text),'discovery','invalid_inventory','wrong menu root');const scalar=(name:string)=>{const values=[...text.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`,'g'))];ensure(values.length===1,'discovery','invalid_inventory',`menu ${name}`);return values[0][1].trim();};ensure(scalar('congress')===String(congress)&&scalar('session')===String(session)&&scalar('congress_year')===String(year),'discovery','invalid_inventory','menu identity mismatch');
    const block=[...text.matchAll(/<votes>([\s\S]*?)<\/votes>/g)];ensure(block.length===1,'discovery','invalid_inventory','menu votes wrapper');for(const v of block[0][1].matchAll(/<vote>([\s\S]*?)<\/vote>/g)){const no=[...v[1].matchAll(/<vote_number>(\d+)<\/vote_number>/g)],dt=[...v[1].matchAll(/<vote_date>(\d{1,2})-([A-Z][a-z]{2})<\/vote_date>/g)];ensure(no.length===1&&dt.length===1,'discovery','invalid_inventory','unparsed menu vote');const month=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(dt[0][2])+1,date=`${year}-${String(month).padStart(2,'0')}-${dt[0][1].padStart(2,'0')}`;ensure(isIsoDate(date),'discovery','invalid_inventory','menu date');sessionRows.push({year,roll:Number(no[0][1]),date,congress,session});}receiptByYearPage.set(`${year}/1`,receipt);
   }
  }
  const rolls=sessionRows.map(r=>r.roll);ensure(rolls.length===summary.published_total&&new Set(rolls).size===rolls.length&&rolls.every(r=>r>=1&&r<=rolls.length),'discovery','invalid_inventory','missing/duplicate session roll');const inWin=sessionRows.filter(r=>run.window![0]<=r.date&&r.date<=run.window![1]).length;ensure(inWin===summary.window_total,'discovery','invalid_inventory','session window count');selected+=inWin;rawRows.push(...sessionRows);
 }
 ensure(paths.size===packet.receipts.length&&rawRows.length===packet.inventory.length&&rawRows.length===m.records.length&&selected===packet.window_total&&selected===m.required_rolls,'discovery','invalid_inventory','aggregate inventory counts');
 const byKey=new Map(rawRows.map(r=>[`${r.year}/${r.roll}`,r]));const seen=new Set<string>();for(const row of packet.inventory){const key=`${row.year}/${row.roll}`;ensure(!seen.has(key)&&equal(byKey.get(key),row),'discovery','invalid_inventory','inventory differs from raw pages');seen.add(key);}
 for(const r of m.records){const row=byKey.get(`${r.year}/${r.roll}`);ensure(row&&row.date===r.date&&equal(receiptByYearPage.get(`${r.year}/${r.page}`),r.index_receipt),'discovery','invalid_inventory','manifest differs from complete inventory');if(run.chamber==='house')ensure(row.url===r.url&&row.status===r.status&&row.page===r.page,'discovery','invalid_inventory','listing metadata differs');else ensure(r.url===r.source_url&&r.page===1,'discovery','invalid_inventory','Senate listing metadata differs');}
}
function decodeEntities(s:string){return s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');}
export function loadWindowRun(runDir:string):{run:WindowRun;manifest:AcquisitionManifestLike;bridgeInputs:BridgeRollInput[]}{
 try{
  const run=jsonFile(runDir,'window-run.json') as WindowRun;
  ensure(obj(run)&&run.contract==='civiclens.official-vote-window-run'&&run.contract_version===1&&['house','senate'].includes(run.chamber)&&['window','rolls'].includes(run.mode),'acquisition','invalid_run','run contract/chamber/mode');ensure(run.status==='complete','acquisition','incomplete_run','window acquisition did not complete');
  if(run.mode==='window'){ensure(isIsoDate(run.as_of)&&Array.isArray(run.window)&&equal(run.window,[coverageWindow(run.as_of).start,run.as_of])&&run.months===48,'coverage','window_mismatch','run is not exact 48 calendar months');}
  else ensure(run.as_of===null&&run.window===null&&run.months===null,'acquisition','invalid_run','rolls mode must have null window');
  const manifest=jsonFile(runDir,run.manifest_path,run.manifest_sha256) as AcquisitionManifestLike;validateCompleteManifest(manifest,run,runDir);
  if(run.mode==='window')validateDiscovery(runDir,run,manifest);
  const bridgeInputs=manifest.records.filter(r=>r.in_window).map(r=>({key:r.key,chamber:r.chamber,congress:r.congress,session:r.session,year:r.year,roll:r.roll,date:r.date,source_url:r.source_url,path:readSafe(resolve(runDir,'acquisition'),r.response!.path).path,sha256:r.response!.sha256}));
  return {run,manifest,bridgeInputs};
 }catch(e){if(e instanceof OfficialVoteFailure)throw e;return fail('acquisition','invalid_run',e instanceof Error?e.message:String(e));}
}

export function classifyRoll(raw:HouseRaw|SenateRaw,collector:Record<string,unknown>):OfficialVoteResolution {
 if(raw.chamber==='senate'&&raw.documents!==undefined){
  const emptyDocument={document_congress:'',document_type:'',document_number:'',document_name:'',amendment_number:'',amendment_to_document_number:''};
  ensure(Array.isArray(raw.documents)&&(raw.documents.length===0?equal(raw.document,emptyDocument):equal(raw.documents[0],raw.document)),'collector','cross_check_mismatch','bundle first document mismatch');
  if(raw.documents.length>1){
   if(raw.documents.some(d=>d.document_type!=='PN'))return {outcome:'ambiguity',billId:null,subtype:null,amendment:null,reason:'multiple documents must be an all-PN nomination bundle'};
   if(raw.documents.some(d=>d.document_congress!==String(raw.congress)))return {outcome:'ambiguity',billId:null,subtype:null,amendment:null,reason:'nomination bundle congress differs from roll'};
   if(raw.documents.some(d=>d.amendment_number!==raw.document.amendment_number||d.amendment_to_document_number!==raw.document.amendment_to_document_number))return {outcome:'ambiguity',billId:null,subtype:null,amendment:null,reason:'nomination bundle amendment fields disagree'};
  }
 }
 const r=raw.chamber==='house'?classifyHouseRoll(raw):classifySenateRoll({congress:raw.congress,documentCongress:raw.document.document_congress,documentType:raw.document.document_type,documentNumber:raw.document.document_number,documentName:raw.document.document_name,amendmentNumber:raw.document.amendment_number,amendmentToDocumentNumber:raw.document.amendment_to_document_number});
 const bill=collector.bill;
 if((r.outcome==='resolved_bill'&&(!obj(bill)||bill.congress!==r.bill.congress||bill.type!==r.bill.type||bill.number!==r.bill.number))||(r.outcome==='authoritative_non_bill'&&bill!==undefined&&bill!==null))return {outcome:'ambiguity',billId:null,subtype:null,amendment:null,reason:'official classifier and pinned collector disagree on bill identity'};
 if(r.outcome==='resolved_bill')return {outcome:r.outcome,billId:`${r.bill.congress}-${r.bill.type}-${r.bill.number}`,subtype:null,amendment:r.amendment||null,reason:null};
 if(r.outcome==='authoritative_non_bill')return {outcome:r.outcome,billId:null,subtype:r.subtype,amendment:null,reason:null};
 return {outcome:r.outcome,billId:null,subtype:null,amendment:null,reason:r.reason};
}
export function analyzeRoll(input:BridgeRollInput,result:BridgeRollOk|BridgeRollFail,identity:IdentityIndex):RollAnalysis {
 if(result.ok===false)fail('collector',result.outcome,result.reason);
 const raw=result.raw,collector=result.collector;
 const check=(condition:unknown,msg:string)=>ensure(condition,'collector','cross_check_mismatch',`${input.key}: ${msg}`);
 check(obj(raw)&&obj(collector)&&result.key===input.key,'invalid raw or collector result');
 check(raw.chamber===input.chamber&&raw.congress===input.congress&&raw.session===input.session&&raw.roll===input.roll&&raw.date===input.date,'raw identity differs from acquisition');
 check(obj(collector.votes)&&Array.isArray(raw.voters)&&raw.voters.length>0,'missing voter list');
 const pinned=new Map<string,string>();for(const [option,list] of Object.entries(collector.votes as Record<string,unknown>)){
  check(Array.isArray(list),'collector option is not a voter array');for(const v of list as unknown[]){if(v==='VP')continue;check(obj(v)&&typeof v.id==='string'&&v.id.length>0&&!pinned.has(v.id),'invalid or duplicate collector voter');pinned.set((v as any).id,option);}
 }
 check(pinned.size===raw.voters.length,'voter set size differs');const rawIds=new Set<string>();const tokens=new Map<string,number>();
 for(const v of raw.voters){check(obj(v)&&typeof v.id==='string'&&!!v.id&&typeof v.raw_position==='string'&&!rawIds.has(v.id),'invalid/duplicate raw voter');rawIds.add(v.id);const option=pinned.get(v.id);check(option===v.raw_position||(raw.chamber==='senate'&&v.raw_position==='Present, Giving Live Pair'&&option==='Present'),'voter option differs');tokens.set(v.raw_position,(tokens.get(v.raw_position)??0)+1);}
 const n=(...names:string[])=>names.reduce((sum,key)=>sum+(tokens.get(key)??0),0);let election=false;
 if(raw.chamber==='house'){
  check(obj(raw.totals),'missing House totals');
  if(raw.totals.kind==='by_vote'){const t=raw.totals;check(['Yea','Aye','Nay','No','Present','Not Voting'].every(()=>true)&&[...tokens.keys()].every(k=>['Yea','Aye','Nay','No','Present','Not Voting'].includes(k)),'unknown House count token');check([t.yea,t.nay,t.present,t.not_voting].every(count)&&t.yea===n('Yea','Aye')&&t.nay===n('Nay','No')&&t.present===n('Present')&&t.not_voting===n('Not Voting'),'House totals differ');}
  else {check(raw.totals.kind==='by_candidate'&&Array.isArray(raw.totals.candidates)&&raw.totals.candidates.length>0,'missing candidate totals');const seen=new Set<string>();for(const c of raw.totals.candidates){check(typeof c.name==='string'&&!!c.name&&!seen.has(c.name)&&count(c.total)&&c.total===n(c.name),'candidate total differs');seen.add(c.name);}check([...tokens.keys()].every(t=>seen.has(t))&&raw.totals.candidates.reduce((s,c)=>s+c.total,0)===raw.voters.length,'candidate sum differs');election=raw.question==='Election of the Speaker'&&raw.legis_num==='';}
 }else {const t=raw.count;check(obj(t)&&[t.yeas,t.nays,t.present,t.absent].every(count)&&[...tokens.keys()].every(k=>['Yea','Nay','Present','Present, Giving Live Pair','Not Voting','Guilty','Not Guilty'].includes(k))&&t.yeas===n('Yea','Guilty')&&t.nays===n('Nay','Not Guilty')&&t.present===n('Present','Present, Giving Live Pair')&&t.absent===n('Not Voting'),'Senate totals differ');}
 const voters:RollAnalysis['voters']=new Map();
 const outOfServiceListings:OutOfServiceListing[]=[];
 for(const v of raw.voters){
  let person:string;
  try {person=identity.personForVoter(raw.chamber,v.id,raw.date);}
  catch(error){
   // The strict identity lookup checks known identity before dated service.
   // Preserve exact non-participation listings without attributing a vote.
   if(error instanceof OfficialVoteFailure&&error.stage==='identity'
     &&error.code==='voter_not_in_service'&&v.raw_position==='Not Voting'){
    outOfServiceListings.push({rollKey:input.key,chamber:raw.chamber,voterId:v.id,rawPosition:'Not Voting',date:raw.date});
    continue;
   }
   throw error;
  }
  ensure(!voters.has(person),'identity','duplicate_person',person);
  const pos=normalizePosition(v.raw_position,election?'election':'standard');
  if(pos.ok===false)fail('normalization','unsupported_position',pos.reason);
  voters.set(person,{vote:pos.position,rawPosition:pos.rawPosition});
 }
 return {input,raw,resolution:classifyRoll(raw,collector),voters,outOfServiceListings};
}
export function normalizeMemberVotes(args:{runDir:string;run:WindowRun;bridge:BridgeRun;bridgeInputs:BridgeRollInput[];identity:IdentityIndex;bioguideId:string;chamber:Chamber;asOf:string}):OfficialMemberVotes {
 const {run,bridge,bridgeInputs,identity,bioguideId,chamber,asOf}=args;
 ensure(run.status==='complete','coverage','incomplete_run','run incomplete');ensure(bridgeInputs.length>0,'coverage','zero_required_rolls','no required rolls');const window=coverageWindow(asOf);
 ensure(run.mode==='window'&&run.chamber===chamber&&run.as_of===asOf&&run.months===48&&equal(run.window,[window.start,window.end]),'coverage','window_mismatch','member window mismatch');
 identity.inService(bioguideId,chamber,asOf);
 ensure(bridge.bridge==='civiclens.congress-collector-bridge'&&bridge.bridge_version===1&&bridge.collector.commit===PIN&&SHA.test(bridge.collector.vendor_manifest_sha256)&&SHA.test(bridge.runtime.lock_sha256)&&bridge.network.interfaces.every(v=>v==='lo')&&['lookup_legislator','require_congress_legislators_repo','download'].every(n=>bridge.inference_disabled.includes(n))&&bridge.results.length===bridgeInputs.length,'collector','cross_check_mismatch','bridge provenance/count mismatch');
 const votes:OfficialVoteRecord[]=[],notRecordedKeys:string[]=[],outOfServiceListings:OutOfServiceListing[]=[];let inServiceRolls=0;const keys=new Set<string>();
 for(let n=0;n<bridgeInputs.length;n++){const input=bridgeInputs[n];ensure(!keys.has(input.key)&&input.chamber===chamber&&input.key===rollKey(input)&&input.year===sessionYear(input.congress,input.session)&&input.source_url===source(input)&&isIsoDate(input.date)&&window.start<=input.date&&input.date<=window.end&&SHA.test(input.sha256),'coverage','invalid_roll','invalid/duplicate required roll');keys.add(input.key);const a=analyzeRoll(input,bridge.results[n],identity),member=a.voters.get(bioguideId),serves=identity.inService(bioguideId,chamber,input.date);outOfServiceListings.push(...a.outOfServiceListings);if(!serves){ensure(!member,'identity','appears_out_of_service',input.key);continue;}inServiceRolls++;if(!member){notRecordedKeys.push(input.key);continue;}const raw=a.raw;votes.push({billTitle:raw.chamber==='house'?(raw.legis_num&&raw.vote_desc?`${raw.legis_num}: ${raw.vote_desc}`:raw.vote_desc||raw.question):raw.vote_title||raw.question,vote:member.vote,rawPosition:member.rawPosition,date:raw.date,source:chamber==='house'?'clerk.house.gov':'senate.gov',sourceUrl:input.source_url,sourceSha256:input.sha256,confidence:1,rollKey:input.key,chamber,congress:input.congress,session:input.session,roll:input.roll,question:raw.question,resolution:a.resolution});}
 ensure(inServiceRolls===0||votes.length>0,'identity','member_never_recorded','member in service but not recorded in any required roll');votes.sort((a,b)=>b.date.localeCompare(a.date)||b.roll-a.roll);
 return {votes,coverage:{outcome:'ok',source:'official',chamber,bioguideId,asOf,window:{start:window.start,end:window.end,months:48},requiredRolls:bridgeInputs.length,analyzedRolls:bridgeInputs.length,inServiceRolls,recorded:votes.length,notRecorded:notRecordedKeys.length,notRecordedKeys,outOfServiceListings,acquisition:{runDir:args.runDir,manifestSha256:run.manifest_sha256,inventorySha256:run.discovery.inventory_sha256},collector:{commit:bridge.collector.commit,lockSha256:bridge.runtime.lock_sha256,vendorManifestSha256:bridge.collector.vendor_manifest_sha256},identity:{commit:identity.commit,snapshotSha256:identity.snapshotSha256,floor:identity.floor}}};
}
