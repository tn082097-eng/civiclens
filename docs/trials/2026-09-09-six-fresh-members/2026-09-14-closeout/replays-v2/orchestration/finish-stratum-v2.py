from pathlib import Path
import sys,json,subprocess,hashlib,re
n,slug,bio=sys.argv[1:];base=Path('/home/captainanime/Developer/civiclens-track-b-trials/closeout-2026-09-14-inputs');root=Path('/home/captainanime/Developer/civiclens-track-b');ev=root/'docs/trials/2026-09-09-six-fresh-members/2026-09-14-closeout/replays-v2'/('s'+n);w=Path(json.loads((ev/'setup.json').read_text())['worktree'])
step=lambda label,cmd:subprocess.run(['python3',str(base/'run-step-v2.py'),n,label,*cmd],check=True)
for label,cmd in [('patterns',['node','--import','tsx','pipeline/run-patterns.ts','--member',slug]),('theme-gaps',['node','--import','tsx','pipeline/score-theme-gaps.ts','--member',slug]),('baseline-after',['npm','run','verify:baseline']),('corpus',['npm','run','validate:corpus']),('typecheck',['./node_modules/.bin/tsc','--noEmit'])]:step(label,cmd)
files=json.loads((root/'docs/trials/2026-09-09-six-fresh-members/2026-09-14-closeout/applicable-test-files-final.json').read_text())
step('tests',['node','--import','tsx','--test',*files])
local=w/'trial-evidence';local.mkdir(exist_ok=True)
step('render-warmup',['node','--import','tsx','render/build.ts','--member',slug])
def inputs():
 return {str(p.relative_to(w)):hashlib.sha256(p.read_bytes()).hexdigest() for folder in ['data/caches','pipeline/artifacts'] for p in sorted((w/folder).rglob('*')) if p.is_file()}
frozen=inputs()
for i in [1,2]:
 step('render-'+str(i),['node','--import','tsx','render/build.ts','--member',slug])
 (local/f'render-{i}.html').write_bytes((w/'site/members'/f'{slug}.html').read_bytes())
afterInputs=inputs();(ev/'render-inputs.json').write_text(json.dumps({'before':frozen,'after':afterInputs,'equal':frozen==afterInputs},indent=2)+'\n');assert frozen==afterInputs,'render input drift'
a=(local/'render-1.html').read_text();b=(local/'render-2.html').read_text();pattern=r'(?<= · generated )\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z(?=</div>)'
assert len(re.findall(pattern,a))==len(re.findall(pattern,b))==1
na=re.sub(pattern,'',a);nb=re.sub(pattern,'',b)
sha=lambda v:hashlib.sha256(v).hexdigest()
(ev/'render-determinism.json').write_text(json.dumps({'normalizationRegex':pattern,'normalization':'remove only generated timestamp','raw':[sha(a.encode()),sha(b.encode())],'normalized':[sha(na.encode()),sha(nb.encode())],'equal':na==nb},indent=2)+'\n')
assert na==nb,'render nondeterminism'
step('checkpoint',['node','--import','tsx','--input-type=module','-e',"import {getDb,closeDb} from './db/init.ts'; const c=await getDb();await c.run('CHECKPOINT');closeDb();"])
step('db-audit-complete',['node',str(base/'audit-db-v2.mjs'),str(w),slug,bio])
audit=json.loads(json.loads((ev/'db-audit-complete.json').read_text())['output']);print('AUDIT',n,'cross-member',audit['crossMemberRows'],'tables',[(t['table'],len(t['added']),len(t['removed'])) for t in audit['changedTables']])
manifest=[{'path':str(p.relative_to(w)),'sha256':sha(p.read_bytes()),'bytes':p.stat().st_size} for folder in ['data/caches','pipeline'] for p in sorted((w/folder).rglob('*')) if p.is_file() and (folder!='pipeline' or '/task-' in str(p) or '/artifacts/' in str(p))]
(ev/'output-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('SELECTED MEMBER CHECKS COMPLETE',n,slug)
