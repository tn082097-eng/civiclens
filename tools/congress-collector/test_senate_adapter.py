"""Frozen official Senate menu/details, with explicit SYNTHETIC malformed controls."""
import copy
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET
import adapter
import senate_adapter as sa
FIX=Path(__file__).resolve().parents[2]/'fixtures/votes/official-samples'
class SenateTests(unittest.TestCase):
 def test_frozen_menu(self):
  rows=sa.parse_menu((FIX/'senate-menu-119-1.xml').read_bytes(),119,1)
  self.assertEqual(len(rows),659);self.assertEqual({r['roll'] for r in rows},set(range(1,660)))
 def test_synthetic_gap_duplicate_wrong_session(self):
  original=(FIX/'senate-menu-119-1.xml').read_bytes()
  for body in [original.replace(b'<vote_number>00659</vote_number>',b'<vote_number>00660</vote_number>'),original.replace(b'<vote_number>00659</vote_number>',b'<vote_number>00658</vote_number>'),original.replace(b'<session>1</session>',b'<session>2</session>')]:
   with self.assertRaises(sa.SenateError):sa.parse_menu(body,119,1)
 def test_frozen_details_and_wrong_date(self):
  for name,roll,date in [('senate-119-1-roll00001.xml',1,'2025-01-09'),('senate-amendment-119-1-roll00003.xml',3,'2025-01-15'),('senate-bill-119-1-roll00570.xml',570,'2025-10-09'),('senate-nomination-119-1-roll00655.xml',655,'2025-12-18')]:
   row={'key':f'119-2025/s{roll}','congress':119,'session':1,'year':2025,'roll':roll,'date':date}
   body=(FIX/name).read_bytes();meta=sa.validate_senate_xml(body,row)
   self.assertEqual(sum(meta['position_tokens'].values()),meta['recorded_vote_count'])
   if roll==655:
    self.assertEqual(len(meta['documents']),97)
    self.assertEqual([d['document_number'] for d in meta['documents']],[d.findtext('document_number') for d in ET.fromstring(body).findall('document')])
    self.assertEqual(meta['document_number'],meta['documents'][0]['document_number'])
   with self.assertRaises(ValueError):sa.validate_senate_xml(body,{**row,'date':'2025-01-01'})
 def test_synthetic_bundle_conflicts_are_ambiguity_in_acquisition(self):
  row={'key':'119-2025/s655','congress':119,'session':1,'year':2025,'roll':655,'date':'2025-12-18'}
  for kind in ['mixed','bills','unknown','congress','amendment','duplicate_number','shared_amendment']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as d:
    root=ET.parse(FIX/'senate-nomination-119-1-roll00655.xml').getroot();docs=root.findall('document')
    if kind=='mixed':docs[1].find('document_type').text='S.'
    elif kind in ('bills','unknown'):
     for doc in docs:doc.find('document_type').text='S.' if kind=='bills' else 'Unknown'
    elif kind=='congress':docs[-1].find('document_congress').text='118'
    elif kind=='amendment':root.findall('amendment')[1].find('amendment_number').text='S.Amdt. 1'
    elif kind=='duplicate_number':docs[1].find('document_number').text=docs[0].findtext('document_number')
    else:
     for amend in root.findall('amendment'):amend.find('amendment_to_document_number').text='S. 5'
    body=ET.tostring(root)
    with self.assertRaises(sa.SenateError) as failure:sa.validate_senate_xml(body,row)
    self.assertEqual(failure.exception.outcome,'ambiguity')
    report=sa.acquire_records([row],None,Path(d)/'acquisition',lambda url:adapter.Response(200,body,url,'text/xml'),'senate','0'*64,0)
    self.assertEqual(report['status'],'incomplete')
    self.assertEqual(report['records'][0]['outcome'],'ambiguity')
    self.assertIsNone(report['records'][0]['metadata'])
 def test_menu_http_redirect_partial(self):
  with tempfile.TemporaryDirectory() as d:
   for n,res in enumerate([adapter.Response(404,b'bad','wrong','text/html'),adapter.Response(200,b'bad','https://example.com','text/xml'),adapter.Response(200,b'bad',sa.menu_url(119,1),'text/xml',False,'partial')]):
    with self.assertRaises(sa.SenateError):sa.discover_senate(('2025-01-01','2025-01-16'),Path(d)/str(n),lambda _:res)
 def test_frozen_discovery_and_acquisition(self):
  with tempfile.TemporaryDirectory() as d:
   p,h=sa.discover_senate(('2025-01-09','2025-01-09'),Path(d)/'discovery',lambda url:adapter.Response(200,(FIX/'senate-menu-119-1.xml').read_bytes(),url,'text/xml'))
   inv=sa.validate_inventory(p,h);self.assertEqual(len(inv.selected),1)
   self.assertEqual(inv.selected[0]['roll'],1)
   report=sa.acquire_senate(inv,Path(d)/'acquisition',lambda url:adapter.Response(200,(FIX/'senate-119-1-roll00001.xml').read_bytes(),url,'text/xml'))
   self.assertEqual(report['status'],'acquisition_complete');self.assertEqual(report['required_rolls'],1)
