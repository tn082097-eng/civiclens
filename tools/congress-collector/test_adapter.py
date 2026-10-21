"""Acquisition contract tests. Small listings/error responses are SYNTHETIC.

The raw page/XML fixtures are official saved bytes; they are never benchmark
truth for normalized votes or certification. All HTTP is injected, no network.
"""
import copy
import hashlib
from http.client import IncompleteRead
from io import BytesIO
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import adapter

FIXTURES = Path(__file__).resolve().parents[2] / 'fixtures/votes/house-acquisition'
REAL_XML = (FIXTURES / 'house-2025-roll001.xml').read_bytes()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def packet_at(root, count=21, window=('2025-01-03', '2025-01-03')):
    """Write a synthetic complete three-page listing, with duplicate counters.

    Rolls 1..21 all on Jan 3 are deliberately synthetic pagination cases.
    """
    rows = []
    receipts = []
    for page in range(1, (count + 9) // 10 + 1):
        start, end = (page - 1) * 10 + 1, min(page * 10, count)
        counter = f'<div class="pagination_info">{start} - {end} of {count} Results</div>'
        blocks = []
        for roll in range(start, end + 1):
            blocks.append(f'''<div class="role-call-vote">
              Roll Call Number: <a href="/Votes/2025{roll}?Page={page+1}">{roll}</a>
              <span>Jan 3, 2025, 12:33 PM</span>
              <label>Status:</label>Passed</div>''')
            rows.append({'year': 2025, 'roll': roll, 'date': '2025-01-03',
                         'status': 'Passed', 'url': f'https://clerk.house.gov/Votes/2025{roll}', 'page': page})
        # Malformed top action remains raw evidence. Bottom numbered link is valid.
        action = '' if end == count else f'''<a data-action="/Votes/MemberVotes?Page={page+1}&amp;CongressNum=119&amp;Session=1st')">next</a>
          <a data-action="/Votes/MemberVotes?Page={page+1}&amp;CongressNum=119&amp;Session=1st">{page+1}</a>'''
        body = (counter + action + ''.join(blocks) + counter).encode()
        name = f'2025-page{page:03d}.html'
        (root / name).write_bytes(body)
        receipts.append({'url': f'https://clerk.house.gov/Votes/MemberVotes?CongressNum=119&Session=1st&Page={page}',
                         'status': 200, 'path': name, 'sha256': digest(body), 'range': [start, end],
                         'total': count, 'fetched_at': '2026-10-05T00:28:56+00:00'})
    packet = {'window': list(window), 'summary': [{'year': 2025, 'published_total': count,
              'pages': len(receipts), 'window_total': count if window[0] <= '2025-01-03' <= window[1] else 0}],
              'inventory': rows, 'receipts': receipts,
              'window_total': count if window[0] <= '2025-01-03' <= window[1] else 0}
    return save_packet(root, packet)


def save_packet(root, packet):
    path = root / 'inventory.json'
    path.write_text(json.dumps(packet))
    return path, digest(path.read_bytes())


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.path, self.sha = packet_at(self.root)

    def load(self):
        return adapter.validate_inventory(self.path, self.sha)

    def alter(self, change):
        packet = json.loads(self.path.read_text())
        change(packet)
        self.path, self.sha = save_packet(self.root, packet)

    def test_complete_listing_with_numbered_continuations_and_inclusive_window(self):
        inv = self.load()
        self.assertEqual(len(inv.records), 21)
        self.assertEqual(len(inv.selected), 21)
        self.assertEqual(inv.selected[0]['key'], '119-2025/h1')
        self.assertEqual(inv.selected[-1]['key'], '119-2025/h21')

    def test_missing_middle_page_is_not_complete(self):
        self.alter(lambda p: p['receipts'].pop(1))
        with self.assertRaises(adapter.InventoryError):
            self.load()

    def test_duplicate_roll_and_conflicting_identity_are_rejected(self):
        self.alter(lambda p: p['inventory'].__setitem__(1, copy.deepcopy(p['inventory'][0])))
        with self.assertRaises(adapter.InventoryError):
            self.load()

    def test_inventory_rows_must_match_saved_source_bytes(self):
        self.alter(lambda p: p['inventory'][0].update(date='2025-01-04'))
        with self.assertRaises(adapter.InventoryError):
            self.load()

    def test_raw_page_hash_mismatch_stops_before_acquisition(self):
        (self.root / '2025-page001.html').write_bytes(b'<html>login</html>')
        with self.assertRaises(adapter.InventoryError):
            self.load()

    def test_pinned_inventory_hash_is_required(self):
        self.path.write_text(self.path.read_text() + '\n')
        with self.assertRaises(adapter.InventoryError):
            self.load()

    def test_declared_window_total_must_reconcile(self):
        self.alter(lambda p: p.update(window_total=20))
        with self.assertRaises(adapter.InventoryError):
            self.load()

    def test_missing_entire_year_cannot_match_declared_window(self):
        self.alter(lambda p: p.update(window=['2024-09-26', '2025-01-03']))
        with self.assertRaises(adapter.InventoryError):
            self.load()

    def test_receipt_path_cannot_escape_packet(self):
        self.alter(lambda p: p['receipts'][0].update(path='../2025-page001.html'))
        with self.assertRaises(adapter.InventoryError):
            self.load()

    def test_wrong_congress_session_page_or_extra_filters_are_rejected(self):
        for query in ['CongressNum=118&Session=1st&Page=1', 'CongressNum=119&Session=2nd&Page=1',
                      'CongressNum=119&Session=1st&Page=2', 'CongressNum=119&Session=1st&Page=1&VoteType=Yea']:
            with self.subTest(query=query):
                self.path, self.sha = packet_at(self.root)
                self.alter(lambda p: p['receipts'][0].update(url='https://clerk.house.gov/Votes/MemberVotes?' + query))
                with self.assertRaises(adapter.InventoryError):
                    self.load()

    def test_missing_valid_continuation_is_not_repaired_from_malformed_link(self):
        packet = json.loads(self.path.read_text())
        name = self.root / '2025-page001.html'
        body = name.read_bytes().replace(b'Session=1st">2</a>', b'Session=2nd">2</a>')
        name.write_bytes(body)
        packet['receipts'][0]['sha256'] = digest(body)
        self.path, self.sha = save_packet(self.root, packet)
        with self.assertRaises(adapter.InventoryError):
            self.load()

    def test_malformed_detail_paths_are_not_rewritten_into_official_identities(self):
        for href in ['/Votes/20251-junk?Page=2', '/Votes/2025001?Page=2', '/Votes/20251#other',
                     '/Votes/20251?Member=wrong']:
            with self.subTest(href=href):
                self.path, self.sha = packet_at(self.root)
                packet = json.loads(self.path.read_text())
                name = self.root / '2025-page001.html'
                body = name.read_bytes().replace(b'/Votes/20251?Page=2', href.encode())
                name.write_bytes(body)
                packet['receipts'][0]['sha256'] = digest(body)
                self.path, self.sha = save_packet(self.root, packet)
                with self.assertRaises(adapter.InventoryError):
                    self.load()

    def test_official_penultimate_and_final_pages_are_parsed(self):
        manifest = json.loads((FIXTURES / 'manifest.json').read_text())
        for name, count, rolls in [('2025-page036.html', 10, [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]),
                                   ('2025-page037.html', 2, [2, 1])]:
            receipt = next(r for r in manifest['samples'] if r['path'] == name)
            rows = adapter.parse_listing((FIXTURES / name).read_bytes(), receipt, 2025)
            self.assertEqual(len(rows), count)
            self.assertEqual([r['roll'] for r in rows], rolls)

    def test_official_speaker_blank_statuses_remain_in_inventory(self):
        manifest = json.loads((FIXTURES / 'manifest.json').read_text())
        receipt = next(r for r in manifest['samples'] if r['path'] == '2023-page072.html')
        rows = adapter.parse_listing((FIXTURES / receipt['path']).read_bytes(), receipt, 2023)
        self.assertEqual(len(rows), 10)
        self.assertEqual(sum(r['status'] is None for r in rows), 8)
        self.assertEqual([r['roll'] for r in rows], [14, 13, 12, 11, 10, 9, 8, 7, 6, 5])


class AcquisitionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        path, sha = packet_at(self.source, count=1)
        self.inv = adapter.validate_inventory(path, sha)
        self.out = self.root / 'run'

    def response(self, body=REAL_XML, status=200, final_url=None):
        return adapter.Response(status=status, body=body, final_url=final_url or 'https://clerk.house.gov/evs/2025/roll001.xml',
                                content_type='text/xml')

    def run_one(self, response=None, **kwargs):
        return adapter.acquire(self.inv, self.out, fetch=lambda url: response or self.response(), **kwargs)

    def test_official_xml_is_identity_checked_and_saved_with_hash(self):
        report = self.run_one()
        self.assertEqual(report['status'], 'acquisition_complete')
        self.assertEqual(report['counts'], {'acquired': 1})
        row = report['records'][0]
        self.assertEqual(row['key'], '119-2025/h1')
        self.assertEqual(row['outcome'], 'acquired')
        self.assertEqual(row['metadata']['legis_num'], 'QUORUM')
        self.assertEqual(row['response']['sha256'], '876aa39e6cfe58942eb5a3b24628975b288e6c5fca8d8e0257dfcd7d180163fd')
        self.assertEqual((self.out / row['response']['path']).read_bytes(), REAL_XML)
        self.assertEqual(json.loads((self.out / 'manifest.json').read_text()), report)
        self.assertFalse(report['normalized_votes_validated'])

    def test_missing_and_unpublished_details_are_incomplete_with_raw_receipts(self):
        for status, body in [(404, b'not found'), (200, b'<html>roll-call-vote-not-available.htm</html>')]:
            with self.subTest(status=status):
                self.out = self.root / f'run-{status}'
                report = self.run_one(self.response(body, status))
                self.assertEqual(report['status'], 'incomplete')
                row = report['records'][0]
                self.assertEqual(row['outcome'], 'incomplete_fetch')
                self.assertEqual((self.out / row['response']['path']).read_bytes(), body)

    def test_http_errors_are_explicit_source_failures_not_empty_success(self):
        for status in [301, 403, 429, 500]:
            with self.subTest(status=status):
                self.out = self.root / f'run-{status}'
                report = self.run_one(self.response(b'error', status))
                self.assertEqual(report['status'], 'incomplete')
                self.assertEqual(report['records'][0]['outcome'], 'source_failure')
                self.assertEqual(report['records'][0]['response']['http_status'], status)

    def test_timeout_has_a_failure_record_without_invented_body_hash(self):
        def timeout(url):
            raise TimeoutError('synthetic timeout')
        report = adapter.acquire(self.inv, self.out, fetch=timeout)
        self.assertEqual(report['status'], 'incomplete')
        row = report['records'][0]
        self.assertEqual(row['outcome'], 'source_failure')
        self.assertIsNone(row['response'])
        self.assertIn('timeout', row['reason'])

    def test_login_html_malformed_xml_and_empty_xml_never_pass(self):
        for n, body in enumerate([b'<html>login</html>', b'<rollcall-vote>', b'<rollcall-vote/>', b'']):
            with self.subTest(body=body):
                self.out = self.root / f'bad-{n}'
                report = self.run_one(self.response(body))
                self.assertEqual(report['records'][0]['outcome'], 'malformed_source')
                self.assertEqual(report['status'], 'incomplete')

    def test_wrong_roll_session_congress_chamber_or_date_are_rejected(self):
        mutations = [(b'<rollcall-num>1</rollcall-num>', b'<rollcall-num>2</rollcall-num>'),
                     (b'<session>1st</session>', b'<session>2nd</session>'),
                     (b'<congress>119</congress>', b'<congress>118</congress>'),
                     (b'U.S. House of Representatives', b'U.S. Senate'),
                     (b'3-Jan-2025', b'4-Jan-2025'),
                     (b'<congress>119</congress>', b'<congress>119</congress><congress>118</congress>')]
        for n, (before, after) in enumerate(mutations):
            with self.subTest(n=n):
                self.out = self.root / f'mismatch-{n}'
                report = self.run_one(self.response(REAL_XML.replace(before, after)))
                self.assertEqual(report['records'][0]['outcome'], 'malformed_source')

    def test_missing_voter_payload_and_internal_entities_are_rejected(self):
        for n, body in enumerate([REAL_XML.split(b'<vote-data>')[0] + b'</rollcall-vote>',
                                 b'<!DOCTYPE rollcall-vote [<!ENTITY e "x">]><rollcall-vote/>']):
            self.out = self.root / f'unsafe-{n}'
            report = self.run_one(self.response(body))
            self.assertEqual(report['records'][0]['outcome'], 'malformed_source')

    def test_unknown_xml_encoding_preserves_receipt_and_remaining_roll_accounting(self):
        path, sha = packet_at(self.source, count=21)
        inv = adapter.validate_inventory(path, sha)
        body = REAL_XML.replace(b'encoding="UTF-8"', b'encoding="NOT-A-REAL-ENCODING"')
        report = adapter.acquire(inv, self.out, fetch=lambda url: self.response(body), max_rolls=1)
        self.assertEqual(report['status'], 'incomplete')
        self.assertEqual(report['counts'], {'malformed_source': 1, 'incomplete_fetch': 20})
        row = report['records'][0]
        self.assertEqual(row['response']['sha256'], digest(body))
        persisted = json.loads((self.out / 'manifest.json').read_text())
        self.assertEqual(persisted['records'][0]['response'], row['response'])
        self.assertEqual((self.out / row['response']['path']).read_bytes(), body)

    def test_vacated_marker_is_preserved_and_cannot_grant_completion(self):
        body = b'<html>This vote was vacated</html>'
        report = self.run_one(self.response(body))
        self.assertEqual(report['status'], 'incomplete')
        row = report['records'][0]
        self.assertEqual(row['outcome'], 'unsupported_record')
        self.assertIn('vacated', row['reason'])
        self.assertEqual((self.out / row['response']['path']).read_bytes(), body)

    def test_redirect_to_login_or_other_roll_is_refused(self):
        report = self.run_one(self.response(final_url='https://example.com/login'))
        self.assertEqual(report['records'][0]['outcome'], 'source_failure')
        self.assertEqual(report['status'], 'incomplete')

    def test_truncated_xml_never_passes_even_if_captured_prefix_is_valid_xml(self):
        response = adapter.Response(200, REAL_XML, 'https://clerk.house.gov/evs/2025/roll001.xml',
                                    'text/xml', body_complete=False, read_error='truncated HTTP body')
        report = self.run_one(response)
        row = report['records'][0]
        self.assertEqual(row['outcome'], 'incomplete_fetch')
        self.assertEqual(report['status'], 'incomplete')
        self.assertFalse(row['response']['body_complete'])
        self.assertEqual((self.out / row['response']['path']).read_bytes(), REAL_XML)

    def test_safety_cap_accounts_for_every_unattempted_roll(self):
        path, sha = packet_at(self.source, count=21)
        inv = adapter.validate_inventory(path, sha)
        report = adapter.acquire(inv, self.out, fetch=lambda url: self.response(), max_rolls=1)
        self.assertEqual(len(report['records']), 21)
        self.assertEqual(report['counts'], {'acquired': 1, 'incomplete_fetch': 20})
        self.assertEqual(report['status'], 'incomplete')
        self.assertTrue(all(r['response'] is None for r in report['records'][1:]))

    def test_outside_window_exclusions_are_preserved_without_fetching(self):
        path, sha = packet_at(self.source, count=1, window=('2025-01-04', '2025-01-05'))
        inv = adapter.validate_inventory(path, sha)
        def never(url):
            self.fail('outside-window record must not trigger HTTP')
        report = adapter.acquire(inv, self.out, fetch=never)
        self.assertEqual(report['status'], 'acquisition_complete')
        self.assertEqual(report['counts'], {'excluded_outside_window': 1})
        self.assertFalse(report['member_coverage_validated'])

    def test_reusing_output_cannot_overwrite_previous_attempt(self):
        report = self.run_one()
        with self.assertRaises(FileExistsError):
            self.run_one(self.response(b'changed'))
        self.assertEqual(json.loads((self.out / 'manifest.json').read_text()), report)

    def test_output_symlink_is_refused_before_any_fetch(self):
        link = self.root / 'linked'
        link.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(ValueError):
            adapter.acquire(self.inv, link / 'run', fetch=lambda url: self.fail('must not fetch'))

    def test_interruption_retains_running_manifest_and_pending_records(self):
        def interrupt(url):
            raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            adapter.acquire(self.inv, self.out, fetch=interrupt)
        report = json.loads((self.out / 'manifest.json').read_text())
        self.assertEqual(report['status'], 'running')
        self.assertEqual(report['records'][0]['outcome'], 'pending')


class SpeakerXmlTests(unittest.TestCase):
    def test_frozen_speaker_missing_bill_identity_and_synthetic_invalid_fields(self):
        body = (FIXTURES.parent / 'official-samples/house-speaker-2025-roll002.xml').read_bytes()
        row = dict(key='119-2025/h2', congress=119, session=1, roll=2, date='2025-01-03')
        self.assertEqual(adapter.validate_xml(body, row)['legis_num'], '')
        # SYNTHETIC mutations: optional absence must not allow duplicate/structured identity.
        for fields in [b'<legis-num>S. 5</legis-num><legis-num>H.R. 29</legis-num>',
                       b'<legis-num><bill>S. 5</bill></legis-num>']:
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                adapter.validate_xml(body.replace(b'</vote-metadata>', fields + b'</vote-metadata>'), row)


class CliTests(unittest.TestCase):
    def test_check_inventory_is_network_free_and_does_not_create_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            path, sha = packet_at(Path(tmp), count=1)
            result = subprocess.run([sys.executable, str(Path(adapter.__file__)), '--inventory', str(path),
                                     '--inventory-sha256', sha, '--check-inventory'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report['selected_rolls'], 1)
            self.assertFalse(report['xml_acquisition_complete'])

    def test_output_dotdot_escape_is_refused_without_network_or_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path, sha = packet_at(Path(tmp), count=1)
            root = Path(adapter.__file__).resolve().parents[2]
            escaped = root / 'artifacts/official-house-acquisition/../outside-acquisition-run'
            with patch.object(adapter, 'fetch_xml', side_effect=AssertionError('must not fetch')):
                with self.assertRaises(SystemExit) as exc:
                    adapter.main(['--inventory', str(path), '--inventory-sha256', sha, '--execute',
                                  '--output', str(escaped)])
            self.assertEqual(exc.exception.code, 2)
            self.assertFalse(escaped.resolve().exists())


class SubtractMonthsRegressionTests(unittest.TestCase):
    """Regression tests for §6 amended: subtract_months December edge cases and exhaustive agreement."""

    def test_subtract_months_december_cases(self):
        """§6 amended: December source/target dates must work correctly."""
        cases = [
            ('2020-12-06', 12, '2019-12-06'),
            ('2026-12-31', 48, '2022-12-31'),
            ('2026-01-15', 1, '2025-12-15'),
            ('2026-12-15', 0, '2026-12-15'),
            ('2026-03-31', 13, '2025-02-28'),
            ('2024-12-31', 10, '2024-02-29'),
        ]
        for date_str, months, expected in cases:
            with self.subTest(date=date_str, months=months):
                self.assertEqual(adapter.subtract_months(date_str, months), expected)

    def test_subtract_months_negative_months_raises_error(self):
        """§6 amended: negative months must raise InventoryError."""
        with self.assertRaises(adapter.InventoryError):
            adapter.subtract_months('2026-01-01', -1)

    def test_subtract_months_non_integer_months_raises_error(self):
        """§6 amended: non-integer months (float, bool) must raise InventoryError."""
        for invalid_months in [1.5, True, False, '12']:
            with self.subTest(months=invalid_months):
                with self.assertRaises(adapter.InventoryError):
                    adapter.subtract_months('2026-01-01', invalid_months)

    def test_subtract_months_exhaustive_agreement(self):
        """§6 amended: subtract_months must agree with independent reference for all test dates."""
        import calendar
        from datetime import date, timedelta

        def reference_subtract_months(iso_date_str, months_to_subtract):
            """Independent reference implementation using year*12+month arithmetic."""
            y, m, d = map(int, iso_date_str.split('-'))
            # Convert to month index
            month_idx = y * 12 + m
            # Subtract
            month_idx -= months_to_subtract
            # Convert back
            result_year = month_idx // 12
            result_month = month_idx % 12
            if result_month == 0:
                result_year -= 1
                result_month = 12
            # Clamp day to last day of target month
            _, last_day = calendar.monthrange(result_year, result_month)
            result_day = min(d, last_day)
            return f'{result_year:04d}-{result_month:02d}-{result_day:02d}'

        start = date(2020, 1, 1)
        end = date(2030, 12, 31)
        test_months = [1, 12, 13, 48]

        current = start
        while current <= end:
            iso_str = current.isoformat()
            for m in test_months:
                expected = reference_subtract_months(iso_str, m)
                actual = adapter.subtract_months(iso_str, m)
                self.assertEqual(actual, expected,
                    f"Mismatch at {iso_str} minus {m} months: got {actual}, expected {expected}")
            # Step by ~30 days for speed
            current = current + timedelta(days=30)


class WindowPolicyRegressionTests(unittest.TestCase):
    """Regression tests for §6 window_policy with December edge cases."""

    def test_window_policy_december_48_month(self):
        """§6: window_policy(['2022-12-31', '2026-12-31']) should have months=48."""
        wp = adapter.window_policy(['2022-12-31', '2026-12-31'])
        self.assertEqual(wp['as_of'], '2026-12-31')
        self.assertEqual(wp['months'], 48)

    def test_window_policy_january_start_no_match(self):
        """§6: window_policy(['2023-01-01','2026-12-31'])['months'] should be None (not 48)."""
        wp = adapter.window_policy(['2023-01-01', '2026-12-31'])
        self.assertIsNone(wp['months'])


class InventoryIdentityCheckRegressionTests(unittest.TestCase):
    """Regression tests for §6 amended: congress/session identity check in listings."""

    def test_congress_session_mismatch_in_receipt_url_raises_error(self):
        """§6 amended: listing URL congress/session must match the enumerated year."""
        # The existing test_wrong_congress_session_page_or_extra_filters_are_rejected already covers this
        # Create a synthetic packet with mismatched congress in the receipt URL
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # Create a 2025 listing (congress 119, session 1st)
            # but put wrong congress in the receipt URL
            path, sha = packet_at(root, count=1)
            packet = json.loads(path.read_text())
            # Change receipt URL to say CongressNum=118 (wrong for 2025)
            packet['receipts'][0]['url'] = 'https://clerk.house.gov/Votes/MemberVotes?CongressNum=118&Session=1st&Page=1'
            # Update the packet hash
            new_path = root / 'inventory2.json'
            new_path.write_text(json.dumps(packet))
            new_sha = adapter.sha256(new_path.read_bytes())
            # Should raise InventoryError due to congress/session mismatch
            with self.assertRaises(adapter.InventoryError) as exc:
                adapter.validate_inventory(new_path, new_sha)
            # Check that error message mentions congress or session
            error_msg = str(exc.exception).lower()
            self.assertTrue('congress' in error_msg or 'session' in error_msg,
                          f"Error message should mention congress/session, got: {exc.exception}")


class TransportTests(unittest.TestCase):
    def test_http_404_retains_error_response_body(self):
        url = 'https://clerk.house.gov/evs/2025/roll001.xml'
        error = HTTPError(url, 404, 'Not found', {'Content-Type': 'text/html'}, BytesIO(b'missing'))
        with patch.object(adapter, 'build_opener') as factory:
            factory.return_value.open.side_effect = error
            response = adapter.fetch_xml(url)
        self.assertEqual(response.status, 404)
        self.assertEqual(response.body, b'missing')
        self.assertTrue(response.body_complete)

    def test_incomplete_read_retains_partial_bytes_and_failure(self):
        url = 'https://clerk.house.gov/evs/2025/roll001.xml'
        class PartialResponse(BytesIO):
            status = 200
            headers = {'Content-Type': 'text/xml'}
            def geturl(self):
                return url
            def read(self, size):
                raise IncompleteRead(b'<rollcall-vote>', 999)
        with patch.object(adapter, 'build_opener') as factory:
            factory.return_value.open.return_value = PartialResponse()
            response = adapter.fetch_xml(url)
        self.assertEqual(response.body, b'<rollcall-vote>')
        self.assertFalse(response.body_complete)
        self.assertIn('IncompleteRead', response.read_error)

    def test_byte_cap_is_explicit_and_does_not_claim_full_body(self):
        url = 'https://clerk.house.gov/evs/2025/roll001.xml'
        class LargeResponse(BytesIO):
            status = 200
            headers = {'Content-Type': 'text/xml'}
            def geturl(self):
                return url
        with patch.object(adapter, 'build_opener') as factory:
            factory.return_value.open.return_value = LargeResponse(b'x' * (adapter.MAX_RESPONSE_BYTES + 10))
            response = adapter.fetch_xml(url)
        self.assertEqual(len(response.body), adapter.MAX_RESPONSE_BYTES + 1)
        self.assertFalse(response.body_complete)

    def test_premature_eof_without_exception_cannot_satisfy_content_length(self):
        url = 'https://clerk.house.gov/evs/2025/roll001.xml'
        class ShortResponse(BytesIO):
            status = 200
            headers = {'Content-Type': 'text/xml', 'Content-Length': str(len(REAL_XML) + 100)}
            def geturl(self):
                return url
        with patch.object(adapter, 'build_opener') as factory:
            factory.return_value.open.return_value = ShortResponse(REAL_XML)
            response = adapter.fetch_xml(url)
        self.assertEqual(response.body, REAL_XML)
        self.assertFalse(response.body_complete)
        self.assertIn('Content-Length', response.read_error)


class ContractAlignmentTests(unittest.TestCase):
    """Tests for CONTRACT-SPEC.md compliance (test-first, red against current adapter)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        path, sha = packet_at(self.source, count=1)
        self.inv = adapter.validate_inventory(path, sha)
        self.out = self.root / 'run'

    def response(self, body=REAL_XML, status=200, final_url=None):
        return adapter.Response(status=status, body=body, final_url=final_url or 'https://clerk.house.gov/evs/2025/roll001.xml',
                                content_type='text/xml')

    def run_one(self, response=None, **kwargs):
        return adapter.acquire(self.inv, self.out, fetch=lambda url: response or self.response(), **kwargs)

    def test_contract_top_level_fields_present(self):
        """§6: contract, contract_version, chamber, no 'version' key."""
        report = self.run_one()
        self.assertIn('contract', report)
        self.assertEqual(report['contract'], 'civiclens.official-vote-acquisition')
        self.assertIn('contract_version', report)
        self.assertEqual(report['contract_version'], 1)
        self.assertIn('chamber', report)
        self.assertEqual(report['chamber'], 'house')
        self.assertNotIn('version', report, "legacy 'version' key must be removed per spec")

    def test_acquisition_semantics_and_validation_flags(self):
        """§6: acquisition_semantics, three validation flags all false."""
        report = self.run_one()
        self.assertIn('acquisition_semantics', report)
        self.assertEqual(report['acquisition_semantics'], 'downloaded_and_identity_checked_only')
        self.assertIn('normalized_votes_validated', report)
        self.assertFalse(report['normalized_votes_validated'])
        self.assertIn('member_coverage_validated', report)
        self.assertFalse(report['member_coverage_validated'])
        self.assertIn('bill_resolution_validated', report)
        self.assertFalse(report['bill_resolution_validated'])
        self.assertIn('collector_revision', report)
        self.assertIsNone(report['collector_revision'])

    def test_window_policy_field_exists_and_matches_spec(self):
        """§6: window_policy = { as_of, months } per window arithmetic."""
        report = self.run_one()
        self.assertIn('window_policy', report)
        wp = report['window_policy']
        self.assertIn('as_of', wp)
        self.assertEqual(wp['as_of'], report['window'][1])
        self.assertIn('months', wp)
        # 1-day window should have months=None (not a true N-month window)
        self.assertIsNone(wp['months'])

    def test_safety_cap_and_attempt_fields_present(self):
        """§6: safety_cap_applied, attempted_rolls, max_rolls present."""
        report = self.run_one(max_rolls=0)
        self.assertIn('safety_cap_applied', report)
        self.assertIn('attempted_rolls', report)
        self.assertIn('max_rolls', report)

    def test_record_has_required_fields(self):
        """§6: records have key, chamber, congress, session, year, attempted, attempted_at, metadata."""
        report = self.run_one()
        row = report['records'][0]
        # Identity
        self.assertIn('key', row)
        self.assertEqual(row['key'], '119-2025/h1')
        self.assertIn('chamber', row)
        self.assertEqual(row['chamber'], 'house')
        self.assertIn('congress', row)
        self.assertEqual(row['congress'], 119)
        self.assertIn('session', row)
        self.assertEqual(row['session'], 1)
        self.assertIn('year', row)
        self.assertEqual(row['year'], 2025)
        # Attempt tracking
        self.assertIn('attempted', row)
        self.assertTrue(row['attempted'])
        self.assertIn('attempted_at', row)
        self.assertIsNotNone(row['attempted_at'])
        # Source identity
        self.assertIn('source_url', row)
        self.assertEqual(row['source_url'], 'https://clerk.house.gov/evs/2025/roll001.xml')

    def test_acquired_metadata_structure(self):
        """§6: acquired roll has vote_desc, amendment_num, amendment_author, position_tokens."""
        report = self.run_one()
        row = report['records'][0]
        self.assertEqual(row['outcome'], 'acquired')
        meta = row['metadata']
        self.assertIsNotNone(meta)
        # Required metadata fields per §6
        self.assertIn('key', meta)
        self.assertIn('chamber', meta)
        self.assertIn('congress', meta)
        self.assertIn('session', meta)
        self.assertIn('roll', meta)
        self.assertIn('date', meta)
        self.assertIn('legis_num', meta)
        self.assertIn('question', meta)
        self.assertIn('vote_type', meta)
        self.assertIn('result', meta)
        self.assertIn('vote_desc', meta)
        self.assertIn('amendment_num', meta)
        self.assertIn('amendment_author', meta)
        self.assertIn('recorded_vote_count', meta)
        self.assertIn('position_tokens', meta)

    def test_real_xml_position_tokens_counted(self):
        """§6: position_tokens counts raw vote text verbatim."""
        report = self.run_one()
        meta = report['records'][0]['metadata']
        # REAL_XML has 433 Present and 2 Not Voting (verified from XML above)
        self.assertEqual(meta['position_tokens'], {'Present': 433, 'Not Voting': 2})
        self.assertEqual(meta['recorded_vote_count'], 435)

    def test_real_xml_vote_desc_empty_string(self):
        """§6: vote_desc is '' in REAL_XML (QUORUM roll)."""
        report = self.run_one()
        meta = report['records'][0]['metadata']
        self.assertEqual(meta['vote_desc'], '')

    def test_real_xml_amendment_fields_null_when_absent(self):
        """§6: amendment_num and amendment_author null when not in XML."""
        report = self.run_one()
        meta = report['records'][0]['metadata']
        self.assertIsNone(meta['amendment_num'])
        self.assertIsNone(meta['amendment_author'])

    def test_subtract_months_helper_exists_and_works(self):
        """§2: adapter.subtract_months(date, months) calendar arithmetic."""
        # Spec examples
        self.assertEqual(adapter.subtract_months('2026-09-26', 48), '2022-09-26')
        self.assertEqual(adapter.subtract_months('2024-02-29', 12), '2023-02-28')
        self.assertEqual(adapter.subtract_months('2028-02-29', 48), '2024-02-29')
        self.assertEqual(adapter.subtract_months('2026-03-31', 1), '2026-02-28')
        self.assertEqual(adapter.subtract_months('2024-03-31', 1), '2024-02-29')

    def test_window_policy_helper_exists(self):
        """§2: adapter.window_policy(window) -> {as_of, months}."""
        # True 48-month window
        wp = adapter.window_policy(('2022-09-26', '2026-09-26'))
        self.assertEqual(wp['as_of'], '2026-09-26')
        self.assertEqual(wp['months'], 48)
        # Non-matching window (single day)
        wp = adapter.window_policy(('2025-01-03', '2025-01-03'))
        self.assertEqual(wp['as_of'], '2025-01-03')
        self.assertIsNone(wp['months'])

    def test_out_of_window_exclusions_untried(self):
        """§6: out-of-window records have attempted=False, response/metadata=None."""
        path, sha = packet_at(self.source, count=1, window=('2025-01-04', '2025-01-05'))
        inv = adapter.validate_inventory(path, sha)
        report = adapter.acquire(inv, self.out, fetch=lambda url: self.fail('must not attempt'))
        row = report['records'][0]
        self.assertEqual(row['outcome'], 'excluded_outside_window')
        self.assertFalse(row['attempted'])
        self.assertIsNone(row['response'])
        self.assertIsNone(row['metadata'])
        self.assertFalse(row['in_window'])

    def test_safety_cap_zero_prevents_attempt(self):
        """§6: max_rolls=0 sets outcome incomplete_fetch, reason starts 'safety cap'."""
        report = self.run_one(max_rolls=0)
        row = report['records'][0]
        self.assertEqual(row['outcome'], 'incomplete_fetch')
        self.assertFalse(row['attempted'])
        self.assertIsNone(row['response'])
        self.assertIsNone(row['metadata'])
        self.assertTrue(report['safety_cap_applied'])
        self.assertIn('safety cap', row['reason'])

    def test_safety_cap_applied_false_when_none(self):
        """§6: safety_cap_applied=False when max_rolls is None."""
        report = self.run_one(max_rolls=None)
        self.assertFalse(report['safety_cap_applied'])

    def test_counts_field_matches_outcome_recount(self):
        """§6: counts equals Counter of outcomes in records."""
        path, sha = packet_at(self.source, count=21)
        inv = adapter.validate_inventory(path, sha)
        report = adapter.acquire(inv, self.out, fetch=lambda url: self.response(), max_rolls=5)
        # Manually count outcomes
        from collections import Counter
        outcomes = Counter(r['outcome'] for r in report['records'])
        self.assertEqual(report['counts'], dict(outcomes))

    def test_manifest_json_on_disk_has_same_counts(self):
        """§6: manifest.json counts field matches records."""
        report = self.run_one()
        persisted = json.loads((self.out / 'manifest.json').read_bytes())
        self.assertEqual(persisted['counts'], report['counts'])

    def test_cli_check_inventory_includes_window_policy(self):
        """§6: --check-inventory JSON includes window_policy."""
        with tempfile.TemporaryDirectory() as tmp:
            path, sha = packet_at(Path(tmp), count=1)
            result = subprocess.run([sys.executable, str(Path(adapter.__file__)), '--inventory', str(path),
                                     '--inventory-sha256', sha, '--check-inventory'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertIn('window_policy', report)
            self.assertIn('as_of', report['window_policy'])
            self.assertIn('months', report['window_policy'])

    def test_synthetic_malformed_missing_vote_element(self):
        """§6: recorded-vote without vote child → malformed_source."""
        broken_xml = bytearray(REAL_XML)
        # Find first <vote>Present</vote> and remove it
        idx = broken_xml.find(b'<vote>Present</vote>')
        if idx >= 0:
            broken_xml = broken_xml[:idx] + broken_xml[idx + len(b'<vote>Present</vote>'):]
        report = adapter.acquire(self.inv, self.out, fetch=lambda url: self.response(bytes(broken_xml)))
        self.assertEqual(report['records'][0]['outcome'], 'malformed_source')

    def test_synthetic_amendment_num_single_element_acquired(self):
        """§6: single <amendment-num> inserted → acquired with amendment_num set."""
        # Insert amendment element into metadata
        modified = REAL_XML.replace(b'<vote-desc></vote-desc>',
                                   b'<vote-desc></vote-desc><amendment-num>H AMDT 1</amendment-num>')
        report = adapter.acquire(self.inv, self.out, fetch=lambda url: self.response(modified))
        row = report['records'][0]
        self.assertEqual(row['outcome'], 'acquired')
        self.assertEqual(row['metadata']['amendment_num'], 'H AMDT 1')

    def test_synthetic_amendment_num_duplicated_malformed(self):
        """§6: duplicated <amendment-num> elements → malformed_source."""
        # Insert two amendment elements into metadata
        modified = REAL_XML.replace(b'<vote-desc></vote-desc>',
                                   b'<vote-desc></vote-desc><amendment-num>H AMDT 1</amendment-num><amendment-num>H AMDT 2</amendment-num>')
        report = adapter.acquire(self.inv, self.out, fetch=lambda url: self.response(modified))
        row = report['records'][0]
        self.assertEqual(row['outcome'], 'malformed_source')

    def test_synthetic_position_tokens_preserves_candidate_names(self):
        """§6: candidate names (non-standard positions) preserved verbatim in position_tokens."""
        # Replace 3 'Present' votes with 'Jeffries' (a candidate name)
        modified = REAL_XML.replace(b'<vote>Present</vote>', b'<vote>Jeffries</vote>', 3)
        report = adapter.acquire(self.inv, self.out, fetch=lambda url: self.response(modified))
        meta = report['records'][0]['metadata']
        # Should have Jeffries: 3, Present: 430, Not Voting: 2
        self.assertEqual(meta['position_tokens']['Jeffries'], 3)
        self.assertEqual(meta['position_tokens']['Present'], 430)
        self.assertEqual(meta['position_tokens']['Not Voting'], 2)

    def test_in_window_bool_consistent_with_window(self):
        """§6: in_window is true iff date in [window[0], window[1]]."""
        path, sha = packet_at(self.source, count=1, window=('2025-01-02', '2025-01-04'))
        inv = adapter.validate_inventory(path, sha)
        report = adapter.acquire(inv, self.out, fetch=lambda url: self.response())
        row = report['records'][0]
        self.assertTrue(row['in_window'])
        self.assertEqual(row['date'], '2025-01-03')

    def test_status_acquisition_complete_iff_all_in_window_acquired(self):
        """§6: status='acquisition_complete' iff every in-window is acquired and every out-of-window excluded."""
        report = self.run_one()
        self.assertEqual(report['status'], 'acquisition_complete')
        # All single-roll all-in-window case: every record acquired
        self.assertTrue(all(r['outcome'] == 'acquired' for r in report['records']))

    def test_status_incomplete_when_safety_cap_applied(self):
        """§6: status='incomplete' when safety_cap_applied is true."""
        report = self.run_one(max_rolls=0)
        self.assertEqual(report['status'], 'incomplete')
        self.assertTrue(report['safety_cap_applied'])

    def test_attempted_at_none_when_unattempted(self):
        """§6: attempted_at is None when attempted=False."""
        path, sha = packet_at(self.source, count=1, window=('2025-01-04', '2025-01-05'))
        inv = adapter.validate_inventory(path, sha)
        report = adapter.acquire(inv, self.out, fetch=lambda url: self.fail('must not attempt'))
        row = report['records'][0]
        self.assertFalse(row['attempted'])
        self.assertIsNone(row['attempted_at'])

    def test_make_interop_manifest_scenarios(self):
        """§8: helper generates manifests for complete/capped/http500/vacated scenarios."""
        script_path = Path(adapter.__file__).parent / 'make_interop_manifest.py'
        scenarios = {
            'complete': ('acquisition_complete', 'acquired'),
            'capped': ('incomplete', 'incomplete_fetch'),
            'http500': ('incomplete', 'source_failure'),
            'vacated': ('incomplete', 'unsupported_record'),
        }
        for scenario, (expected_status, expected_outcome) in scenarios.items():
            with self.subTest(scenario=scenario):
                with tempfile.TemporaryDirectory() as tmpdir:
                    result = subprocess.run(
                        [sys.executable, str(script_path), tmpdir, scenario],
                        capture_output=True, text=True
                    )
                    self.assertEqual(result.returncode, 0, f"{scenario}: {result.stderr}")
                    output = json.loads(result.stdout)
                    self.assertIn('run_dir', output)
                    manifest_path = Path(output['run_dir']) / 'manifest.json'
                    manifest = json.loads(manifest_path.read_text())
                    self.assertEqual(manifest['status'], expected_status)
                    # Single in-window record
                    in_window_records = [r for r in manifest['records'] if r['in_window']]
                    self.assertEqual(len(in_window_records), 1)
                    self.assertEqual(in_window_records[0]['outcome'], expected_outcome)

    def test_make_interop_manifest_unknown_scenario_exits_2(self):
        """§8: unknown scenario → exit code 2."""
        script_path = Path(adapter.__file__).parent / 'make_interop_manifest.py'
        with tempfile.TemporaryDirectory() as tmpdir:
            result = subprocess.run(
                [sys.executable, str(script_path), tmpdir, 'unknown_scenario'],
                capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 2)


def mixed_packet_at(root, in_window=2, out_of_window=1):
    """SYNTHETIC single-page listing: in-window rolls, then rolls stamped Jan 4, 2025.

    Only the stamp inside each out-of-window roll's own block is rewritten, so the
    saved page keeps its official-shaped counters, links and receipt hash.
    """
    count = in_window + out_of_window
    if count > 10:
        raise ValueError('mixed_packet_at supports one listing page only')
    path, _ = packet_at(root, count=count, window=('2025-01-03', '2025-01-03'))
    packet = json.loads(path.read_text())
    receipt = packet['receipts'][0]
    page_path = root / receipt['path']
    parts = page_path.read_bytes().decode().split('<div class="role-call-vote">')
    for roll in range(in_window + 1, count + 1):
        hits = [i for i, part in enumerate(parts) if i and f'/Votes/2025{roll}?Page=' in part]
        if len(hits) != 1 or parts[hits[0]].count('Jan 3, 2025, 12:33 PM') != 1:
            raise ValueError(f'unexpected listing block for roll {roll}')
        parts[hits[0]] = parts[hits[0]].replace('Jan 3, 2025, 12:33 PM', 'Jan 4, 2025, 12:33 PM')
    body = '<div class="role-call-vote">'.join(parts).encode()
    page_path.write_bytes(body)
    receipt['sha256'] = digest(body)
    for row in packet['inventory']:
        if row['roll'] > in_window:
            row['date'] = '2025-01-04'
    packet['summary'][0]['window_total'] = in_window
    packet['window_total'] = in_window
    return save_packet(root, packet)


class MixedWindowInterruptionRegressionTests(unittest.TestCase):
    """SYNTHETIC mixed-window packets. Out-of-window rows must be classified before any fetch."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.out = self.root / 'run'

    def response(self, body=REAL_XML):
        return adapter.Response(status=200, body=body, final_url='https://clerk.house.gov/evs/2025/roll001.xml',
                                content_type='text/xml')

    def interrupt(self, url):
        raise KeyboardInterrupt()

    def mixed_inventory(self, in_window=2, out_of_window=1):
        path, sha = mixed_packet_at(self.source, in_window=in_window, out_of_window=out_of_window)
        return adapter.validate_inventory(path, sha)

    def assert_pre_fetch_snapshot(self, report):
        self.assertEqual(report['status'], 'running')
        self.assertIsNone(report['finished_at'])
        self.assertEqual(report['attempted_rolls'], 0)
        self.assertEqual(report['counts'], {'pending': 2, 'excluded_outside_window': 1})
        excluded = report['records'][2]
        self.assertEqual(excluded['outcome'], 'excluded_outside_window')
        self.assertIsInstance(excluded['reason'], str)
        self.assertTrue(excluded['reason'])
        self.assertFalse(excluded['in_window'])
        self.assertFalse(excluded['attempted'])
        self.assertIsNone(excluded['attempted_at'])
        self.assertIsNone(excluded['response'])
        self.assertIsNone(excluded['metadata'])
        for row in report['records'][:2]:
            self.assertEqual(row['outcome'], 'pending')
            self.assertTrue(row['in_window'])
            self.assertFalse(row['attempted'])
        from collections import Counter
        self.assertEqual(report['counts'], dict(Counter(r['outcome'] for r in report['records'])))

    def test_mixed_packet_passes_inventory_and_selects_only_in_window_rows(self):
        inv = self.mixed_inventory(in_window=2, out_of_window=1)
        self.assertEqual(len(inv.records), 3)
        self.assertEqual(len(inv.selected), 2)
        self.assertEqual([r['roll'] for r in inv.selected], [1, 2])

    def test_first_snapshot_classifies_outside_window_row_before_any_fetch(self):
        inv = self.mixed_inventory()
        snapshots = []
        original = adapter.write_manifest

        def recording(output, report):
            snapshots.append(copy.deepcopy(report))
            return original(output, report)

        with patch.object(adapter, 'write_manifest', side_effect=recording):
            with self.assertRaises(KeyboardInterrupt):
                adapter.acquire(inv, self.out, fetch=self.interrupt)
        self.assertTrue(snapshots)
        self.assert_pre_fetch_snapshot(snapshots[0])

    def test_interrupted_on_disk_snapshot_matches_first_snapshot_and_writes_no_responses(self):
        inv = self.mixed_inventory()
        with self.assertRaises(KeyboardInterrupt):
            adapter.acquire(inv, self.out, fetch=self.interrupt)
        report = json.loads((self.out / 'manifest.json').read_text())
        self.assert_pre_fetch_snapshot(report)
        self.assertEqual(sorted(p.name for p in (self.out / 'responses').iterdir()), [])

    def test_interruption_after_one_completed_roll_keeps_exact_on_disk_counts(self):
        inv = self.mixed_inventory(in_window=2, out_of_window=1)
        calls = []

        def fetch(url):
            calls.append(url)
            if len(calls) == 1:
                return self.response()
            raise KeyboardInterrupt()

        with self.assertRaises(KeyboardInterrupt):
            adapter.acquire(inv, self.out, fetch=fetch)
        self.assertEqual(calls, ['https://clerk.house.gov/evs/2025/roll001.xml',
                                 'https://clerk.house.gov/evs/2025/roll002.xml'])
        report = json.loads((self.out / 'manifest.json').read_text())
        self.assertEqual(report['status'], 'running')
        self.assertEqual(report['counts'], {'acquired': 1, 'pending': 1, 'excluded_outside_window': 1})

    def test_single_roll_interruption_on_disk_counts_are_exact(self):
        path, sha = packet_at(self.source, count=1)
        inv = adapter.validate_inventory(path, sha)
        with self.assertRaises(KeyboardInterrupt):
            adapter.acquire(inv, self.out, fetch=self.interrupt)
        report = json.loads((self.out / 'manifest.json').read_text())
        self.assertEqual(report['counts'], {'pending': 1})
        self.assertEqual(report['attempted_rolls'], 0)

    def test_all_rows_excluded_still_completes_with_exact_counts(self):
        path, sha = packet_at(self.source, count=1, window=('2025-01-04', '2025-01-05'))
        inv = adapter.validate_inventory(path, sha)

        def never(url):
            self.fail('outside-window record must not trigger HTTP')

        report = adapter.acquire(inv, self.out, fetch=never)
        self.assertEqual(report['status'], 'acquisition_complete')
        self.assertEqual(report['counts'], {'excluded_outside_window': 1})
        persisted = json.loads((self.out / 'manifest.json').read_text())
        self.assertEqual(persisted['counts'], {'excluded_outside_window': 1})

    def test_position_tokens_keep_raw_vote_text_verbatim_and_fixture_untouched(self):
        fixture = FIXTURES / 'house-2025-roll001.xml'
        before = fixture.read_bytes()
        path, sha = packet_at(self.source, count=1)
        inv = adapter.validate_inventory(path, sha)
        copied = bytes(bytearray(REAL_XML))
        body = copied.replace(b'<vote>Present</vote>', b'<vote> Present </vote>', 1)
        self.assertEqual(body.count(b'<vote> Present </vote>'), 1)
        self.assertEqual(body.index(b'<vote> Present </vote>'), copied.index(b'<vote>Present</vote>'))
        report = adapter.acquire(inv, self.out, fetch=lambda url: adapter.Response(
            status=200, body=body, final_url='https://clerk.house.gov/evs/2025/roll001.xml', content_type='text/xml'))
        row = report['records'][0]
        self.assertEqual(row['outcome'], 'acquired')
        meta = row['metadata']
        self.assertIn(' Present ', meta['position_tokens'])
        self.assertEqual(meta['position_tokens'], {'Present': 432, ' Present ': 1, 'Not Voting': 2})
        self.assertEqual(meta['recorded_vote_count'], 435)
        self.assertEqual(fixture.read_bytes(), before)
        self.assertEqual(digest(fixture.read_bytes()), '876aa39e6cfe58942eb5a3b24628975b288e6c5fca8d8e0257dfcd7d180163fd')


if __name__ == '__main__':
    unittest.main()
