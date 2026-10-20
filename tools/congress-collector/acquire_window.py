"""Official vote acquisition CLI. Fixture-map runs are explicitly labeled."""
import argparse
import json
from pathlib import Path
import re
import sys
# -I excludes script-directory imports. Only this trusted local module directory is added.
sys.path.insert(0,str(Path(__file__).resolve().parent))
import adapter
import house_discovery as hd
import senate_adapter as sa

def roll_record(request,chamber):
    if not isinstance(request,dict) or set(request)!={'key','date'}:raise ValueError('roll requests require exactly key and date')
    m=re.fullmatch(r'([1-9]\d*)-(\d{4})/([hs])([1-9]\d*)',request['key']) if isinstance(request['key'],str) else None
    if not m:raise ValueError('noncanonical roll key')
    congress,year,roll=int(m[1]),int(m[2]),int(m[4]);session=year-(1787+2*congress)+1
    if session not in (1,2) or m[3]!=('h' if chamber=='house' else 's') or any(v>9007199254740991 for v in (congress,roll)):raise ValueError('roll key chamber/year mismatch')
    adapter.iso_date(request['date'])
    if request['date'][:4]!=str(year):raise ValueError('expected date year differs from roll year')
    url=sa.source_url(congress,session,roll) if chamber=='senate' else f'https://clerk.house.gov/evs/{year}/roll{roll:03d}.xml'
    return {**request,'chamber':chamber,'congress':congress,'session':session,'year':year,'roll':roll,'source_url':url,'url':url,'status':None,'page':1,'index_receipt':{'mode':'explicit_roll','key':request['key'],'date':request['date']}}

def execute(chamber,output,*,as_of=None,rolls=None,fetch_page=None,fetch_detail=None,fixture_mode=False,window=None):
    output=Path(output).absolute()
    if chamber not in ('house','senate'):raise ValueError('unsupported chamber')
    if any(p.is_symlink() for p in [output,*output.parents]):raise ValueError('symlink output refused')
    output.mkdir(parents=True,exist_ok=False)
    mode='rolls' if rolls is not None else 'window';started=adapter.timestamp()
    run={'contract':'civiclens.official-vote-window-run','contract_version':1,'chamber':chamber,'mode':mode,'as_of':as_of if mode=='window' else None,'window':None,'months':48 if mode=='window' else None,'status':'running','reason':'fixture_mode: true; frozen/synthetic inputs, not live coverage evidence' if fixture_mode else None,'started_at':started,'finished_at':None,'discovery':{'inventory_path':None,'inventory_sha256':None,'index_pages_verified':0},'manifest_path':'acquisition/manifest.json','manifest_sha256':None}
    report=None
    try:
        if mode=='rolls':
            if not isinstance(rolls,list) or not rolls:raise ValueError('zero required rolls')
            records=[roll_record(r,chamber) for r in rolls]
            if len({r['key'] for r in records})!=len(records):raise ValueError('duplicate explicit roll')
            digest=adapter.sha256(json.dumps(rolls,sort_keys=True).encode())
            report=sa.acquire_records(records,None,output/'acquisition',fetch_detail or (adapter.fetch_xml if chamber=='house' else sa.fetch_senate),chamber,digest,0)
        else:
            adapter.iso_date(as_of)
            window=tuple(window) if window is not None else (adapter.subtract_months(as_of,48),as_of)
            run['window']=list(window);run['months']=48 if window[0]==adapter.subtract_months(as_of,48) and window[1]==as_of else None
            discovery=hd.discover_house if chamber=='house' else sa.discover_senate
            path,digest=discovery(window,output/'discovery',fetch_page or (hd.fetch_page if chamber=='house' else sa.fetch_senate))
            inv=(adapter.validate_inventory if chamber=='house' else sa.validate_inventory)(path,digest)
            run['discovery']={'inventory_path':'discovery/inventory.json','inventory_sha256':digest,'index_pages_verified':inv.receipt_count}
            report=(adapter.acquire if chamber=='house' else sa.acquire_senate)(inv,output/'acquisition',fetch_detail or (adapter.fetch_xml if chamber=='house' else sa.fetch_senate))
        run['manifest_sha256']=adapter.sha256((output/run['manifest_path']).read_bytes());run['status']='complete' if report['status']=='acquisition_complete' and report['required_rolls']>0 else 'incomplete'
        if run['status']!='complete':run['reason']=(run['reason']+'; ' if run['reason'] else '')+'one or more required rolls not acquired'
    except (OSError,ValueError,KeyError,TypeError) as exc:
        run['status']='failed';run['reason']=(run['reason']+'; ' if run['reason'] else '')+f'{type(exc).__name__}: {exc}'
    run['finished_at']=adapter.timestamp();(output/'window-run.json').write_text(json.dumps(run,sort_keys=True,indent=2)+'\n');return run

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--chamber',required=True,choices=['house','senate']);mode=parser.add_mutually_exclusive_group(required=True);mode.add_argument('--as-of');mode.add_argument('--rolls-json',type=Path);parser.add_argument('--months',type=int,default=48);parser.add_argument('--output',required=True,type=Path);parser.add_argument('--fixture-map',type=Path);args=parser.parse_args(argv)
    if args.months!=48:parser.error('--months must be 48')
    try:
        rolls=json.loads(args.rolls_json.read_bytes()) if args.rolls_json else None
        fetch=None
        if args.fixture_map:
            mapping=json.loads(args.fixture_map.read_bytes())
            def fetch(url):
                if url not in mapping:raise ValueError(f'fixture map missing URL: {url}')
                body=Path(mapping[url]).read_bytes()
                return adapter.Response(200,body,url,'application/xml' if body.lstrip().startswith(b'<?xml') else 'text/html')
        run=execute(args.chamber,args.output,as_of=args.as_of,rolls=rolls,fetch_page=fetch,fetch_detail=fetch,fixture_mode=args.fixture_map is not None)
        print(json.dumps({'run_dir':str(args.output.absolute()),'status':run['status']}));return 0 if run['status']=='complete' else 1
    except (OSError,ValueError,KeyError,TypeError) as exc:
        print(json.dumps({'status':'failed','reason':str(exc)}),file=sys.stderr);return 1
if __name__=='__main__':sys.exit(main())
