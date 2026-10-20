"""Real pinned parser checks on retained official bytes and marked synthetic mutations."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BRIDGE = HERE / 'bridge.py'
PYTHON = HERE / '.runtime/venv/bin/python'
SAMPLES = [
 ('house-acquisition/house-2025-roll001.xml','house',1,'2025-01-03'),
 ('official-samples/house-speaker-2025-roll002.xml','house',2,'2025-01-03'),
 ('official-samples/house-bill-2025-roll006.xml','house',6,'2025-01-07'),
 ('official-samples/senate-119-1-roll00001.xml','senate',1,'2025-01-09'),
 ('official-samples/senate-amendment-119-1-roll00003.xml','senate',3,'2025-01-15'),
 ('official-samples/senate-bill-119-1-roll00570.xml','senate',570,'2025-10-09'),
 ('official-samples/senate-nomination-119-1-roll00655.xml','senate',655,'2025-12-18'),
]

def inputs():
    rows=[]
    for rel,chamber,roll,date in SAMPLES:
        path=ROOT/'fixtures/votes'/rel
        letter='h' if chamber=='house' else 's'
        url=f'https://clerk.house.gov/evs/2025/roll{roll:03d}.xml' if letter=='h' else f'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_{roll:05d}.xml'
        rows.append(dict(key=f'119-2025/{letter}{roll}',chamber=chamber,congress=119,session=1,year=2025,roll=roll,date=date,source_url=url,path=str(path),sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    return rows


def invoke(rows, isolated=True):
    with tempfile.TemporaryDirectory() as tmp:
        cmd=(['unshare','-rn'] if isolated else [])+[str(PYTHON),'-I','-B',str(BRIDGE)]
        return subprocess.run(cmd,input=json.dumps({'rolls':rows}),text=True,capture_output=True,cwd=tmp,env={'PATH':'/usr/bin:/bin','HOME':tmp,'TMPDIR':tmp,'LANG':'C.UTF-8'},timeout=60)


class BridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows=inputs()
        result=invoke(cls.rows)
        if result.returncode:
            raise AssertionError(f'bridge exited {result.returncode}: {result.stderr}')
        cls.output=json.loads(result.stdout)

    def test_all_seven_official_samples(self):
        self.assertEqual(len(self.output['results']),7)
        self.assertEqual(self.output['network']['interfaces'],['lo'])
        self.assertEqual(set(self.output['inference_disabled']),{'lookup_legislator','require_congress_legislators_repo','download'})
        for row,result in zip(self.rows,self.output['results']):
            self.assertTrue(result['ok'],result)
            self.assertEqual(result['key'],row['key'])
            for field in ['chamber','congress','session','roll','date']:
                self.assertEqual(result['raw'][field],row[field])
            self.assertNotIn('updated_at',result['collector'])
            actual={v['id']:option for option,voters in result['collector']['votes'].items() for v in voters if v!='VP'}
            self.assertEqual(actual,{v['id']:v['raw_position'].replace('Present, Giving Live Pair','Present') for v in result['raw']['voters']})

    def test_speaker(self):
        raw=self.output['results'][1]['raw']
        self.assertEqual(len(raw['voters']),434)
        self.assertEqual(raw['totals']['kind'],'by_candidate')
        counts={c['name']:c['total'] for c in raw['totals']['candidates']}
        self.assertEqual([counts[k] for k in ['Johnson (LA)','Jeffries','Emmer']],[218,215,1])

    def test_house_bill(self):
        result=self.output['results'][2]
        self.assertEqual(result['raw']['totals'],dict(kind='by_vote',yea=264,nay=159,present=0,not_voting=11))
        self.assertEqual(result['collector']['bill'],dict(congress=119,type='hr',number=29))

    def test_senate_amendment(self):
        result=self.output['results'][4]
        self.assertEqual(result['raw']['count'],dict(yeas=70,nays=25,present=0,absent=4))
        self.assertEqual(len(result['raw']['voters']),99)
        self.assertEqual({k:result['collector']['bill'][k] for k in ['congress','type','number']},dict(congress=119,type='s',number=5))

    def test_nomination(self):
        self.assertEqual(self.output['results'][6]['raw']['document']['document_type'],'PN')

    def test_nomination_bundle_preserves_97_distinct_documents(self):
        raw=self.output['results'][6]['raw']
        source=ET.parse(self.rows[6]['path']).getroot()
        expected=[n.findtext('document_number') for n in source.findall('document')]
        self.assertEqual(len(raw['documents']),97)
        self.assertEqual(raw['document'],raw['documents'][0])
        self.assertEqual([d['document_number'] for d in raw['documents']],expected)
        self.assertEqual(len({d['document_number'] for d in raw['documents']}),97)
        self.assertTrue(all(d['document_congress']=='119' and d['document_type']=='PN' for d in raw['documents']))

    def test_conflicting_multi_document_bundles_rejected(self):
        # SYNTHETIC bundle mutations; none is source evidence.
        for kind in ['mixed','bills','unknown','congress','amendment']:
            with self.subTest(kind=kind):
                root=ET.parse(self.rows[6]['path']).getroot();docs=root.findall('document')
                if kind=='mixed':docs[1].find('document_type').text='S.'
                elif kind=='bills':
                    for d in docs:d.find('document_type').text='S.'
                elif kind=='unknown':
                    for d in docs:d.find('document_type').text='Unknown'
                elif kind=='congress':docs[-1].find('document_congress').text='118'
                else:root.findall('amendment')[1].find('amendment_number').text='S.Amdt. 1'
                value=self.failure(ET.tostring(root),row_index=6)
                self.assertEqual(value['outcome'],'ambiguity',value)

    def failure(self,body=None,change=None,row_index=2):
        row=dict(self.rows[row_index])
        with tempfile.TemporaryDirectory() as tmp:
            if body is not None:
                path=Path(tmp)/'SYNTHETIC.xml';path.write_bytes(body)
                row.update(path=str(path),sha256=hashlib.sha256(body).hexdigest())
            if change:row.update(change)
            result=invoke([row]);self.assertEqual(result.returncode,0,result.stderr)
            value=json.loads(result.stdout)['results'][0]
            self.assertFalse(value['ok'])
            return value

    def test_sha_mismatch(self):
        self.assertEqual(self.failure(change={'sha256':'0'*64})['outcome'],'malformed_source')

    def test_wrong_date(self):
        self.assertIn('date',self.failure(change={'date':'2025-01-08'})['reason'])

    def test_vacated(self):
        self.assertEqual(self.failure(b'This vote was vacated')['outcome'],'unsupported_record')

    def test_not_available(self):
        self.assertEqual(self.failure(b'roll-call-vote-not-available.htm')['outcome'],'incomplete_fetch')

    def test_duplicate_id(self):
        # SYNTHETIC official-byte mutation, not an official record.
        root=ET.parse(self.rows[2]['path']).getroot(); nodes=root.findall('vote-data/recorded-vote/legislator');nodes[1].set('name-id',nodes[0].get('name-id'))
        self.assertEqual(self.failure(ET.tostring(root))['outcome'],'ambiguity')

    def test_empty_id_no_inference(self):
        # SYNTHETIC official-byte mutation, never inferred by name.
        root=ET.parse(self.rows[2]['path']).getroot(); root.find('vote-data/recorded-vote/legislator').set('name-id','')
        result=self.failure(ET.tostring(root));self.assertEqual(result['outcome'],'malformed_source');self.assertIn('empty voter id',result['reason'])

    def test_entity_rejected(self):
        self.assertEqual(self.failure(b'<!DOCTYPE x [<!ENTITY x "evil">]><x/>')['outcome'],'malformed_source')

    def test_utf16_entity_rejected(self):
        # SYNTHETIC UTF-16 declaration must not bypass the byte-level entity guard.
        value=self.failure('<!DOCTYPE x [<!ENTITY x \"evil\">]><x>&x;</x>'.encode('utf-16'))
        self.assertEqual(value['outcome'],'malformed_source')
        self.assertIn('entity/internal DTD',value['reason'])

    def test_host_namespace_refused(self):
        interfaces={line.split(':')[0].strip() for line in Path('/proc/self/net/dev').read_text().splitlines() if ':' in line}
        if interfaces <= {'lo'}:self.skipTest('host namespace only has loopback')
        result=invoke(self.rows,False)
        self.assertEqual(result.returncode,2);self.assertEqual(result.stdout,'');self.assertIn('network',result.stderr)

    def test_inference_guards_raise(self):
        # Execute the actual vendored imports and all three replaced helpers offline.
        code = """import importlib.util,sys
from pathlib import Path
p=Path(sys.argv[1]);spec=importlib.util.spec_from_file_location('bridge_under_test',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.runtime.require_offline();m.runtime.verify_vendor();sys.path.insert(0,str(m.runtime.VENDOR))
from congress.tasks import utils
m.disable_inference(utils)
for name in m.DISABLED:
 try:getattr(utils,name)()
 except m.CollectorInferenceDisabled:pass
 else:raise AssertionError(name+' not disabled')
print('three guards raised')
"""
        with tempfile.TemporaryDirectory() as tmp:
            result=subprocess.run(['unshare','-rn',str(PYTHON),'-I','-B','-c',code,str(BRIDGE)],cwd=tmp,env={'PATH':'/usr/bin:/bin','HOME':tmp,'TMPDIR':tmp,'LANG':'C.UTF-8'},capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.strip(),'three guards raised')

    def test_invalid_request(self):
        result=invoke([dict(self.rows[0],key='119-2025/h99')])
        self.assertEqual(result.returncode,2)


if __name__=='__main__':unittest.main()
