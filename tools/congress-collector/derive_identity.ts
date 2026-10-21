/** Deterministic identity derivation from hash-pinned upstream CC0 YAML. No HTTP. */
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import yaml from 'js-yaml';
const commit='d5af3d2d2490f8c6532c9490b1f47a76cacca699';
const floor='2019-01-03';
const pins=[['legislators-current.yaml',1081187,'bd32e62b1c89e9585e4ec49df5676563510e9435d779c061ff50139833f73a49'],['legislators-historical.yaml',8997407,'9641615f336b3113d6f89152e3441128cbdc3f61ccf87c65da3a015076c78c91']] as const;
const args=process.argv.slice(2);
function arg(flag:string) {const n=args.indexOf(flag);if(n<0||!args[n+1]||args[n+1].startsWith('--'))throw new Error(`missing ${flag}`);return args[n+1];}
if(args.length!==6||new Set(args.filter(a=>a.startsWith('--'))).size!==3)throw new Error('expected --current --historical --out');
const paths=[arg('--current'),arg('--historical')]; const output=arg('--out');
function iso(v:unknown):v is string {return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;}
const seenBio=new Set<string>(),seenLis=new Set<string>();
const people=[];
for(let n=0;n<2;n++){
 const bytes=readFileSync(paths[n]); const [name,size,hash]=pins[n];
 if(bytes.length!==size||createHash('sha256').update(bytes).digest('hex')!==hash)throw new Error(`${name} pin mismatch`);
 // JSON_SCHEMA preserves calendar dates as strings instead of JS Date objects.
 const parsed=yaml.load(bytes.toString('utf8'),{schema:yaml.JSON_SCHEMA}) as any[];
 if(!Array.isArray(parsed))throw new Error('expected YAML people array');
 for(const p of parsed){
  const bioguide=p?.id?.bioguide,lis=p?.id?.lis??null;
  if(typeof bioguide!=='string'||!/^[A-Z]\d{6}$/.test(bioguide)||seenBio.has(bioguide))throw new Error(`missing or duplicate bioguide: ${bioguide}`);
  seenBio.add(bioguide);
  if(lis!==null&&(typeof lis!=='string'||!/^S\d+$/.test(lis)||seenLis.has(lis)))throw new Error(`invalid or duplicate LIS: ${lis}`);
  if(lis!==null)seenLis.add(lis);
  if(!Array.isArray(p.terms))throw new Error(`missing terms: ${bioguide}`);
  for(const t of p.terms)if(!['rep','sen'].includes(t.type)||!iso(t.start)||!iso(t.end)||t.start>t.end)throw new Error(`invalid term: ${bioguide}`);
  const terms=p.terms.filter(t=>t.end>=floor).map(t=>{
   if(typeof t.state!=='string'||!/^[A-Z]{2}$/.test(t.state)||(t.type==='rep'&&(!Number.isSafeInteger(t.district)||t.district<0)))throw new Error(`invalid jurisdiction: ${bioguide}`);
   return {chamber:t.type==='rep'?'house':'senate',start:t.start,end:t.end,state:t.state,district:t.type==='rep'?t.district:null};
  }).sort((a,b)=>a.start.localeCompare(b.start)||a.end.localeCompare(b.end)||a.chamber.localeCompare(b.chamber));
  if(terms.length)people.push({bioguide,lis,terms});
 }
}
people.sort((a,b)=>a.bioguide.localeCompare(b.bioguide));
function sorted(v:any):any {if(Array.isArray(v))return v.map(sorted);if(v!==null&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])]));return v;}
const result={contract:'civiclens.official-vote-identity',version:1,source:{repository:'https://github.com/unitedstates/congress-legislators',commit,license:'CC0-1.0',inputs:pins.map(([name,bytes,sha256])=>({name,bytes,sha256,url:`https://raw.githubusercontent.com/unitedstates/congress-legislators/${commit}/${name}`}))},floor,exclusion:'Exclude people without rep/sen terms ending on or after 2019-01-03; keep only terms ending on or after the floor.',people};
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(sorted(result),null,2)+'\n');
console.log(JSON.stringify({output,people:people.length,terms:people.reduce((n,p)=>n+p.terms.length,0),sha256:createHash('sha256').update(readFileSync(output)).digest('hex')}));
