"""Offline controls: synthetic session listings; one frozen official page."""
import json
from pathlib import Path
import tempfile
import unittest
import adapter
import house_discovery as hd
from test_adapter import packet_at

class HouseDiscoveryTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
  self.source=self.root/'source';self.source.mkdir();path,_=packet_at(self.source,count=11)
  self.packet=json.loads(path.read_bytes());self.bodies={r['url']:(self.source/r['path']).read_bytes() for r in self.packet['receipts']}
 def fetch(self,url):return adapter.Response(200,self.bodies[url],url,'text/html')
 def test_synthetic_complete_two_pages(self):
  path,sha=hd.discover_house(('2025-01-03','2025-01-03'),self.root/'out',self.fetch)
  inv=adapter.validate_inventory(path,sha);self.assertEqual(len(inv.selected),11)
 def test_synthetic_changed_total(self):
  url=self.packet['receipts'][1]['url'];self.bodies[url]=self.bodies[url].replace(b'of 11 Results',b'of 12 Results')
  with self.assertRaises(hd.DiscoveryError):hd.discover_house(('2025-01-03','2025-01-03'),self.root/'out',self.fetch)
 def test_http_and_redirect_and_partial_fail(self):
  for name,response in [('http',adapter.Response(500,b'error','same','text/html')),('redirect',adapter.Response(200,b'error','https://example.com','text/html')),('partial',None)]:
   def fetch(url):return response or adapter.Response(200,self.bodies[url],url,'text/html',False,'SYNTHETIC partial')
   with self.subTest(name=name),self.assertRaises(hd.DiscoveryError):hd.discover_house(('2025-01-03','2025-01-03'),self.root/name,fetch)
 def test_real_frozen_page(self):
  path=Path(__file__).resolve().parents[2]/'fixtures/votes/house-acquisition/2025-page037.html'
  body=path.read_bytes();receipt={'status':200,'url':'https://clerk.house.gov/Votes/MemberVotes?CongressNum=119&Session=1st&Page=37','sha256':adapter.sha256(body),'range':[361,370],'total':373}
  # Source counter is read from the frozen bytes, never assumed to be current.
  import re
  a,b,total=map(int,re.search(rb'class="pagination_info">\s*(\d+)\s*-\s*(\d+)\s+of\s+(\d+) Results',body).groups());receipt.update(range=[a,b],total=total)
  self.assertEqual(len(adapter.parse_listing(body,receipt,2025)),b-a+1)
