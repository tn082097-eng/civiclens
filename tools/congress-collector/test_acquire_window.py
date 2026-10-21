"""Offline rolls CLI over frozen XMLs. Selected fixtures are NOT full-window evidence."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import acquire_window as aw
import senate_adapter as sa
ROOT=Path(__file__).resolve().parents[2]
FIX=ROOT/'fixtures/votes'
class WindowTests(unittest.TestCase):
 def run_cli(self,chamber,wrong=False):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);root=Path(temp.name)
  samples=([('119-2025/h1','2025-01-03',FIX/'house-acquisition/house-2025-roll001.xml'),('119-2025/h2','2025-01-03',FIX/'official-samples/house-speaker-2025-roll002.xml'),('119-2025/h6','2025-01-07',FIX/'official-samples/house-bill-2025-roll006.xml')] if chamber=='house' else [('119-2025/s1','2025-01-09',FIX/'official-samples/senate-119-1-roll00001.xml'),('119-2025/s3','2025-01-15',FIX/'official-samples/senate-amendment-119-1-roll00003.xml'),('119-2025/s570','2025-10-09',FIX/'official-samples/senate-bill-119-1-roll00570.xml'),('119-2025/s655','2025-12-18',FIX/'official-samples/senate-nomination-119-1-roll00655.xml')])
  rolls=[{'key':key,'date':date} for key,date,_ in samples]
  if wrong:rolls[0]['date']='2025-01-01'
  (root/'rolls.json').write_text(json.dumps(rolls));(root/'map.json').write_text(json.dumps({aw.roll_record({'key':key,'date':date},chamber)['source_url']:str(path) for key,date,path in samples}))
  result=subprocess.run([sys.executable,'-I','-B',str(ROOT/'tools/congress-collector/acquire_window.py'),'--chamber',chamber,'--rolls-json',str(root/'rolls.json'),'--output',str(root/'run'),'--fixture-map',str(root/'map.json')],capture_output=True,text=True)
  return result,json.loads((root/'run/window-run.json').read_bytes()),root
 def test_seven_frozen_rolls(self):
  for chamber,count in [('house',3),('senate',4)]:
   result,run,root=self.run_cli(chamber);self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(run['status'],'complete');self.assertIn('fixture_mode',run['reason'])
   manifest=json.loads((root/'run'/run['manifest_path']).read_bytes());self.assertEqual(manifest['required_rolls'],count)
 def test_wrong_date_incomplete_exit_one(self):
  for chamber in ['house','senate']:
   result,run,_=self.run_cli(chamber,True);self.assertEqual(result.returncode,1);self.assertEqual(run['status'],'incomplete')
 def test_bad_key_and_duplicate_rejected(self):
  for item in [{'key':'119-2025/h01','date':'2025-01-03'},{'key':'119-2025/s1','date':'2025-01-03'},{'key':'119-2025/h1','date':'2025-02-30'}]:
   with self.assertRaises(ValueError):aw.roll_record(item,'house')
 def test_cli_rejects_non_48_months(self):
  result=subprocess.run([sys.executable,'-I','-B',str(ROOT/'tools/congress-collector/acquire_window.py'),'--chamber','senate','--as-of','2025-01-16','--months','1','--output','/unused'],capture_output=True,text=True)
  self.assertNotEqual(result.returncode,0)
