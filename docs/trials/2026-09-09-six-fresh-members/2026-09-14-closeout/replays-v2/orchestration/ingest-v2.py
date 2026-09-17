from pathlib import Path
import sys,json,subprocess
n=sys.argv[1];b=Path(__file__).parent;r=Path('/home/captainanime/Developer/civiclens-track-b');e=r/'docs/trials/2026-09-09-six-fresh-members/2026-09-14-closeout/replays-v2'/('s'+n);s=json.loads((e/'setup.json').read_text());w=Path(s['worktree']);bio=s['bioguide']
def step(label,cmd):
 p=subprocess.run(['python3',str(b/'run-step-v2.py'),n,label,*cmd]);
 if p.returncode:raise SystemExit(p.returncode)
step('baseline-before',['npm','run','verify:baseline'])
step('onboarding',['node','--import','tsx','agents/pipeline.ts','--append',s['member']])
tasks=list((w/'pipeline').glob('task-*'));assert len(tasks)==1
d=json.loads((tasks[0]/'researcher.json').read_text())['data'];assert d['bioguideId']==bio;slug=d['id'];chamber=d['chamber'];assert chamber==('house' if n in ['2','3','6'] else 'senate')
(e/'identity.json').write_text(json.dumps({'slug':slug,'bioguide':bio,'chamber':chamber,'task':tasks[0].name},indent=2)+'\n')
for label,args in [('sponsored',['agents/pipeline.ts','--load-sponsored',slug]),('cosponsored',['db/load-cosponsored.ts',slug]),('bills',['agents/pipeline.ts','--load-bills','--bioguide',bio,'--api-pass'])]:step(label,['node','--import','tsx',*args])
if chamber=='house':
 for y in range(2023,2027):
  p=w/'data/caches/pfd-cache'/str(y)
  if list(p.glob('*.txt')):step('extract-'+str(y),['node','--import','tsx','skills/pfd-fetcher/extract.ts',str(p)])
 step('house-pfd',['node','--import','tsx','agents/pipeline.ts','--load-pfd','2023,2024,2025,2026','--bioguide',bio])
else:step('senate-ptr',['node','--import','tsx','agents/pipeline.ts','--load-senate-ptr','--bioguide',bio])
step('fec-ie',['node','--import','tsx','agents/pipeline.ts','--load-fec-ie','2026','--bioguide',bio])
print('INGESTION COMPLETE',n,slug)
