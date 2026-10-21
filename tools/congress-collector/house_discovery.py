"""Receipt-preserving Clerk listing discovery; stdlib only, injectable HTTP."""
from http.client import HTTPException, IncompleteRead
from pathlib import Path
import json
import re
from urllib.error import HTTPError
from urllib.request import build_opener, Request
import adapter

class DiscoveryError(ValueError):
    pass

def fetch_response(url, allow):
    """One bounded request, redirects refused; captured error bodies retained."""
    allow(url)
    try:
        response = build_opener(adapter.NoRedirect()).open(Request(url, headers={'User-Agent': 'CivicLens-source-acquisition/1.0'}), timeout=30)
    except HTTPError as exc:
        response = exc
    with response:
        complete, error = True, None
        try:
            body = response.read(adapter.MAX_RESPONSE_BYTES + 1)
        except IncompleteRead as exc:
            body, complete, error = exc.partial[:adapter.MAX_RESPONSE_BYTES + 1], False, str(exc)
        except (OSError, HTTPException) as exc:
            body, complete, error = b'', False, str(exc)
        length = response.headers.get('Content-Length')
        if len(body) > adapter.MAX_RESPONSE_BYTES:
            complete, error = False, 'HTTP body exceeds byte cap; captured prefix only'
        if length is not None and (not re.fullmatch(r'\d+', length) or int(length) != len(body)):
            complete, error = False, 'captured HTTP body length differs from Content-Length'
        return adapter.Response(response.status, body, response.geturl(), response.headers.get('Content-Type', ''), complete, error)

def listing_url(year, page):
    return f"https://clerk.house.gov/Votes/MemberVotes?CongressNum={(year - 1789)//2+1}&Session={'1st' if year%2 else '2nd'}&Page={page}"

def fetch_page(url):
    def allow(value):
        from urllib.parse import parse_qs, urlsplit
        q = parse_qs(urlsplit(value).query)
        try:
            c = int(q['CongressNum'][0]); s = {'1st': 1, '2nd': 2}[q['Session'][0]]
            adapter.listing_query(value, 1787 + 2*c + s-1)
            if c < 1: raise ValueError('invalid congress')
        except (KeyError, ValueError, IndexError) as exc:
            raise DiscoveryError('unexpected Clerk listing URL') from exc
    return fetch_response(url, allow)

def checked_response(response, url):
    if response.status != 200 or response.final_url != url or not response.body_complete or response.read_error is not None or len(response.body) > adapter.MAX_RESPONSE_BYTES:
        raise DiscoveryError(f'incomplete/failed listing response {url}: HTTP {response.status}, final={response.final_url}, error={response.read_error}')

def discover_house(window, out_dir, fetch_page=fetch_page):
    low, high = map(adapter.iso_date, window)
    if low > high or high.year-low.year>10: raise DiscoveryError('invalid or unbounded window')
    out = Path(out_dir)
    if any(p.is_symlink() for p in [out,*out.parents]):raise DiscoveryError('symlink output refused')
    out.mkdir(parents=True, exist_ok=False)
    receipts, rows, summaries = [], [], []
    try:
        for year in range(low.year, high.year+1):
            total, page, year_rows = None, 1, []
            while total is None or page <= (total+9)//10:
                url = listing_url(year,page); response = fetch_page(url); name=f'{year}-page{page:03d}.html'
                (out/name).write_bytes(response.body)
                receipt={'url':url,'status':response.status,'path':name,'sha256':adapter.sha256(response.body),'bytes':len(response.body),'final_url':response.final_url,'content_type':response.content_type,'body_complete':response.body_complete,'read_error':response.read_error,'fetched_at':adapter.timestamp()}
                # Preserve failed receipt before parsing/raising, never write a successful inventory.
                (out/'discovery-receipts.json').write_text(json.dumps(receipts+[receipt],indent=2)+'\n')
                checked_response(response,url)
                counts=set(re.findall(rb'class="pagination_info">\s*(\d+)\s*-\s*(\d+)\s+of\s+(\d+) Results',response.body))
                if len(counts)!=1:raise DiscoveryError('missing or contradictory listing counters')
                start,end,found=map(int,counts.pop())
                if total is not None and total!=found:raise DiscoveryError('session total changed mid-crawl')
                total=found;receipt.update(range=[start,end],total=total)
                parsed=adapter.parse_listing(response.body,receipt,year);receipts.append(receipt);year_rows.extend(parsed);page+=1
            selected=sorted(r['date'] for r in year_rows if window[0]<=r['date']<=window[1]);numbers={r['roll'] for r in year_rows}
            summaries.append({'year':year,'published_total':total,'pages':page-1,'window_total':len(selected),'roll_min':min(numbers),'roll_max':max(numbers),'gaps':sorted(set(range(1,max(numbers)+1))-numbers),'first_window_date':selected[0] if selected else None,'last_window_date':selected[-1] if selected else None,'statuses':sorted({r['status'] for r in year_rows if r['status']})})
            if summaries[-1]['gaps'] or len(numbers)!=total:raise DiscoveryError('session roll enumeration incomplete')
            rows.extend(year_rows)
        packet={'window':list(window),'summary':summaries,'receipts':receipts,'inventory':rows,'window_total':sum(s['window_total'] for s in summaries),'claim':'Complete listing enumeration only; acquisition and normalization remain separate.'}
        path=out/'inventory.json';path.write_text(json.dumps(packet,sort_keys=True,indent=2)+'\n');digest=adapter.sha256(path.read_bytes())
        adapter.validate_inventory(path,digest)
        return path.resolve(),digest
    except (OSError,ValueError,KeyError,TypeError,HTTPException) as exc:
        if isinstance(exc,DiscoveryError):raise
        raise DiscoveryError(str(exc)) from exc
