"""Stdlib-only tests. Historic XML is official; every mutation is SYNTHETIC.

Tests are integrated from the workbench RED/GREEN controls. No collector packages
are imported, and raw_house is tested directly, not presented as a bridge run.
"""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

WORK = Path(__file__).resolve().parents[2]
CODE = WORK / 'tools/congress-collector'
sys.path.insert(0, str(CODE))
import adapter
import bridge
import senate_adapter

LABEL = 'U.S. House of Representatives'
RECEIPT = json.loads((WORK / 'fixtures/votes/official-samples/house-legacy-2023-roll700.receipt.json').read_bytes())
ROW = RECEIPT['captured_record']
BODY = (WORK / 'fixtures/votes/official-samples/house-legacy-2023-roll700.xml').read_bytes()


def synthetic_labels(fragment):
    """SYNTHETIC: replace only the two metadata labels on real historic XML."""
    root = ET.fromstring(BODY)
    meta = root.find('vote-metadata')
    for tag in ('chamber', 'committee'):
        for node in meta.findall(tag):
            meta.remove(node)
    for node in ET.fromstring('<labels>' + fragment + '</labels>'):
        meta.append(node)
    return ET.tostring(root)


def extract(body, path):
    return adapter.validate_xml(body, ROW) if path == 'acquisition' else bridge.raw_house(ET.fromstring(body))


class HouseMetadataTests(unittest.TestCase):
    def test_official_historic_bytes_match_receipt(self):
        self.assertEqual(hashlib.sha256(BODY).hexdigest(), ROW['response']['sha256'])
        self.assertEqual(len(BODY), ROW['response']['bytes'])
        self.assertEqual(ROW['response']['http_status'], 200)
        self.assertTrue(ROW['response']['body_complete'])
        self.assertIsNone(ROW['response']['read_error'])
        root = ET.fromstring(BODY)
        self.assertIsNone(root.find('vote-metadata/chamber'))
        self.assertEqual(root.findtext('vote-metadata/committee'), LABEL)

    def test_official_historic_acquisition(self):
        result = adapter.validate_xml(BODY, ROW)
        self.assertEqual(result['key'], '118-2023/h700')
        self.assertEqual((result['congress'], result['session'], result['roll'], result['date']), (118, 1, 700, '2023-12-06'))
        self.assertEqual(result['position_tokens'], {'Aye': 202, 'No': 213, 'Not Voting': 24})
        self.assertEqual(result['recorded_vote_count'], 439)
        self.assertEqual((result['legis_num'], result['amendment_num']), ('H R 5933', '8'))
        # SYNTHETIC chamber spelling control; outputs must stay identical.
        chamber = BODY.replace(b'<committee>', b'<chamber>').replace(b'</committee>', b'</chamber>')
        self.assertEqual(result, adapter.validate_xml(chamber, ROW))

    def test_official_historic_raw_extraction(self):
        result = bridge.raw_house(ET.fromstring(BODY))
        self.assertEqual((result['chamber'], result['congress'], result['session'], result['roll'], result['date']), ('house', 118, 1, 700, '2023-12-06'))
        self.assertEqual(result['totals'], {'kind': 'by_vote', 'yea': 202, 'nay': 213, 'present': 0, 'not_voting': 24})
        self.assertEqual(len(result['voters']), 439)
        self.assertEqual(len({v['id'] for v in result['voters']}), 439)
        chamber = BODY.replace(b'<committee>', b'<chamber>').replace(b'</committee>', b'</chamber>')
        self.assertEqual(result, bridge.raw_house(ET.fromstring(chamber)))

    def test_existing_official_house_samples_unchanged(self):
        for name, roll, date in [('house-acquisition/house-2025-roll001.xml', 1, '2025-01-03'), ('official-samples/house-speaker-2025-roll002.xml', 2, '2025-01-03'), ('official-samples/house-bill-2025-roll006.xml', 6, '2025-01-07')]:
            with self.subTest(sample=name):
                body = (WORK / 'fixtures/votes' / name).read_bytes()
                row = dict(key=f'119-2025/h{roll}', congress=119, session=1, roll=roll, date=date)
                result = adapter.validate_xml(body, row)
                raw = bridge.raw_house(ET.fromstring(body))
                for key in ['chamber', 'congress', 'session', 'roll', 'date']:
                    self.assertEqual(result[key], raw[key])
                self.assertEqual(result['recorded_vote_count'], len(raw['voters']))

    def test_synthetic_other_acquisition_checks_remain(self):
        # SYNTHETIC chamber-only control keeps these assertions effective in RED.
        base = synthetic_labels(f'<chamber>{LABEL}</chamber>')
        mutations = {
            'wrong-congress': lambda r: setattr(r.find('vote-metadata/congress'), 'text', '119'),
            'wrong-session': lambda r: setattr(r.find('vote-metadata/session'), 'text', '2nd'),
            'wrong-roll': lambda r: setattr(r.find('vote-metadata/rollcall-num'), 'text', '701'),
            'wrong-date': lambda r: setattr(r.find('vote-metadata/action-date'), 'text', '7-Dec-2023'),
            'missing-voters': lambda r: r.remove(r.find('vote-data')),
            'missing-desc': lambda r: r.find('vote-metadata').remove(r.find('vote-metadata/vote-desc')),
            'duplicate-metadata': lambda r: r.append(copy.deepcopy(r.find('vote-metadata'))),
            'duplicate-vote': lambda r: r.find('vote-data/recorded-vote').append(ET.Element('vote')),
        }
        for name, change in mutations.items():
            with self.subTest(synthetic=name):
                root = ET.fromstring(base); change(root)
                with self.assertRaises(ValueError): adapter.validate_xml(ET.tostring(root), ROW)

    def test_synthetic_raw_voter_and_totals_checks_remain(self):
        base = synthetic_labels(f'<chamber>{LABEL}</chamber>')
        for name in ['duplicate-voter', 'missing-voter-id', 'missing-position', 'missing-totals', 'two-totals-kinds', 'invalid-total']:
            with self.subTest(synthetic=name):
                root = ET.fromstring(base); first = root.find('vote-data/recorded-vote')
                if name == 'duplicate-voter': root.find('vote-data').append(copy.deepcopy(first))
                elif name == 'missing-voter-id': first.find('legislator').attrib.pop('name-id')
                elif name == 'missing-position': first.remove(first.find('vote'))
                elif name == 'missing-totals': root.find('vote-metadata').remove(root.find('vote-metadata/vote-totals'))
                elif name == 'two-totals-kinds': root.find('vote-metadata/vote-totals').append(ET.Element('totals-by-candidate'))
                else: root.find('vote-metadata/vote-totals/totals-by-vote/yea-total').text = 'invalid'
                with self.assertRaises(ValueError): bridge.raw_house(root)

    def test_synthetic_body_hash_check_precedes_collector(self):
        # A deliberately incorrect hash must be rejected before any package API.
        row = {**ROW, 'path': str(WORK / 'fixtures/votes/official-samples/house-legacy-2023-roll700.xml'), 'sha256': '0' * 64}
        result = bridge.process(row, None, None, None)
        self.assertFalse(result['ok'])
        self.assertEqual(result['outcome'], 'malformed_source')
        self.assertIn('body sha256 mismatch', result['reason'])

    def test_isolated_python_imports(self):
        # Same -I/-B loading conditions as bridge execution; no package invocation.
        for module in ('adapter', 'bridge'):
            script = ('import importlib.util,sys; p=sys.argv[1]; '
                      's=importlib.util.spec_from_file_location("isolated_subject",p); '
                      'm=importlib.util.module_from_spec(s); sys.modules[s.name]=m; '
                      's.loader.exec_module(m)')
            result = subprocess.run([sys.executable, '-I', '-B', '-c', script, str(CODE / (module + '.py'))], cwd=tempfile.gettempdir(), capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)


accepted = {
    'chamber_only': f'<chamber>{LABEL}</chamber>',
    'committee_only': f'<committee>{LABEL}</committee>',
    'both_matching': f'<chamber>{LABEL}</chamber><committee>{LABEL}</committee>',
}
rejected = {'both_missing': '', 'nested_labels_only': f'<wrapper><chamber>{LABEL}</chamber></wrapper>'}
for tag, other in [('chamber', 'committee'), ('committee', 'chamber')]:
    for name, fragment in {
        'empty': f'<{tag}/>',
        'blank': f'<{tag}> </{tag}>',
        'wrong': f'<{tag}>U.S. Senate</{tag}>',
        'case': f'<{tag}>{LABEL.lower()}</{tag}>',
        'padded': f'<{tag}> {LABEL} </{tag}>',
        'structured': f'<{tag}><label>{LABEL}</label></{tag}>',
        'structured_tail': f'<{tag}>{LABEL}<label/></{tag}>',
        'attributed': f'<{tag} source="synthetic">{LABEL}</{tag}>',
        'duplicate': f'<{tag}>{LABEL}</{tag}><{tag}>{LABEL}</{tag}>',
    }.items():
        rejected[f'{tag}_{name}_alone'] = fragment
        rejected[f'{tag}_{name}_with_valid_other'] = f'<{other}>{LABEL}</{other}>' + fragment


def matrix_test(fragment, accepted, path):
    def test(self):
        body = synthetic_labels(fragment)
        if accepted:
            result = extract(body, path)
            self.assertEqual(result['chamber'], 'house')
            self.assertEqual(result['roll'], 700)
        else:
            with self.assertRaises(ValueError): extract(body, path)
    return test

for path in ['acquisition', 'raw']:
    for name, fragment in accepted.items():
        setattr(HouseMetadataTests, f'test_synthetic_{path}_accept_{name}', matrix_test(fragment, True, path))
    for name, fragment in rejected.items():
        setattr(HouseMetadataTests, f'test_synthetic_{path}_reject_{name}', matrix_test(fragment, False, path))

if __name__ == '__main__': unittest.main(verbosity=2)
