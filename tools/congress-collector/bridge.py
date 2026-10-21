#!/usr/bin/env python3
"""Offline pinned congress parser; stdout is exactly one BridgeRun JSON document."""
import contextlib
from datetime import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('collector_runtime',HERE/'runtime.py')
runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
spec=importlib.util.spec_from_file_location('senate_documents',HERE/'senate_documents.py')
senate_documents=importlib.util.module_from_spec(spec);spec.loader.exec_module(senate_documents)
DISABLED=['lookup_legislator','require_congress_legislators_repo','download']


class CollectorInferenceDisabled(RuntimeError):
    pass


class RollFailure(ValueError):
    def __init__(self,outcome,reason):
        self.outcome=outcome
        super().__init__(reason)


def disable_inference(utils):
    def guard(*args,**kwargs):
        raise CollectorInferenceDisabled('collector inference/download is disabled')
    for name in DISABLED:setattr(utils,name,guard)


def text(node,path,trim=True):
    found=node.find(path)
    value='' if found is None else ''.join(found.itertext())
    return value.strip() if trim else value


def integer(value,label,empty_zero=False):
    if empty_zero and value=='':return 0
    if not re.fullmatch(r'\d+',value):raise ValueError(f'invalid integer {label}')
    return int(value)


def voters(nodes,id_getter,position_path):
    result=[]; seen=set()
    for node in nodes:
        ident=id_getter(node)
        if not ident or not ident.strip():raise ValueError('empty voter id; inference disabled')
        if ident in seen:raise RollFailure('ambiguity',f'duplicate voter id: {ident}')
        seen.add(ident)
        position=node.find(position_path)
        if position is None:raise ValueError('missing raw position')
        result.append({'id':ident,'raw_position':text(node,position_path,False)})
    if not result:raise ValueError('no voters')
    return result


def raw_house(root):
    if root.tag!='rollcall-vote':raise ValueError('wrong House root')
    meta=root.find('vote-metadata')
    if meta is None:raise ValueError('missing vote-metadata')
    if text(meta,'chamber')!='U.S. House of Representatives':raise ValueError('wrong House chamber')
    session=text(meta,'session')
    if session not in ('1st','2nd'):raise ValueError('invalid House session')
    by_vote=meta.findall('vote-totals/totals-by-vote'); by_candidate=meta.findall('vote-totals/totals-by-candidate')
    if bool(by_vote)==bool(by_candidate) or len(by_vote)>1:raise ValueError('expected exactly one totals kind')
    if by_vote:
        totals={'kind':'by_vote',**{name:integer(text(by_vote[0],tag),tag) for name,tag in [('yea','yea-total'),('nay','nay-total'),('present','present-total'),('not_voting','not-voting-total')]}}
    else:
        totals={'kind':'by_candidate','candidates':[{'name':text(n,'candidate'),'total':integer(text(n,'candidate-total'),'candidate-total')} for n in by_candidate]}
        names=[c['name'] for c in totals['candidates']]
        if any(not n for n in names) or len(set(names))!=len(names):raise ValueError('empty or duplicate candidate total')
    return dict(chamber='house',congress=integer(text(meta,'congress'),'congress'),session=1 if session=='1st' else 2,roll=integer(text(meta,'rollcall-num'),'roll'),date=datetime.strptime(text(meta,'action-date'),'%d-%b-%Y').date().isoformat(),legis_num=text(meta,'legis-num'),vote_type=text(meta,'vote-type'),question=text(meta,'vote-question'),vote_desc=text(meta,'vote-desc'),result=text(meta,'vote-result'),amendment_num=text(meta,'amendment-num') or None,totals=totals,voters=voters(root.findall('vote-data/recorded-vote'),lambda n:n.find('legislator').get('name-id','') if n.find('legislator') is not None else '', 'vote'))


def raw_senate(root):
    if root.tag!='roll_call_vote':raise ValueError('wrong Senate root')
    if root.find('count') is None:raise ValueError('missing count')
    try:document,documents=senate_documents.read_senate_documents(root)
    except senate_documents.SenateDocumentAmbiguity as exc:raise RollFailure('ambiguity',str(exc)) from exc
    date=datetime.strptime(' '.join(text(root,'vote_date').split()),'%B %d, %Y, %I:%M %p').date().isoformat()
    return dict(chamber='senate',congress=integer(text(root,'congress'),'congress'),session=integer(text(root,'session'),'session'),roll=integer(text(root,'vote_number'),'roll'),date=date,question=text(root,'question'),vote_title=text(root,'vote_title'),result=text(root,'vote_result'),document=document,documents=documents,count={name:integer(text(root,f'count/{name}'),name,True) for name in ['yeas','nays','present','absent']},tie_breaker={'by_whom':text(root,'tie_breaker/by_whom',False),'vote':text(root,'tie_breaker/tie_breaker_vote',False)},voters=voters(root.findall('members/member'),lambda n:text(n,'lis_member_id',False),'vote_cast'))


def validate_input(row):
    if not isinstance(row,dict):raise ValueError('roll must be object')
    for name in ['congress','session','year','roll']:
        if type(row.get(name)) is not int or row[name]<=0:raise ValueError(f'invalid input {name}')
    if row['session'] not in (1,2) or row['year']!=1787+2*row['congress']+row['session']-1:raise ValueError('input session/year mismatch')
    if row.get('chamber') not in ('house','senate'):raise ValueError('invalid chamber')
    letter='h' if row['chamber']=='house' else 's'
    if row.get('key')!=f"{row['congress']}-{row['year']}/{letter}{row['roll']}":raise ValueError('input key identity mismatch')
    date=row.get('date')
    if not isinstance(date,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',date):raise ValueError('invalid input date')
    datetime.strptime(date,'%Y-%m-%d')
    path=row.get('path')
    if not isinstance(path,str) or not Path(path).is_absolute() or not Path(path).is_file():raise ValueError('input path must be existing absolute file')
    if not isinstance(row.get('sha256'),str) or not re.fullmatch(r'[0-9a-f]{64}',row['sha256']):raise ValueError('invalid sha256')
    url=f"https://clerk.house.gov/evs/{row['year']}/roll{row['roll']:03d}.xml" if letter=='h' else f"https://www.senate.gov/legislative/LIS/roll_call_votes/vote{row['congress']}{row['session']}/vote_{row['congress']}_{row['session']}_{row['roll']:05d}.xml"
    if row.get('source_url')!=url:raise ValueError('input source_url identity mismatch')


def process(row,vote_info,utils,etree):
    try:
        body=Path(row['path']).read_bytes()
        if hashlib.sha256(body).hexdigest()!=row['sha256']:raise ValueError('body sha256 mismatch')
        if b'This vote was vacated' in body:raise RollFailure('unsupported_record','This vote was vacated')
        if b'roll-call-vote-not-available.htm' in body:raise RollFailure('incomplete_fetch','roll call vote not available')
        # External SYSTEM doctype in official historical files is inert; internal subsets/entities are forbidden.
        declarations=body.replace(b'\x00',b'')  # Also recognize UTF-16/32 ASCII declaration characters.
        if re.search(br'<!ENTITY',declarations,re.I) or re.search(br'<!DOCTYPE[^>]*\[',declarations,re.I):raise ValueError('XML entity/internal DTD subset forbidden')
        root=ET.fromstring(body)
        raw=raw_house(root) if row['chamber']=='house' else raw_senate(root)
        mismatch=[name for name in ['chamber','congress','session','roll','date'] if raw[name]!=row[name]]
        if mismatch:raise ValueError('raw identity mismatch: '+','.join(mismatch))
        letter='h' if row['chamber']=='house' else 's'
        vote=dict(vote_id=f"{letter}{row['roll']}-{row['congress']}.{row['year']}",chamber=letter,congress=row['congress'],session=str(row['year']),number=row['roll'],source_url=row['source_url'])
        try:
            dom=etree.fromstring(body,parser=etree.XMLParser(resolve_entities=False,no_network=True,load_dtd=False))
            with contextlib.redirect_stdout(sys.stderr):
                (vote_info.parse_house_vote if letter=='h' else vote_info.parse_senate_vote)(dom,vote)
            vote.pop('updated_at',None)
            vote=json.loads(json.dumps(vote,default=utils.format_datetime))
        except Exception as exc:
            raise ValueError(f'collector parse failed: {type(exc).__name__}: {exc}') from exc
        return dict(key=row['key'],ok=True,raw=raw,collector=vote)
    except RollFailure as exc:return dict(key=row['key'],ok=False,outcome=exc.outcome,reason=str(exc))
    except Exception as exc:return dict(key=row['key'],ok=False,outcome='malformed_source',reason=f'{type(exc).__name__}: {exc}')


def main():
    try:
        net=runtime.require_offline();vendor=runtime.verify_vendor()
        metadata=runtime.check_runtime(Path(sys.prefix).parent)
        # Isolated-mode Python excludes both cwd and script directory. Only this verified root is added.
        sys.path.insert(0,str(runtime.VENDOR))
        with contextlib.redirect_stdout(sys.stderr):
            from congress.tasks import vote_info,utils
            from lxml import etree
        disable_inference(utils)
        request=json.load(sys.stdin)
        if not isinstance(request,dict) or not isinstance(request.get('rolls'),list) or not request['rolls']:raise ValueError('request rolls must be a non-empty list')
        for row in request['rolls']:validate_input(row)
        if len({row['key'] for row in request['rolls']})!=len(request['rolls']):raise ValueError('duplicate input key')
        result=dict(bridge='civiclens.congress-collector-bridge',bridge_version=1,collector={'repository':vendor['repository'],'commit':vendor['commit'],'vendor_manifest_sha256':runtime.digest(runtime.VENDOR/'VENDOR.json')},runtime={k:metadata[k] for k in ['python','lock_sha256','packages']},network={'interfaces':net},inference_disabled=DISABLED,results=[process(row,vote_info,utils,etree) for row in request['rolls']])
        print(json.dumps(result,ensure_ascii=False,sort_keys=True))
        return 0
    except Exception as exc:
        print(json.dumps({'status':'failed','reason':f'{type(exc).__name__}: {exc}'}),file=sys.stderr)
        return 2


if __name__=='__main__':sys.exit(main())
