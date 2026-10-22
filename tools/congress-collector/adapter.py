"""Receipt-preserving House XML acquisition, using Python's standard library.

An acquired XML is identity-checked source material, not a normalized vote or
member-coverage pass. The pinned collector and CivicLens semantic validation
remain separate downstream gates. No DB, credentials, or GovTrack fallback.
"""
import argparse
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
import hashlib
from http.client import HTTPException, IncompleteRead
import html
import importlib.util
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, Request
import xml.etree.ElementTree as ET

# Load the same sibling helper under isolated Python (-I) as the bridge.
_spec = importlib.util.spec_from_file_location('house_metadata', Path(__file__).resolve().parent / 'house_metadata.py')
house_metadata = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(house_metadata)

MAX_RESPONSE_BYTES = 5 * 1024 * 1024
MONTHS = {name: n for n, name in enumerate(
    ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'), 1)}

# Contract constants §6
CONTRACT = 'civiclens.official-vote-acquisition'
CONTRACT_VERSION = 1
ACQUISITION_SEMANTICS = 'downloaded_and_identity_checked_only'
COVERAGE_MONTHS = 48


class InventoryError(ValueError):
    pass


@dataclass(frozen=True)
class Response:
    status: int
    body: bytes
    final_url: str
    content_type: str
    body_complete: bool = True
    read_error: str | None = None


@dataclass(frozen=True)
class Inventory:
    path: Path
    sha256: str
    window: tuple[str, str]
    records: tuple[dict, ...]
    receipt_count: int

    @property
    def selected(self):
        return tuple(r for r in self.records if self.window[0] <= r['date'] <= self.window[1])


def sha256(body):
    return hashlib.sha256(body).hexdigest()


def integer(value, label):
    if type(value) is not int or value < 1:
        raise InventoryError(f'{label} must be a positive integer')
    return value


def iso_date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise InventoryError('invalid ISO date')
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise InventoryError('invalid calendar date') from exc


def subtract_months(iso_date_str, months):
    """UTC calendar arithmetic: subtract months, clamp day to month-end."""
    if type(months) is not int or months < 0:
        raise InventoryError('months must be a non-negative integer')
    d = iso_date(iso_date_str)
    year, month0 = divmod(d.year * 12 + d.month - 1 - months, 12)
    month = month0 + 1
    next_month = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    last_day = (next_month - timedelta(days=1)).day
    return date(year, month, min(d.day, last_day)).isoformat()


def window_policy(window):
    """Return {as_of, months} where months is 48 iff window matches 48-month span."""
    as_of = window[1]
    start = window[0]
    months = COVERAGE_MONTHS if start == subtract_months(as_of, COVERAGE_MONTHS) else None
    return {'as_of': as_of, 'months': months}


def official_date(value, listing=False):
    pattern = r'([A-Z][a-z]{2}) (\d{1,2}), (\d{4})' if listing else r'(\d{1,2})-([A-Z][a-z]{2})-(\d{4})'
    match = re.fullmatch(pattern, value)
    if not match:
        raise InventoryError('unrecognized official date')
    month, day, year = match.groups() if listing else (match[2], match[1], match[3])
    try:
        return date(int(year), MONTHS[month], int(day)).isoformat()
    except (KeyError, ValueError) as exc:
        raise InventoryError('invalid official calendar date') from exc


def source_url(value, path):
    if not isinstance(value, str):
        raise InventoryError('missing official source URL')
    parsed = urlsplit(value)
    if parsed.scheme != 'https' or parsed.netloc != 'clerk.house.gov' or parsed.path != path or parsed.fragment:
        raise InventoryError('unexpected source origin/path')
    return parsed


def listing_query(value, year):
    parsed = source_url(value, '/Votes/MemberVotes')
    query = parse_qs(parsed.query, keep_blank_values=True)
    if set(query) != {'CongressNum', 'Session', 'Page'} or any(len(v) != 1 for v in query.values()):
        raise InventoryError('unexpected or duplicate listing filters')
    congress = (year - 1789) // 2 + 1
    session = '1st' if year % 2 else '2nd'
    if query['CongressNum'] != [str(congress)] or query['Session'] != [session]:
        raise InventoryError('listing congress/session mismatch')
    if not re.fullmatch(r'[1-9]\d*', query['Page'][0]):
        raise InventoryError('invalid listing page')
    return int(query['Page'][0]), congress, session


def parse_listing(body, receipt, year):
    """Parse every displayed record and prove the declared page/continuation."""
    if receipt['status'] != 200 or sha256(body) != receipt['sha256']:
        raise InventoryError('listing HTTP/hash mismatch')
    page, congress, session = listing_query(receipt['url'], year)
    try:
        text = body.decode('utf-8')
    except UnicodeDecodeError as exc:
        raise InventoryError('invalid listing encoding') from exc
    counts = set(re.findall(r'class="pagination_info">\s*(\d+)\s*-\s*(\d+)\s+of\s+(\d+) Results', text))
    if len(counts) != 1:
        raise InventoryError('missing or contradictory listing counters')
    start, end, total = map(int, counts.pop())
    if total < 1 or receipt['total'] != total or receipt['range'] != [start, end]:
        raise InventoryError('listing receipt/range mismatch')
    if start != (page - 1) * 10 + 1 or end != min(page * 10, total) or end < start:
        raise InventoryError('listing range mismatch')
    continuations = []
    for action in re.findall(r'data-action="([^"]+)"', text):
        action = html.unescape(action)
        # Keep malformed markup in raw bytes, never silently repair it.
        try:
            next_page, _, _ = listing_query('https://clerk.house.gov' + action, year)
            continuations.append(next_page)
        except InventoryError:
            continue
    last_page = (total + 9) // 10
    if page < last_page and page + 1 not in continuations:
        raise InventoryError('missing valid next-page continuation')
    if page == last_page and (any(p > page for p in continuations) or re.search(r'aria-label="Next"', text)):
        raise InventoryError('terminal listing has a forward continuation')
    rows = []
    for block in text.split('<div class="role-call-vote">')[1:]:
        match = re.search(r'Roll Call Number:\s*<a href="(/Votes/(\d{4})(\d+)[^"]*)"[^>]*>(\d+)</a>', block)
        stamp = re.search(r'([A-Z][a-z]{2} \d{1,2}, \d{4}),', block)
        if not match or not stamp:
            raise InventoryError('unparsed listing row')
        row_year, roll = int(match[2]), int(match[3])
        stamp = official_date(stamp[1], listing=True)
        if row_year != year or stamp[:4] != str(year) or roll < 1 or roll != int(match[4]):
            raise InventoryError('listing row identity mismatch')
        href = source_url('https://clerk.house.gov' + html.unescape(match[1]), f'/Votes/{year}{roll}')
        href_query = parse_qs(href.query, keep_blank_values=True)
        if href_query and (set(href_query) != {'Page'} or len(href_query['Page']) != 1
                           or not re.fullmatch(r'[1-9]\d*', href_query['Page'][0])):
            raise InventoryError('unexpected listing detail URL filters')
        status_match = re.search(r'<label>Status:</label>\s*([^<]+)', block)
        status = html.unescape(status_match[1]).strip() if status_match else None
        rows.append({'year': year, 'roll': roll, 'date': stamp, 'status': status or None,
                     'url': f'https://clerk.house.gov/Votes/{year}{roll}', 'page': page})
    if len(rows) != end - start + 1:
        raise InventoryError('missing or extra displayed listing row')
    return rows


def validate_inventory(path, expected_sha256):
    """Verify a pinned packet, every raw page, and every claimed inventory row."""
    path = Path(path)
    if path.is_symlink():
        raise InventoryError('inventory may not be a symlink')
    try:
        raw = path.read_bytes()
        if not re.fullmatch(r'[0-9a-f]{64}', expected_sha256) or sha256(raw) != expected_sha256:
            raise InventoryError('pinned inventory hash mismatch')
        packet = json.loads(raw)
        window = packet['window']
        if not isinstance(window, list) or len(window) != 2:
            raise InventoryError('missing fixed inclusive window')
        low, high = map(iso_date, window)
        if low > high or high.year - low.year > 10:
            raise InventoryError('invalid or unbounded window')
        summaries = packet['summary']
        if not isinstance(summaries, list) or not summaries:
            raise InventoryError('missing session summaries')
        expected_years = set(range(low.year, high.year + 1))
        years = [integer(s['year'], 'year') for s in summaries]
        if len(set(years)) != len(years) or set(years) != expected_years:
            raise InventoryError('missing or duplicate window session')
        receipts = packet['receipts']
        if not isinstance(receipts, list) or not receipts:
            raise InventoryError('missing listing receipts')
        parsed_rows = []
        index_receipts = {}
        used_paths = set()
        for summary in summaries:
            year = summary['year']
            total = integer(summary['published_total'], 'published_total')
            pages = integer(summary['pages'], 'pages')
            if pages != (total + 9) // 10:
                raise InventoryError('session page count mismatch')
            matching = [r for r in receipts if f"CongressNum={(year - 1789) // 2 + 1}" in r['url']
                        and f"Session={'1st' if year % 2 else '2nd'}" in r['url']]
            if len(matching) != pages:
                raise InventoryError('missing/duplicate session page receipt')
            seen_pages = set()
            session_rows = []
            for receipt in matching:
                page, _, _ = listing_query(receipt['url'], year)
                if page in seen_pages or not 1 <= page <= pages:
                    raise InventoryError('duplicate or invalid page identity')
                seen_pages.add(page)
                if receipt['total'] != total:
                    raise InventoryError('changed session total')
                name = receipt['path']
                if not isinstance(name, str) or Path(name).name != name or name in used_paths:
                    raise InventoryError('unsafe or duplicate receipt path')
                file = path.parent / name
                if file.is_symlink():
                    raise InventoryError('raw listing may not be a symlink')
                used_paths.add(name)
                if not isinstance(receipt['fetched_at'], str) or not datetime.fromisoformat(receipt['fetched_at']).tzinfo:
                    raise InventoryError('missing timezone-aware source timestamp')
                rows = parse_listing(file.read_bytes(), receipt, year)
                index_receipts[(year, page)] = receipt
                session_rows.extend(rows)
            if len(session_rows) != total or len({r['roll'] for r in session_rows}) != total:
                raise InventoryError('duplicate or missing session rolls')
            selected_count = sum(window[0] <= r['date'] <= window[1] for r in session_rows)
            if summary['window_total'] != selected_count:
                raise InventoryError('session window total mismatch')
            parsed_rows.extend(session_rows)
        if len(used_paths) != len(receipts):
            raise InventoryError('unaccounted source page receipt')
        claimed = packet['inventory']
        if not isinstance(claimed, list) or len(claimed) != len(parsed_rows):
            raise InventoryError('unaccounted inventory rows')
        row_map = {(r['year'], r['roll']): r for r in parsed_rows}
        seen = set()
        records = []
        for row in claimed:
            key = (integer(row['year'], 'year'), integer(row['roll'], 'roll'))
            if key in seen or row_map.get(key) != row:
                raise InventoryError('claimed row differs from raw source or duplicates a roll')
            seen.add(key)
            congress = (row['year'] - 1789) // 2 + 1
            session = 1 if row['year'] % 2 else 2
            receipt = index_receipts[(row['year'], row['page'])]
            query = parse_qs(urlsplit(receipt['url']).query)
            if query.get('CongressNum') != [str(congress)] or query.get('Session') != [('1st', '2nd')[session - 1]]:
                raise InventoryError('record congress/session differs from its index-receipt listing URL')
            records.append({**row, 'key': f"{congress}-{row['year']}/h{row['roll']}",
                            'congress': congress, 'session': session,
                            'index_receipt': receipt})
        inventory = Inventory(path.resolve(), expected_sha256, tuple(window), tuple(records), len(receipts))
        if packet['window_total'] != len(inventory.selected):
            raise InventoryError('aggregate window total mismatch')
        return inventory
    except (OSError, KeyError, TypeError, ValueError) as exc:
        if isinstance(exc, InventoryError):
            raise
        raise InventoryError(f'invalid inventory packet: {exc}') from exc


def validate_xml(body, row):
    # ElementTree does not fetch the external public DTD in official samples.
    # Internal entities/subsets are not part of the supported source contract.
    if re.search(br'<!ENTITY|<!DOCTYPE[^>]*\[', body, flags=re.IGNORECASE):
        raise ValueError('internal XML entities/subsets are unsupported')
    root = ET.fromstring(body)
    if root.tag != 'rollcall-vote':
        raise ValueError('expected House rollcall-vote XML, received another document')
    metadata = root.findall('vote-metadata')
    if len(metadata) != 1:
        raise ValueError('missing/duplicate vote metadata')
    def field(name, optional=False):
        nodes = metadata[0].findall(name)
        if optional and not nodes:
            return ''
        if len(nodes) != 1 or list(nodes[0]):
            raise ValueError(f'missing/duplicate/structured {name}')
        return (nodes[0].text or '').strip()
    house_metadata.validate_house_label(metadata[0])
    expected = {'congress': str(row['congress']), 'session': '1st' if row['session'] == 1 else '2nd',
                'rollcall-num': str(row['roll'])}
    for name, value in expected.items():
        if field(name) != value:
            raise ValueError(f'XML {name} differs from enumerated roll')
    if official_date(field('action-date')) != row['date']:
        raise ValueError('XML date differs from enumerated roll')
    data = root.findall('vote-data')
    if len(data) != 1 or not data[0].findall('recorded-vote'):
        raise ValueError('missing House voter payload')

    # Parse vote-desc (§6: '' allowed)
    vote_desc_nodes = metadata[0].findall('vote-desc')
    if len(vote_desc_nodes) != 1 or list(vote_desc_nodes[0]):
        raise ValueError('missing/duplicate/structured vote-desc')
    vote_desc = (vote_desc_nodes[0].text or '').strip()

    # Parse amendment fields (§6: 0 → None, 1 → text, >1 → ValueError)
    def parse_optional_element(name):
        nodes = metadata[0].findall(name)
        if len(nodes) == 0:
            return None
        if len(nodes) == 1:
            if list(nodes[0]):
                raise ValueError(f'structured {name} element')
            return (nodes[0].text or '').strip()
        raise ValueError(f'multiple {name} elements')

    amendment_num = parse_optional_element('amendment-num')
    amendment_author = parse_optional_element('amendment-author')

    # Count recorded votes and validate each has exactly one <vote>
    recorded_votes = data[0].findall('recorded-vote')
    position_tokens = Counter()
    for rv in recorded_votes:
        votes = rv.findall('vote')
        if len(votes) != 1:
            raise ValueError('recorded-vote must have exactly one vote child')
        position_tokens[votes[0].text or ''] += 1

    # Raw positions, membership, totals and bill classification are downstream.
    return {'key': row['key'], 'chamber': 'house', 'congress': row['congress'], 'session': row['session'],
            # Official Speaker elections can omit legis-num; missing identity stays empty.
            'roll': row['roll'], 'date': row['date'], 'legis_num': field('legis-num', optional=True),
            'question': field('vote-question'), 'vote_type': field('vote-type'), 'result': field('vote-result'),
            'vote_desc': vote_desc, 'amendment_num': amendment_num, 'amendment_author': amendment_author,
            'recorded_vote_count': len(recorded_votes), 'position_tokens': dict(position_tokens)}


def write_manifest(output, report):
    pending = output / 'manifest.tmp'
    pending.write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
    pending.replace(output / 'manifest.json')


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def acquire(inventory, output, fetch, max_rolls=None):
    """One attempt per selected roll; preserve every byte and unattempted roll.

    A new run directory is mandatory. No automatic retries or reuse of old
    successful responses. Interrupted runs remain visibly running/pending.
    """
    if max_rolls is not None and (type(max_rolls) is not int or max_rolls < 0):
        raise ValueError('max_rolls must be a nonnegative integer')
    # Revalidate the frozen inputs at the execution boundary.
    inventory = validate_inventory(inventory.path, inventory.sha256)
    output = Path(output).absolute()
    if any(p.is_symlink() for p in [output, *output.parents]):
        raise ValueError('output path may not traverse a symlink')
    output = output.resolve()
    if output.is_relative_to(inventory.path.parent):
        raise ValueError('output may not mutate the source evidence directory')
    output.mkdir(parents=True, exist_ok=False)
    (output / 'responses').mkdir()
    records = [{**row, 'chamber': 'house', 'source_url': f"https://clerk.house.gov/evs/{row['year']}/roll{row['roll']:03d}.xml",
                'in_window': inventory.window[0] <= row['date'] <= inventory.window[1],
                'attempted': False, 'attempted_at': None,
                'outcome': 'pending', 'reason': None, 'response': None, 'metadata': None}
               for row in inventory.records]
    # Classify out-of-window rows before the first snapshot so no fetch is needed for them.
    for row in records:
        if not row['in_window']:
            row.update(outcome='excluded_outside_window', reason='official listing date outside frozen inclusive window')
    report = {'contract': CONTRACT, 'contract_version': CONTRACT_VERSION, 'chamber': 'house',
              'status': 'running', 'started_at': timestamp(), 'finished_at': None,
              'window': list(inventory.window), 'window_policy': window_policy(inventory.window),
              'inventory_sha256': inventory.sha256,
              'index_pages_verified': inventory.receipt_count, 'published_rolls': len(records),
              'required_rolls': len(inventory.selected), 'attempted_rolls': 0, 'max_rolls': max_rolls,
              'safety_cap_applied': False, 'counts': dict(Counter(r['outcome'] for r in records)), 'records': records,
              'acquisition_semantics': ACQUISITION_SEMANTICS,
              'normalized_votes_validated': False, 'member_coverage_validated': False,
              'bill_resolution_validated': False, 'collector_revision': None}
    write_manifest(output, report)
    attempts = 0
    for row in records:
        if row['outcome'] == 'excluded_outside_window':
            pass  # Already classified above; never fetched.
        elif max_rolls is not None and attempts >= max_rolls:
            row.update(outcome='incomplete_fetch', reason='safety cap: enumerated roll not attempted')
            report['safety_cap_applied'] = True
        else:
            attempts += 1
            row['attempted'] = True
            attempted_at = timestamp()
            row['attempted_at'] = attempted_at
            try:
                response = fetch(row['source_url'])
            except (OSError, URLError, HTTPException) as exc:
                row.update(outcome='source_failure', reason=f'{type(exc).__name__}: {exc}')
            else:
                name = f"responses/{row['year']}-h{row['roll']:05d}.body"
                (output / name).write_bytes(response.body)
                row['response'] = {'url': row['source_url'], 'final_url': response.final_url,
                                   'http_status': response.status, 'content_type': response.content_type,
                                   'path': name, 'sha256': sha256(response.body), 'bytes': len(response.body),
                                   'body_complete': response.body_complete, 'read_error': response.read_error,
                                   'attempted_at': attempted_at, 'received_at': timestamp()}
                if response.final_url != row['source_url']:
                    row.update(outcome='source_failure', reason='unexpected redirect/effective source URL')
                elif response.status in (404, 410):
                    row.update(outcome='incomplete_fetch', reason=f'enumerated XML unavailable: HTTP {response.status}')
                elif response.status != 200:
                    row.update(outcome='source_failure', reason=f'HTTP {response.status}')
                elif not response.body_complete:
                    row.update(outcome='incomplete_fetch', reason=response.read_error or 'incomplete HTTP body')
                elif len(response.body) > MAX_RESPONSE_BYTES:
                    row.update(outcome='malformed_source', reason='response exceeds XML byte safety cap')
                elif b'This vote was vacated' in response.body:
                    row.update(outcome='unsupported_record', reason='official response contains vacated marker; exclusion authority requires review')
                elif b'roll-call-vote-not-available.htm' in response.body:
                    row.update(outcome='incomplete_fetch', reason='enumerated vote detail not yet published')
                else:
                    try:
                        row['metadata'] = validate_xml(response.body, row)
                    except (ET.ParseError, ValueError, LookupError) as exc:
                        row.update(outcome='malformed_source', reason=str(exc))
                    else:
                        row.update(outcome='acquired')
        report['attempted_rolls'] = sum(1 for r in records if r['attempted'])
        report['counts'] = dict(Counter(r['outcome'] for r in records))
        write_manifest(output, report)
    report['status'] = 'acquisition_complete' if all(r['outcome'] in {'acquired', 'excluded_outside_window'} for r in records) else 'incomplete'
    report['finished_at'] = timestamp()
    write_manifest(output, report)
    return report


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_xml(url):
    parsed = urlsplit(url)
    source_url(url, parsed.path)
    if not re.fullmatch(r'/evs/\d{4}/roll\d{3,}\.xml', parsed.path) or parsed.query:
        raise ValueError('unexpected XML request URL')
    opener = build_opener(NoRedirect())
    request = Request(url, headers={'User-Agent': 'CivicLens-source-acquisition/1.0', 'Accept': 'application/xml,text/xml'})
    try:
        response = opener.open(request, timeout=30)
    except HTTPError as exc:
        response = exc  # Error-page bytes and status are still source receipts.
    with response:
        complete, error = True, None
        try:
            body = response.read(MAX_RESPONSE_BYTES + 1)
        except IncompleteRead as exc:
            body = exc.partial[:MAX_RESPONSE_BYTES + 1]
            complete, error = False, str(exc)
        except (OSError, HTTPException) as exc:
            body = b''  # No captured bytes are available from this error.
            complete, error = False, f'{type(exc).__name__}: {exc}'
        if len(body) > MAX_RESPONSE_BYTES:
            complete, error = False, 'HTTP body exceeds byte cap; captured prefix only'
        length = response.headers.get('Content-Length')
        if length is not None:
            if not re.fullmatch(r'\d+', length):
                complete, error = False, 'invalid HTTP Content-Length'
            elif len(body) != int(length):
                complete, error = False, 'captured HTTP body length differs from Content-Length'
        return Response(response.status, body, response.geturl(), response.headers.get('Content-Type', ''),
                        body_complete=complete, read_error=error)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', required=True, type=Path)
    parser.add_argument('--inventory-sha256', required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check-inventory', action='store_true', help='validate saved bytes only; no HTTP/output')
    mode.add_argument('--execute', action='store_true', help='one live HTTP attempt per in-window roll')
    parser.add_argument('--output', type=Path, help='new directory under this worktree artifacts/official-house-acquisition/')
    parser.add_argument('--max-rolls', type=int, help='explicit cap; any omitted required roll makes the run incomplete')
    args = parser.parse_args(argv)
    try:
        inventory = validate_inventory(args.inventory, args.inventory_sha256)
        if args.check_inventory:
            if args.output is not None or args.max_rolls is not None:
                parser.error('--output/--max-rolls require --execute')
            print(json.dumps({'inventory_sha256': inventory.sha256, 'window': inventory.window,
                              'window_policy': window_policy(inventory.window),
                              'index_pages_verified': inventory.receipt_count, 'published_rolls': len(inventory.records),
                              'selected_rolls': len(inventory.selected), 'xml_acquisition_complete': False}))
            return 0
        allowed = Path(__file__).resolve().parents[2] / 'artifacts/official-house-acquisition'
        if args.output is None or not args.output.resolve().is_relative_to(allowed) or args.output.resolve() == allowed:
            parser.error('--output must be a new run directory under this worktree artifacts/official-house-acquisition/')
        report = acquire(inventory, args.output, fetch_xml, args.max_rolls)
        print(json.dumps({k: v for k, v in report.items() if k != 'records'}))
        return 0 if report['status'] == 'acquisition_complete' else 1
    except (InventoryError, OSError, ValueError) as exc:
        print(json.dumps({'status': 'failed', 'reason': str(exc)}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
