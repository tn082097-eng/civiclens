import json, re, time, urllib.request

API = "https://api.usaspending.gov/api/v2"
DISTRICTS = [("josh-gottheimer","NJ","05"), ("jared-moskowitz","FL","23"),
             ("ro-khanna","CA","17"), ("mike-turner","OH","10")]

def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type":"application/json"})
    return json.load(urllib.request.urlopen(req))

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent":"CivicLens research tn082097@gmail.com"})
    return json.load(urllib.request.urlopen(req))

SUFFIX = re.compile(r'\b(INCORPORATED|CORPORATION|COMPANY|CORP|INC|LLC|LLP|LP|LTD|CO|PLC|SA|NV|AG|HOLDINGS?|GROUP|INTERNATIONAL|INTL|USA|US|NORTH AMERICA|AMERICAS?|ENTERPRISES?|INDUSTRIES|TECHNOLOGIES|TECHNOLOGY|SYSTEMS?|SERVICES?|SOLUTIONS?)\b')
def norm(s):
    s = re.sub(r'[^A-Z0-9 ]',' ', s.upper())
    s = SUFFIX.sub(' ', s)
    return re.sub(r'\s+',' ', s).strip()

# SEC ticker universe (primary source)
sec = get("https://www.sec.gov/files/company_tickers.json")
name2ticker = {}
for row in sec.values():
    name2ticker.setdefault(norm(row["title"]), row["ticker"])
print(f"SEC universe: {len(sec)} tickers, {len(name2ticker)} distinct normalized names")

member_tickers = {}
for r in json.load(open("member_tickers.json")):
    member_tickers.setdefault(r["member_id"], set()).add(r["ticker"])

out = {}
for member, state, dist in DISTRICTS:
    body = {"filters":{"award_type_codes":["A","B","C","D"],
            "place_of_performance_locations":[{"country":"USA","state":state,"district_original":dist}],
            "time_period":[{"start_date":"2023-01-01","end_date":"2025-12-31"}]},
            "limit":100,"page":1}
    d = post(f"{API}/search/spending_by_category/recipient/", body)
    recips = d["results"]
    total = sum(r["amount"] for r in recips)
    resolved = []   # (name, parent, ticker, amount, how)
    unresolved_top = []
    for i, r in enumerate(recips):
        t = name2ticker.get(norm(r["name"]))
        how = "own-name"
        parent = None
        if not t and i < 40 and r.get("recipient_id"):  # parent lookup for top-40 unmatched
            time.sleep(0.15)
            try:
                prof = get(f"{API}/recipient/{r['recipient_id']}/")
                parent = prof.get("parent_name")
                if parent:
                    t = name2ticker.get(norm(parent)); how = "parent-name"
            except Exception:
                pass
        if t:
            resolved.append({"name":r["name"],"parent":parent,"ticker":t.upper(),
                             "amount":r["amount"],"how":how})
        elif i < 15:
            unresolved_top.append({"name":r["name"],"parent":parent,"amount":r["amount"]})
    rd = sum(x["amount"] for x in resolved)
    traded = member_tickers.get(member, set())
    overlap = [x for x in resolved if x["ticker"] in traded]
    out[member] = {"district":f"{state}-{dist}","top100_total":total,
                   "resolved_n":len(resolved),"resolved_dollars":rd,
                   "resolved_share":rd/total,"overlap":overlap,
                   "unresolved_top":unresolved_top,
                   "resolved":resolved}
    print(f"\n{member} ({state}-{dist}): top-100 = ${total:,.0f}")
    print(f"  resolved to public ticker: {len(resolved)}/100 recipients, ${rd:,.0f} ({rd/total:.0%} of dollars)")
    print(f"  overlap with member's own traded tickers ({len(traded)} tickers):")
    for x in sorted(overlap, key=lambda x:-x["amount"]):
        print(f"    {x['ticker']:6} {x['name'][:38]:38} ${x['amount']:,.0f} [{x['how']}]")
    if not overlap: print("    (none)")

json.dump(out, open("recipient_probe_2026-07-17.json","w"), indent=1)
print("\nfrozen: recipient_probe_2026-07-17.json")
