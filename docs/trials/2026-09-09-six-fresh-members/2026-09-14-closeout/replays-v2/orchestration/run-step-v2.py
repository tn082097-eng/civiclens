import sys,os,json,subprocess,hashlib,time
from pathlib import Path
n,label,*cmd=sys.argv[1:]
root=Path('/home/captainanime/Developer/civiclens-track-b')
ev=root/'docs/trials/2026-09-09-six-fresh-members/2026-09-14-closeout/replays-v2'/('s'+n)
setup=json.loads((ev/'setup.json').read_text());w=Path(setup['worktree']);os.chdir(w)
assert Path.cwd()==w.resolve() and '/civiclens-track-b-trials/closeout-v2-s' in str(w)
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==setup['candidate']
for p in [w/'data/civiclens.duckdb',w/'data/caches',w/'pipeline']:
 assert p.resolve().is_relative_to(w)
status=subprocess.check_output(['git','status','--short'],text=True)
changed=subprocess.check_output(['git','diff','--name-only'],text=True).splitlines()
assert set(changed)<= {'names.txt'},changed
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
record={'cwd':str(w),'head':setup['candidate'],'gitStatus':status,'command':cmd,'started':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'dbPath':str(w/'data/civiclens.duckdb'),'cachePath':str(w/'data/caches'),'dbBefore':sha(w/'data/civiclens.duckdb')}
record['walBefore'] = sha(w/'data/civiclens.duckdb.wal') if (w/'data/civiclens.duckdb.wal').exists() else None
out=ev/(label+'.json');assert not out.exists(),out
print('RUN',n,label,'cwd',w,'DB',record['dbBefore'],flush=True)
env=os.environ.copy();env['CIVICLENS_VAULT_DIR']=str(w/'trial-vault');env['CIVICLENS_PIPE_DIR']=str(w/'pipeline');env['CIVICLENS_SUMMARIZER']='1'
r=subprocess.run(cmd,cwd=w,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
output=r.stdout
for line in (w/'.env').read_text().splitlines():
 if '=' in line and any(s in line.split('=',1)[0] for s in ['KEY','TOKEN','SECRET']):
  value=line.split('=',1)[1].strip().strip('"\'')
  if value:output=output.replace(value,'[REDACTED]')
record.update(exit=r.returncode,output=output,dbAfter=sha(w/'data/civiclens.duckdb'),finished=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()))
record['walAfter'] = sha(w/'data/civiclens.duckdb.wal') if (w/'data/civiclens.duckdb.wal').exists() else None
out.write_text(json.dumps(record,indent=2)+'\n')
print('DONE',n,label,'exit',r.returncode,flush=True)
print('\n'.join(output.splitlines()[-9:]),flush=True)
sys.exit(r.returncode)
