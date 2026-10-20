"""Official LIS menu discovery and receipt-preserving detail acquisition."""
from collections import Counter
from datetime import datetime
from http.client import HTTPException
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import adapter
from house_discovery import fetch_response, checked_response
from senate_documents import read_senate_documents, SenateDocumentAmbiguity

class SenateError(ValueError):
    def __init__(self,reason,outcome='malformed_source'):
        self.outcome=outcome
        super().__init__(reason)

def menu_url(congress,session):
    return f'https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_{congress}_{session}.xml'

def source_url(congress,session,roll):
    return f'https://www.senate.gov/legislative/LIS/roll_call_votes/vote{congress}{session}/vote_{congress}_{session}_{roll:05d}.xml'

def fetch_senate(url):
    def allow(value):
        if not re.fullmatch(r'https://www\.senate\.gov/legislative/LIS/(?:roll_call_lists/vote_menu_[1-9]\d*_[12]\.xml|roll_call_votes/vote[1-9]\d*[12]/vote_[1-9]\d*_[12]_\d{5,}\.xml)',value):raise SenateError('unexpected Senate request URL')
        if '/roll_call_votes/' in value:
            m=re.search(r'/vote(\d+)/vote_(\d+)_([12])_(\d+)\.xml$',value)
            if not m or m[1]!=m[2]+m[3] or int(m[4])<1 or source_url(int(m[2]),int(m[3]),int(m[4]))!=value:raise SenateError('noncanonical Senate detail URL')
    return fetch_response(url,allow)

def xml_root(body,tag):
    if re.search(br'<!ENTITY|<!DOCTYPE[^>]*\[',body,re.I):raise SenateError('internal XML entities/subsets unsupported')
    try:root=ET.fromstring(body)
    except ET.ParseError as exc:raise SenateError(str(exc)) from exc
    if root.tag!=tag:raise SenateError(f'expected {tag}')
    return root

def field(root,name,optional=False):
    nodes=root.findall(name)
    if optional and not nodes:return ''
    if len(nodes)!=1 or list(nodes[0]):raise SenateError(f'missing/duplicate/structured {name}')
    return (nodes[0].text or '').strip()

def parse_menu(body,congress,session):
    root=xml_root(body,'vote_summary');year=1787+2*congress+session-1
    if field(root,'congress')!=str(congress) or field(root,'session')!=str(session) or field(root,'congress_year')!=str(year):raise SenateError('Senate menu identity mismatch')
    if len(root.findall('votes'))!=1:raise SenateError('missing/duplicate votes')
    rows=[]
    for vote in root.findall('votes/vote'):
        raw=field(vote,'vote_number')
        if not re.fullmatch(r'\d+',raw) or int(raw)<1:raise SenateError('invalid menu vote number')
        try:day=datetime.strptime(f"{field(vote,'vote_date')}-{year}",'%d-%b-%Y').date().isoformat()
        except ValueError as exc:raise SenateError('invalid Senate menu date') from exc
        rows.append({'year':year,'roll':int(raw),'date':day,'congress':congress,'session':session})
    numbers=[r['roll'] for r in rows]
    if not numbers or len(set(numbers))!=len(numbers) or set(numbers)!=set(range(1,len(rows)+1)):raise SenateError('Senate menu is empty, duplicate, or noncontiguous')
    return rows

def discover_senate(window,out_dir,fetch_page=fetch_senate):
    low,high=map(adapter.iso_date,window)
    if low>high or high.year-low.year>10:raise SenateError('invalid or unbounded window')
    out=Path(out_dir)
    if any(p.is_symlink() for p in [out,*out.parents]):raise SenateError('symlink output refused')
    out.mkdir(parents=True,exist_ok=False);receipts=[];rows=[];summary=[]
    try:
        for year in range(low.year,high.year+1):
            congress=(year-1789)//2+1;session=1 if year%2 else 2;url=menu_url(congress,session);response=fetch_page(url);name=f'{year}-menu.xml'
            (out/name).write_bytes(response.body)
            receipt={'url':url,'status':response.status,'final_url':response.final_url,'content_type':response.content_type,'path':name,'sha256':adapter.sha256(response.body),'bytes':len(response.body),'body_complete':response.body_complete,'read_error':response.read_error,'fetched_at':adapter.timestamp()}
            receipts.append(receipt);(out/'discovery-receipts.json').write_text(json.dumps(receipts,indent=2)+'\n');checked_response(response,url)
            parsed=parse_menu(response.body,congress,session);rows.extend(parsed);summary.append({'year':year,'published_total':len(parsed),'pages':1,'window_total':sum(window[0]<=r['date']<=window[1] for r in parsed)})
        packet={'chamber':'senate','window':list(window),'summary':summary,'receipts':receipts,'inventory':rows,'window_total':sum(s['window_total'] for s in summary)}
        path=out/'inventory.json';path.write_text(json.dumps(packet,sort_keys=True,indent=2)+'\n');digest=adapter.sha256(path.read_bytes());validate_inventory(path,digest);return path.resolve(),digest
    except (OSError,ValueError,KeyError,TypeError,HTTPException) as exc:
        if isinstance(exc,SenateError):raise
        raise SenateError(str(exc)) from exc

def validate_inventory(path,expected_sha256):
    path=Path(path)
    try:
        if path.is_symlink() or adapter.sha256(path.read_bytes())!=expected_sha256:raise SenateError('inventory hash mismatch')
        packet=json.loads(path.read_bytes());low,high=map(adapter.iso_date,packet['window'])
        if low>high or high.year-low.year>10 or packet['chamber']!='senate':raise SenateError('invalid Senate window')
        receipts=packet['receipts'];years=list(range(low.year,high.year+1));parsed=[];records=[]
        if len(receipts)!=len(years) or len(packet['summary'])!=len(years):raise SenateError('missing menu session')
        for n,year in enumerate(years):
            receipt=receipts[n];c=(year-1789)//2+1;s=1 if year%2 else 2;name=f'{year}-menu.xml'
            if receipt['url']!=menu_url(c,s) or receipt['path']!=name or receipt['status']!=200 or receipt['final_url']!=receipt['url'] or not receipt['body_complete'] or receipt['read_error'] is not None:raise SenateError('invalid menu receipt')
            file=path.parent/name
            if file.is_symlink():raise SenateError('symlink source refused')
            body=file.read_bytes()
            if adapter.sha256(body)!=receipt['sha256'] or len(body)!=receipt['bytes'] or not datetime.fromisoformat(receipt['fetched_at']).tzinfo:raise SenateError('menu body/hash/timestamp mismatch')
            rows=parse_menu(body,c,s);parsed.extend(rows)
            summary={'year':year,'published_total':len(rows),'pages':1,'window_total':sum(packet['window'][0]<=r['date']<=packet['window'][1] for r in rows)}
            if packet['summary'][n]!=summary:raise SenateError('menu summary mismatch')
            records.extend({**r,'key':f'{c}-{year}/s{r["roll"]}','url':source_url(c,s,r['roll']),'page':1,'status':None,'index_receipt':receipt} for r in rows)
        if parsed!=packet['inventory'] or packet['window_total']!=sum(packet['window'][0]<=r['date']<=packet['window'][1] for r in parsed):raise SenateError('menu inventory mismatch')
        return adapter.Inventory(path.resolve(),expected_sha256,tuple(packet['window']),tuple(records),len(receipts))
    except (OSError,ValueError,KeyError,TypeError) as exc:
        if isinstance(exc,SenateError):raise
        raise SenateError(str(exc)) from exc

def validate_senate_xml(body,row):
    root=xml_root(body,'roll_call_vote')
    for name,value in [('congress',row['congress']),('session',row['session']),('congress_year',row['year']),('vote_number',row['roll'])]:
        raw=field(root,name)
        if not re.fullmatch(r'\d+',raw) or int(raw)!=value:raise SenateError(f'XML {name} differs from enumerated roll')
    try:stamp=datetime.strptime(' '.join(field(root,'vote_date').split()),'%B %d, %Y, %I:%M %p').date().isoformat()
    except ValueError as exc:raise SenateError('invalid Senate date') from exc
    if stamp!=row['date']:raise SenateError('XML date differs from enumerated roll')
    members=root.findall('members')
    if len(members)!=1 or not members[0].findall('member'):raise SenateError('missing Senate voter payload')
    positions=Counter();ids=set()
    for member in members[0].findall('member'):
        id=field(member,'lis_member_id');nodes=member.findall('vote_cast')
        if not id or id in ids:raise SenateError('empty or duplicate LIS voter')
        if len(nodes)!=1 or list(nodes[0]):raise SenateError('invalid vote_cast')
        ids.add(id);positions[nodes[0].text or '']+=1
    try:document,documents=read_senate_documents(root)
    except SenateDocumentAmbiguity as exc:raise SenateError(str(exc),'ambiguity') from exc
    except ValueError as exc:raise SenateError(str(exc)) from exc
    return {'key':row['key'],'chamber':'senate','congress':row['congress'],'session':row['session'],'roll':row['roll'],'date':stamp,'question':field(root,'question'),'vote_title':field(root,'vote_title'),'result':field(root,'vote_result'),'document_type':document['document_type'].strip(),'document_number':document['document_number'].strip(),'document_congress':document['document_congress'].strip(),'amendment_number':document['amendment_number'].strip(),'amendment_to_document_number':document['amendment_to_document_number'].strip(),'documents':documents,'recorded_vote_count':len(ids),'position_tokens':dict(positions)}

def acquire_records(records,window,output,fetch,chamber,inventory_sha256,index_pages_verified):
    """Same §6 acquisition wire format; used for Senate windows and explicit rolls."""
    output=Path(output).absolute()
    if any(p.is_symlink() for p in [output,*output.parents]):raise ValueError('symlink output refused')
    output.mkdir(parents=True,exist_ok=False);(output/'responses').mkdir()
    rows=[{**row,'chamber':chamber,'in_window':window is None or window[0]<=row['date']<=window[1],'attempted':False,'attempted_at':None,'outcome':'pending','reason':None,'response':None,'metadata':None} for row in records]
    for row in rows:
        row['source_url']=source_url(row['congress'],row['session'],row['roll']) if chamber=='senate' else f"https://clerk.house.gov/evs/{row['year']}/roll{row['roll']:03d}.xml"
        if not row['in_window']:row.update(outcome='excluded_outside_window',reason='official listing date outside frozen inclusive window')
    report={'contract':adapter.CONTRACT,'contract_version':1,'chamber':chamber,'status':'running','started_at':adapter.timestamp(),'finished_at':None,'window':list(window) if window else None,'window_policy':adapter.window_policy(window) if window else {'as_of':None,'months':None},'inventory_sha256':inventory_sha256,'index_pages_verified':index_pages_verified,'published_rolls':len(rows),'required_rolls':sum(r['in_window'] for r in rows),'attempted_rolls':0,'max_rolls':None,'safety_cap_applied':False,'counts':dict(Counter(r['outcome'] for r in rows)),'records':rows,'acquisition_semantics':adapter.ACQUISITION_SEMANTICS,'normalized_votes_validated':False,'member_coverage_validated':False,'bill_resolution_validated':False,'collector_revision':None}
    adapter.write_manifest(output,report)
    for row in rows:
        if not row['in_window']:continue
        row.update(attempted=True,attempted_at=adapter.timestamp())
        try:response=fetch(row['source_url'])
        except (OSError,HTTPException,ValueError) as exc:row.update(outcome='source_failure',reason=f'{type(exc).__name__}: {exc}')
        else:
            name=f"responses/{row['year']}-{'s' if chamber=='senate' else 'h'}{row['roll']:05d}.body";(output/name).write_bytes(response.body)
            row['response']={'url':row['source_url'],'final_url':response.final_url,'http_status':response.status,'content_type':response.content_type,'path':name,'sha256':adapter.sha256(response.body),'bytes':len(response.body),'body_complete':response.body_complete,'read_error':response.read_error,'attempted_at':row['attempted_at'],'received_at':adapter.timestamp()}
            if response.final_url!=row['source_url']:row.update(outcome='source_failure',reason='unexpected redirect/effective source URL')
            elif response.status in (404,410):row.update(outcome='incomplete_fetch',reason=f'enumerated XML unavailable: HTTP {response.status}')
            elif response.status!=200:row.update(outcome='source_failure',reason=f'HTTP {response.status}')
            elif not response.body_complete or response.read_error is not None:row.update(outcome='incomplete_fetch',reason=response.read_error or 'incomplete HTTP body')
            elif len(response.body)>adapter.MAX_RESPONSE_BYTES:row.update(outcome='malformed_source',reason='response exceeds XML byte safety cap')
            elif b'This vote was vacated' in response.body:row.update(outcome='unsupported_record',reason='official response contains vacated marker')
            elif b'roll-call-vote-not-available.htm' in response.body:row.update(outcome='incomplete_fetch',reason='enumerated vote detail not published')
            else:
                try:row['metadata']=(validate_senate_xml if chamber=='senate' else adapter.validate_xml)(response.body,row)
                except SenateError as exc:row.update(outcome=exc.outcome,reason=str(exc))
                except (ValueError,ET.ParseError,LookupError) as exc:row.update(outcome='malformed_source',reason=str(exc))
                else:row.update(outcome='acquired')
        report['attempted_rolls']=sum(r['attempted'] for r in rows);report['counts']=dict(Counter(r['outcome'] for r in rows));adapter.write_manifest(output,report)
    report.update(status='acquisition_complete' if report['required_rolls']>0 and all(r['outcome'] in {'acquired','excluded_outside_window'} for r in rows) else 'incomplete',finished_at=adapter.timestamp());adapter.write_manifest(output,report);return report

def acquire_senate(inventory,output,fetch=fetch_senate):
    inventory=validate_inventory(inventory.path,inventory.sha256)
    if Path(output).resolve().is_relative_to(inventory.path.parent):raise SenateError('output may not mutate source evidence directory')
    return acquire_records(inventory.records,inventory.window,output,fetch,'senate',inventory.sha256,inventory.receipt_count)
