import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';

const root='/home/captainanime/Developer/civiclens-track-b';
const main='/home/captainanime/Developer/civiclens';
const base='/home/captainanime/Developer/civiclens-track-b-trials/closeout-2026-09-14-inputs';
const evidence=root+'/docs/trials/2026-09-09-six-fresh-members/2026-09-14-closeout/replays-v2';
const candidate='56efb3bc4308206d406553162cd39274df0efc8b';
const git=(...args)=>cp.execFileSync('git',args,{cwd:root,encoding:'utf8'}).trimEnd();
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const save=(name,value)=>{const p=path.join(evidence,name);if(fs.existsSync(p))throw Error('Preserve existing '+p);fs.writeFileSync(p,JSON.stringify(value,null,2)+'\n');};
if(process.cwd()!==root||git('rev-parse','HEAD')!==candidate)throw Error('Wrong checkout/candidate');
console.log('cwd',root,'cache',root+'/data/caches','git status',git('status','--short'));
const centralDb=sha(root+'/data/civiclens.duckdb'),productionDb=sha(main+'/data/civiclens.duckdb');
if(centralDb!=='cc752c5cb51a8084506c6fb04d61f175969c4fc179825a77dcae18d640619bce'||productionDb!=='a766c8917a0e6b42ddc488758eb0b1a66abb37d24c873a74b4cc9d6fd7e4a38b')throw Error('DB invariance failure');
const mainHead=git('-C',main,'rev-parse','HEAD'),mergeBase=git('merge-base',mainHead,candidate);
if(!fs.existsSync(path.join(evidence,'integration-delta.json')))save('integration-delta.json',{candidate,mainHead,mergeBase,
  branchNameStatus:git('diff','--name-status',mergeBase,candidate,'--'),
  branchNumstat:git('diff','--numstat',mergeBase,candidate,'--'),
  mainToCandidateNameStatus:git('diff','--name-status',mainHead,candidate,'--'),
  mainDirtyStateSeparate:git('-C',main,'status','--short'),
  scope:'Diffs computed exclusively from committed objects. Dirty main is reported separately and is not part of the integration delta. No integration attempted.'});

const strata=[];
for(let n=1;n<=6;n++){
  const ev=`${evidence}/s${n}`,setup=JSON.parse(fs.readFileSync(ev+'/setup.json'));
  if(git('-C',setup.worktree,'rev-parse','HEAD')!==candidate)throw Error('Mixed candidate');
  const db=setup.worktree+'/data/civiclens.duckdb';
  const record={stratum:n,worktree:setup.worktree,head:candidate,gitStatus:git('-C',setup.worktree,'status','--short'),dbSha256:sha(db),walSha256:fs.existsSync(db+'.wal')?sha(db+'.wal'):null};
  const auditPath=ev+(fs.existsSync(ev+'/db-audit-final.json')?'/db-audit-final.json':'/db-audit-complete.json');
  if(fs.existsSync(auditPath)){const auditRecord=JSON.parse(fs.readFileSync(auditPath));if(auditRecord.dbAfter!==record.dbSha256||auditRecord.walAfter!==record.walSha256)throw Error('Audit does not describe current DB/WAL '+n);record.finalAudit=path.relative(root,auditPath);const audit=JSON.parse(auditRecord.output);record.crossMemberRows=audit.crossMemberRows;record.parkedTimingRows=audit.parkedTimingRows.length;if(record.crossMemberRows||record.parkedTimingRows)throw Error('Invariance failure');}
  else {record.auditStatus='Pending final logical audit; no physical-hash invariance claim';}
  strata.push(record);
}
const registry=sha(root+'/docs/confirmatory-runs.md');
if(registry!=='f9037353bce052e9393be426cfec09997b411462fa5956497194da153fb05274')throw Error('Registry changed');
save('final-state.json',{recordedAt:new Date().toISOString(),phase:'before evidence commit',candidate,centralDb,productionDb,registrySha256:registry,strata,
  centralDirtyState:git('status','--short'),outcome:'NOT COMPLETE',replayWriters:'all completed; no process lease remains',
  postFreezeDecision:'does-not-invalidate implementation: only trial evidence and external verification orchestration changed; no source code, acceptance rules, selections, or pipeline model changes'});

const delegation=[];
for(const name of ['grok-evidence','claude-replays','claude-evidence','claude-evidence-remaining','claude-resume-evening','grok-resume-evening','grok-resume-available','claude-stage-reconciliation','grok-s5-final']){
  const file=`${base}/delegation/${name}.stream.jsonl`;
  const records=fs.readFileSync(file,'utf8').split('\n').flatMap(line=>{try{return [JSON.parse(line)]}catch{return [];}});
  const result=records.findLast(x=>x.type==='result');
  delegation.push({name,transcriptPath:file,transcriptSha256:sha(file),sessionId:result?.session_id,error:result?.is_error,result:result?.result??result?.errors});
}
save('delegation-results.json',delegation);
const scripts=['run-step-v2.py','run-control.py','ingest-v2.py','finish-stratum-v2.py','independent-checks.py','audit-db-v2.mjs','record-closeout.mjs'];
const dest=path.join(evidence,'orchestration');fs.mkdirSync(dest);
save('orchestration-current.json',scripts.map(name=>{const source=path.join(base,name),target=path.join(dest,name);fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);return {source,trackedCopy:path.relative(root,target),sha256:sha(source)};}));
const changed=git('diff','--name-status','dcd1375faff9e82bc99d09389446439797906d7b',candidate,'--');
save('changed-files.json',{implementationAndEvidenceSinceTaskStart:changed,currentEvidenceRoot:path.relative(root,evidence),currentReviewFile:'docs/trials/2026-09-09-six-fresh-members/final-certification-review.md',
  preservedUncommitted:['docs/prompts/bulk-download-legislators-and-house-ptrs.md','docs/trials/2026-09-06/civiclens-completion-plan.md','docs/trials/2026-09-08-run-any-member/plan.md']});
console.log('Final state: source DB preserved, available exact row audits clean; see per-stratum audit status, registry unchanged; main',mainHead,'merge base',mergeBase);
