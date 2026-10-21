#!/usr/bin/env python3
"""SYNTHETIC offline interoperability helper for testing official-vote-acquisition.

This is NOT official evidence. It builds a one-roll synthetic listing packet,
calls adapter.acquire with an injected fetch, and reports the manifest path.
Used by TypeScript interop tests to verify the Python adapter wire format.

CLI: python3 make_interop_manifest.py <output-dir> <scenario>
Scenarios: complete, capped, http500, vacated
Exit 0 on success, 2 on unknown scenario.
"""

import json
import sys
from pathlib import Path
import tempfile

# Insert this script's directory so we can import adapter
sys.path.insert(0, str(Path(__file__).parent))
import adapter


FIXTURES = Path(__file__).resolve().parents[2] / 'fixtures/votes/house-acquisition'
REAL_XML = (FIXTURES / 'house-2025-roll001.xml').read_bytes()


def build_synthetic_packet(outdir):
    """Build a one-roll synthetic listing packet for 2025 roll 1, dated 2025-01-03."""
    packet = {
        'window': ['2025-01-03', '2025-01-03'],
        'summary': [{
            'year': 2025,
            'published_total': 1,
            'pages': 1,
            'window_total': 1
        }],
        'inventory': [{
            'year': 2025,
            'roll': 1,
            'date': '2025-01-03',
            'status': 'Passed',
            'url': 'https://clerk.house.gov/Votes/20251',
            'page': 1
        }],
        'receipts': [{
            'url': 'https://clerk.house.gov/Votes/MemberVotes?CongressNum=119&Session=1st&Page=1',
            'status': 200,
            'path': '2025-page001.html',
            'sha256': 'synthetic000000000000000000000000000000000000000000000000000000001',
            'range': [1, 1],
            'total': 1,
            'fetched_at': '2026-10-05T00:28:56+00:00'
        }],
        'window_total': 1
    }
    # Create synthetic HTML page
    body = b'''<div class="pagination_info">1 - 1 of 1 Results</div>
<div class="role-call-vote">
  Roll Call Number: <a href="/Votes/20251?Page=1">1</a>
  <span>Jan 3, 2025, 12:33 PM</span>
  <label>Status:</label>Passed</div>
<div class="pagination_info">1 - 1 of 1 Results</div>'''
    page_path = outdir / '2025-page001.html'
    page_path.write_bytes(body)
    # Update receipt hash
    packet['receipts'][0]['sha256'] = adapter.sha256(body)
    # Write inventory
    inv_path = outdir / 'inventory.json'
    inv_path.write_text(json.dumps(packet))
    return inv_path, adapter.sha256(inv_path.read_bytes())


def main():
    if len(sys.argv) != 3:
        print('Usage: make_interop_manifest.py <output-dir> <scenario>', file=sys.stderr)
        sys.exit(2)
    output_dir = Path(sys.argv[1])
    scenario = sys.argv[2]

    if scenario not in ('complete', 'capped', 'http500', 'vacated'):
        sys.exit(2)

    # Create packet in a temp subdir within output
    output_dir.mkdir(parents=True, exist_ok=True)
    packet_dir = output_dir / 'packet'
    packet_dir.mkdir()
    run_dir = output_dir / 'run'

    # Build synthetic packet
    inv_path, inv_sha = build_synthetic_packet(packet_dir)
    inventory = adapter.validate_inventory(inv_path, inv_sha)

    # Inject fetch based on scenario
    def fetch_scenario(url):
        if scenario == 'complete':
            return adapter.Response(200, REAL_XML, url, 'text/xml')
        elif scenario == 'capped':
            # max_rolls=0 handled separately
            return adapter.Response(200, REAL_XML, url, 'text/xml')
        elif scenario == 'http500':
            return adapter.Response(500, b'synthetic error', url, 'text/plain')
        elif scenario == 'vacated':
            return adapter.Response(200, b'<html>This vote was vacated</html>', url, 'text/html')

    # Call acquire with appropriate parameters
    if scenario == 'capped':
        report = adapter.acquire(inventory, run_dir, fetch=fetch_scenario, max_rolls=0)
    else:
        report = adapter.acquire(inventory, run_dir, fetch=fetch_scenario)

    # Print result and exit
    print(json.dumps({'run_dir': str(run_dir)}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
