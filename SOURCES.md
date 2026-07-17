# SOURCES

Primary-source registry for CivicLens. Every agent that consumes an external source must have a frozen sample probe documented here before implementation.

---

## FEC OpenFEC API — Independent Expenditures (Schedule E) and Donors (Schedule A)

**Base URL:** `https://api.open.fec.gov/v1`
**Auth:** `OPENFEC_API_KEY` env var, passed as `api_key` query param
**Rate limit:** 1000 req/hour per key (default tier). Cache aggressively.

Frozen probe artifacts: `pfd-cache/fec-ie-probe-2026-05-04/`
Probe target: MTG (`candidate_id=H0GA06192`), 2024 cycle.

### Endpoint 1 — Aggregated IE per (committee, cycle, S/O)

`GET /schedules/schedule_e/by_candidate/?candidate_id={id}&cycle={year}`

This is the right endpoint for the profile page's "supporting / opposing Super PACs, top 3 by spend" block. Already aggregated per (committee_id, cycle, support_oppose_indicator). Sample:

```json
{
  "candidate_id": "H0GA06192",
  "candidate_name": "GREENE, MARJORIE TAYLOR",
  "committee_id": "C00768101",
  "committee_name": "MISSION DEMOCRACY PAC",
  "count": 2,
  "cycle": 2024,
  "support_oppose_indicator": "O",
  "total": 9166.66
}
```

Sample frozen at `pfd-cache/fec-ie-probe-2026-05-04/by_candidate_mtg_2024.json` — 4 committees for MTG in 2024.

Group results by `support_oppose_indicator` (`S` = supporting, `O` = opposing) and sort by `total` descending to populate the profile block.

### Endpoint 2 — Itemized IE filings

`GET /schedules/schedule_e/?candidate_id={id}&cycle={year}&per_page=100&sort=-expenditure_amount`

Use only when the agent needs per-ad detail (timeline events, ad descriptions, payee firms). For aggregate dashboards, prefer the `by_candidate` endpoint above.

Sample frozen at `pfd-cache/fec-ie-probe-2026-05-04/schedule_e_itemized_mtg_2024.json`. Key fields:

- `committee_id` — the spending Super PAC
- `support_oppose_indicator` — `S` or `O`
- `expenditure_amount`, `expenditure_date`, `disbursement_dt`
- `expenditure_description` — e.g., `"PLACED MEDIA: TV"`
- `payee_name` — the ad firm receiving the money (e.g., `"WINNING STRATEGY MEDIA, LLC"`)
- `pdf_url` — original FEC filing PDF
- `report_year`, `election_type` — `P2022`, `G2024`, etc.

Pagination: `pagination.count`, `pagination.pages`. MTG 2024 cycle has ~277 itemized rows. Use `last_indexes` for deep pagination if needed.

**Quirk:** `two_year_transaction_period` is unreliable on the raw `schedule_e` endpoint (returned identical 277-row totals for 2022/2024/2026). Use `cycle` instead, or rely on the `by_candidate` aggregate.

### Endpoint 3 — Schedule A funders (donors to the Super PAC)

`GET /schedules/schedule_a/?committee_id={cid}&two_year_transaction_period={year}&per_page=100&sort=-contribution_receipt_amount`

Use this to populate the "where did the Super PAC's money come from" view referenced in the spec ("Donor → Super PAC → ad spend chains").

Sample frozen at `pfd-cache/fec-ie-probe-2026-05-04/schedule_a_donors_C00768101_2024.json`. Key fields:

- `contributor_name`, `contributor_employer`, `contributor_occupation`
- `contributor_city`, `contributor_state`, `contributor_zip`
- `contribution_receipt_amount`, `contribution_receipt_date`
- `entity_type`, `entity_type_desc` — `IND`, `PAC`, `ORG`, `CCM` etc.
- `memo_text` — flags earmarks/passthroughs
- `receipt_type` — line code

**Quirk — ActBlue / WinRed passthrough:** Top "donor" is often `ACTBLUE` or `WINRED` with a memo `"NOTE: TOTAL CONTRIBUTION(S) EARMARKED THROUGH THIS ORGANIZATION."` These are conduit aggregates, not real donors. The actual donor records appear separately as memo-text rows tied to the conduit. Filter or label these explicitly in the funder view, otherwise the dashboard will show ActBlue as the #1 donor to every Democratic PAC.

`schedule_a` is paginated with `last_indexes` (deep pagination). Mission Democracy PAC has 745 contribution rows for 2024 alone.

### Endpoint 4 — Committee metadata (label the Super PAC)

`GET /committee/{committee_id}/`

Sample frozen at `pfd-cache/fec-ie-probe-2026-05-04/committee_C00768101.json`. Key fields:

- `name`, `committee_type`, `committee_type_full` — `"PAC - Nonqualified"`, `"Super PAC (Independent Expenditure-Only)"`, etc.
- `designation`, `designation_full` — `"Leadership PAC"`, `"Authorized by a Candidate"`, etc.
- `organization_type_full` — `"Corporation"`, `"Labor Organization"`, etc.
- `party` — three-letter code (`DEM`, `REP`, `IND`, `NON`)
- `treasurer_name`, `first_file_date`

Cache committee records aggressively — they rarely change. Suggested cache: `pfd-cache/committees/{committee_id}.json` with mtime-based TTL.

### Implementation notes for the IE fetcher

- Live in `lib/fec-ie.ts` (per spec).
- Inputs: `fecCandidateId` from politician records (already on the schema, set by Researcher).
- Output shape (suggested for `lib/types.ts`): `SuperPacIE { committeeId, committeeName, committeeType, totalAmount, count, supportOppose, cycle }` plus per-itemized `IEFiling` for timeline use.
- Cycles to pull: most-recent two cycles (2024, 2026). Configurable.
- Cache by `(candidate_id, cycle)` under `pfd-cache/fec-ie/{candidate_id}/{cycle}.json`.
- Schedule A donors are *expensive* (745 rows for one PAC, one cycle) — only fetch top funders for the top-N supporting/opposing PACs, not every committee that touched the candidate.
- Tag passthroughs (ActBlue / WinRed) explicitly in the donor table.

### Quirk — non-committee IE filers (C9 prefix)

Some `committee_id` values returned by Schedule E start with `C9` (e.g.
`C90022161` for `TOGETHERSF ACTION`). These are *registrant* IDs for
"Independent expenditure filer (not a committee)" — entities that file IEs
without registering a full committee. The `/committee/{id}/` endpoint
returns an empty `results` array for these, so committee metadata
(`type`, `designation`, `party`) is null. Schedule A donor lookups will
also be empty. Filter or label these explicitly in downstream views;
don't treat the missing metadata as a fetcher bug.

### What we did NOT verify in this probe

- Schedule E for Senate candidates (the candidate_id format differs: `S` prefix).
- Schedule E `cycle` filter behavior at year boundaries (records have both `report_year` and `election_type`; need to confirm which the `cycle` filter binds to).
- Verified on MTG (`H0GA06192`, low IE) and Pelosi (`H8CA05035`, low IE in 2024). Have not yet probed a 2024 cycle with heavy outside spending (Senate races, contested swing-district House races) to confirm pagination and rate-limit behavior under load.

---

## Congress.gov API — Cosponsored Legislation

**Base URL:** `https://api.congress.gov/v3`
**Auth:** `CONGRESS_API_KEY` env var, passed as `api_key` query param
**Rate limit:** 5,000 req/hour per key.

Frozen probe artifacts: `pfd-cache/cosponsor-probe-2026-05-09/`
Probe targets: MTG (`bioguide=M001213`), Bernie Sanders (`bioguide=S000033`).

### Endpoint — `/member/{bioguide}/cosponsored-legislation`

`GET /member/{bioguide}/cosponsored-legislation?format=json&limit={n}&offset={n}`

Returns bills the member cosponsored. Same payload shape as `sponsored-legislation` (already wired in `skills/researcher/fetch.ts:fetchCongressSponsored`). Sample item:

```json
{
  "congress": 119,
  "introducedDate": "2026-05-07",
  "latestAction": { "actionDate": "2026-05-04", "text": "Referred to ..." },
  "number": "1252",
  "policyArea": { "name": "Crime and Law Enforcement" },
  "title": "Resolution memorializing law enforcement officers killed in the line of duty.",
  "type": "HRES",
  "url": "https://api.congress.gov/v3/bill/119/hres/1252?format=json"
}
```

`pagination.count` gives total cosponsorships for the member; pagination via `offset`. MTG: 573 cosponsorships. Sanders: also several hundred. Expect tens of thousands of rows corpus-wide for the 35-member roster.

### Mapping to `bills` table

- `bill_id` constructed as `${congress}/${type.toLowerCase()}/${number}` to match the existing sponsor row format (e.g. `119/hr/3223`). **Confirmed** on the existing data: `john-cornyn`'s sponsored row `119/s/4316` matches this pattern.
- `sponsor_role = 'cosponsor'`
- `introduced_at` = `introducedDate.slice(0, 10)`
- `source_url` derived from congress + type + number (same logic as sponsored fetcher)

### Caveats

- Cosponsor backfill multiplies the bills table size (~10–50× current). Watch DuckDB write performance.
- A member can both sponsor and cosponsor the same bill in extreme rare cases (committee substitution); composite key `(member_id, bill_id)` will treat sponsor as canonical via insert order. Run sponsored backfill first, cosponsored after, with `ON CONFLICT DO NOTHING` so sponsor rows aren't downgraded.

---

## Congress.gov API — Sponsored Legislation (authoritative sponsor rows + inline policyArea)

**Endpoint:** `GET /member/{bioguide}/sponsored-legislation?format=json&limit={n}&offset={n}`
Probe verified live 2026-05-25 on `mike-turner` (`bioguide=T000463`).

Replaces the LLM-fabricated sponsor list (Grok-3 researcher → `load-from-tasks.ts`) with primary-source data, and — critically — carries `policyArea.name` **inline in the list response**, so the donor-sector detector's sponsored bills get a policy area with **no per-bill `/subjects` call**.

Sample items (`d.sponsoredLegislation[]`, `d.pagination.count = 192` for Turner):

```json
{
  "congress": 119,
  "introducedDate": "2026-04-09",
  "latestAction": { "actionDate": "2026-04-09", "text": "Referred to the House Committee on Ways and Means." },
  "number": "8242",
  "policyArea": { "name": "Taxation" },
  "title": "Health Coverage Tax Credit Reauthorization Act of 2026",
  "type": "HR",
  "url": "https://api.congress.gov/v3/bill/119/hr/8242?format=json"
}
```

### Mapping (dual-write — note the two id formats)

- **`bills` table** — `bill_id = ${congress}/${type.toLowerCase()}/${number}` (SLASH, e.g. `119/hr/8242`), `sponsor_role='sponsor'`, `ON CONFLICT DO UPDATE` (authoritative data wins over the LLM row).
- **`bill_subjects` table** — `bill_id = ${congress}-${type.toLowerCase()}-${number}` (DASH, e.g. `119-hr-8242`), stored as `(bill_id, policy_area=name, subject=name)`. The detector joins `bill_subjects bs ON bs.bill_id = REPLACE(b.bill_id,'/','-')`, so the dash form is required for the join to land. Mirrors `load-bill-subjects.ts` policyArea-as-subject fallback.

### Caveats / traps

- `type` is UPPERCASE in the payload (`"HR"`, `"HRES"`) — must `.toLowerCase()`.
- `policyArea.name` is often `null` for very recently introduced bills (CRS hasn't classified them yet). When null: still upsert the `bills` row, but write NO `bill_subjects` row (no policy area = nothing to match).
- Granular `legislativeSubjects` are NOT in the list response — only the single `policyArea`. Per-bill `/subjects` (or GPO BILLSTATUS bulk) is deferred (Tier 2).
- Sponsored set is disjoint from cosponsored set (you don't cosponsor your own bill), so `DO UPDATE` here cannot clobber authoritative cosponsor rows.
- **Durability:** `load-from-tasks.ts` uses `INSERT OR REPLACE INTO bills`, which re-fabricates sponsor rows from LLM data. This loader MUST run **after** `load-from-tasks` in any sequence — it is a post-research enrichment loader.

---

## House Clerk — Financial Disclosure Bulk Data (key-free, no rate limit)

**Base URL:** `https://disclosures-clerk.house.gov/`
**Auth:** none. **Rate limit:** none (static files, plain HTTP — `wget`/`fetch`, no browser).
**Probed:** 2026-05-17. Frozen artifacts already on disk at `pfd-cache/index/{2022..2026}FD.{zip,txt,xml}` (downloaded 2026-04-17 → 2026-04-27; this probe re-confirmed structure, did not re-download).

### Source 1 — Annual disclosure index ZIP

- **URL pattern:** `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{YEAR}FD.zip`
  (the Clerk also publishes a parallel `public_disc/ptr-pdfs/` tree for the individual filing PDFs — see Source 2.)
- ZIP contains exactly two files, same data twice: `{YEAR}FD.txt` (tab-separated) and `{YEAR}FD.xml`.
- **TXT columns (tab-delimited, header row present):**
  `Prefix  Last  First  Suffix  FilingType  StateDst  Year  FilingDate  DocID`
- **XML:** `<FinancialDisclosure>` → repeated `<Member>` with children
  `<Prefix> <Last> <First> <Suffix> <FilingType> <StateDst> <Year> <FilingDate> <DocID>`.
- `StateDst` = 2-letter state + district digits, e.g. `TX31`, `GA14`, `NC12`. Senate-style/no-district rows would lack digits (House-only corpus here).
- `FilingDate` is `M/D/YYYY` (US, non-zero-padded). `Year` is the disclosure/coverage year, not the filing year — a 2024 `Year` row can carry a 2025 `FilingDate` (late/amended).
- `DocID` (e.g. `10060658`) is the key that addresses the actual filing PDF.

**FilingType codes (observed counts, 2024FD.txt, 2618 rows):**
`P`=Periodic Transaction Report (the trade filings load-pfd cares about) ×451 · `O`=Annual report ×372 · `C`=Candidate ×657 · `A`=Amendment ×82 · `X`=Extension ×454 · `D` ×70 · `H` ×66 · `W` ×66 · `B`/`E`/`G`/`T` rare. (One spurious `FilingType` count = the header line.) **For trade analysis, filter to `FilingType == 'P'`.**

### Source 2 — Individual filing PDF

- **URL pattern:** `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{YEAR}/{DocID}.pdf`
  (this exact pattern is already hard-coded as the `source_url` in `db/load-pfd.ts:163`.)
- The PDF is the scanned/native PTR. Parsing PDF → the canonical transaction JSON is the existing job of `skills/pfd-fetcher/extract.ts` (already in the tree, not re-probed here). Cached PDFs + extracted `.txt` + `.json` already exist under `pfd-cache/{YEAR}/`.

### Frozen sample

`pfd-cache/index/2024FD.txt` header + first data rows:
```
Prefix	Last	First	Suffix	FilingType	StateDst	Year	FilingDate	DocID
	Abel	William		C	TX31	2024	5/12/2024	10060658
	Abolfazli	Maryam.		C	TN05	2024	5/13/2024	10060479
Mr.	Aboujaoude	Rock Adel	Jr.	C	FL12	2024	5/14/2024	10061019
Hon.	Adams	Alma Shealey		O	NC12	2024	4/29/2025	10066961
```

Canonical extracted shape (`pfd-cache/2024/greene-marjorie-taylor-mrs-20025337.json`, the contract `db/load-pfd.ts` consumes) — note `filingId` here is an internal extract id, **not** the bulk-index `DocID`:
```json
{
  "filingId": "20025337",
  "source": "house-clerk-ptr",
  "filer": { "name": "Hon. Marjorie Taylor Mrs Greene", "status": "Member", "stateDistrict": "GA14" },
  "signedAt": "2024-06-27",
  "transactions": [
    { "holder": "self", "asset": "ASML Holding N.V. - New York Registry Shares",
      "ticker": "ASML", "assetType": "ST", "subholding": null, "location": null,
      "type": "purchase", "date": "2024-06-24", "notificationDate": "2024-06-24",
      "amountBand": "$1,001 - $15,000", "filingStatus": "New", "description": "" }
  ]
}
```

### Caveats / traps

- **`filingId` mismatch.** The bulk index `DocID` (8 digits, e.g. `10060658`) is *not* the `filingId` in the extracted JSON (e.g. `20025337`). `load-pfd.ts` keys `DELETE`/`INSERT` on the JSON `filingId` and builds its `source_url` from it. The organizer must reconcile DocID → extract `filingId` (or `extract.ts` must emit DocID). Confirm against `extract.ts` before wiring the organizer.
- **`P` only for trades.** Loading `O`/`C` filings into `pfd_transactions` would be wrong — annual reports are holdings, not transactions.
- `filer.name` in the extract is mangled ("Hon. Marjorie Taylor Mrs Greene" — title + suffix folded into the name). `load-pfd.ts:stripTitles` + last-name match absorb this, but the bulk index has clean `Last`/`First`/`Prefix`/`Suffix` columns — prefer those for member resolution if the organizer builds the filer record.
- Bulk index is House-only. Senate PTRs come from `efdsearch.senate.gov` (JS/terms-gated — the one place browser-harness is justified; separate source, not probed here).

---

## Relevance edge — bill→topic + ticker→sector (verified 2026-05-23)

Substrate for the trade-vote *nexus* loop. Proximity alone is noise (basket
traders coincide with every same-day vote). The loop needs a deterministic
relevance edge so we only surface trades whose company/sector intersects the
bill's actual subject. Two free, deterministic, sourced inputs + a static
crosswalk. NO LLM in the edge.

### Source A — Congress.gov bill subjects + policy area

**Endpoint:** `GET /v3/bill/{congress}/{type}/{number}/subjects?format=json&api_key={KEY}&limit=250`
**Auth:** `CONGRESS_API_KEY` (same key as summaries). **Rate limit:** 5,000/hr.

Frozen sample — `119-hr-2071` (Save Our Shrimpers Act):
```json
{
  "subjects": {
    "policyArea": { "name": "Foreign Trade and International Finance" },
    "legislativeSubjects": [
      { "name": "Agricultural trade" }, { "name": "Congressional oversight" },
      { "name": "Government information and archives" },
      { "name": "Government studies and investigations" },
      { "name": "International monetary system and foreign exchange" },
      { "name": "Seafood" }
    ]
  }
}
```
- `policyArea.name` — single top-level category (~32 controlled values).
- `legislativeSubjects[].name` — granular controlled tags (the join surface).
- Only fetch for the distinct `bill_id`s referenced by votes (now dense after
  the `--load-bills` backfill — ~hundreds, not all of Congress).

### Source B — SEC ticker→sector (SIC)

**Two key-free calls (require a descriptive User-Agent):**
1. `GET https://www.sec.gov/files/company_tickers.json` → ticker→CIK map (10,371 tickers; we need only the ~108 distinct traded tickers).
2. `GET https://data.sec.gov/submissions/CIK{cik:010d}.json` → `sic` + `sicDescription`.

Frozen sample — `AAPL` → CIK `320193` → `sic: 3571`, `sicDescription: "Electronic Computers"`.
- SIC 4-digit → 2-digit major group → sector. Deterministic.
- Only 108 lookups; cache to `pfd-cache/` and re-run rarely.

### The crosswalk (the only judgment, static + auditable)

SIC sector → Congress.gov `policyArea`/`legislativeSubject` is NOT 1:1. Three
hand-curated, version-controlled tables (seeded by `db/load-sector-crosswalk.ts`,
NO LLM): `sic_theme` (SIC→industry theme), `theme_bill_match` (theme→bill match
rules), and `ticker_theme_override` (per-ticker theme fixes).

**Policy-area-primary matching (refined 2026-05-23).** A bill's single editorial
`policyArea` is the trusted relevance signal. Granular `legislativeSubject` tags
are deliberately NOT used as a broad surface — they are both over-broad and
sometimes wrong (see traps). `theme_bill_match.subject_pattern` rules are kept
only as a *narrow, high-specificity* supplement (unambiguous terms like
`%semiconductor%`, `%electric power%`, `%motor vehicle%` that surface real
loops — e.g. VST → POWER Act electrical-resilience). Catch-all substrings were
pruned (`%technolog%` alone had fired on 162 unrelated bills). Dangerous broad
substrings are banned: `%ship%` (relationship), `%securit%` (national
security), `%property%` (intellectual property), `%drug%` (drug enforcement);
low-discrimination ones dropped entirely (`%insurance%`/`%banking%` fired on
gun/sanctions/disaster bills — Banks & Finance is now policy-area-only).
- **Subject-pattern matches are gated by a subject-count guard:** a subject
  match counts only when the bill carries ≤ 25 legislative subjects. Broad
  vehicles tag dozens of incidental subjects (Fiscal Responsibility Act: 160,
  Limit Save Grow: 111), so any single tag is meaningless there; focused bills
  carry few (POWER Act: 1, Critical Mineral Act: 3). policy_area matches are
  exempt from the guard (CHIPS has 49 tags but matches its editorial policy_area).
- **Media & Telecom carries NO `policy_area` rule on purpose:** it shares the
  coarse `"Science, Technology, Communications"` area with Tech, so matching that
  area would put cable/broadcast names (WBD) on semiconductor bills (CHIPS). It
  matches specific broadcast/telecom subjects only.
- **`ticker_theme_override`:** SIC 7389 "Business Services, NEC" is a grab-bag —
  it holds card networks (V, PYPL, WEX → `Payments`) and an e-commerce
  marketplace (MELI → `Retail & Consumer`) alongside genuine tech-services
  (AKAM, left as Tech). The override pins the misfiled ones without mutating
  SEC-sourced `ticker_sectors`.

Effect: nexus rows 33,853 → 6,467; Tech bills 164 → 29; Visa 156 → 30 bills
(all finance/payments-relevant); egregious false matches gone (NVDA↔gun bill,
Goldman↔Safer Communities, WBD↔CHIPS, NDAA omnibus); flagships preserved
(Pelosi→NVDA→CHIPS, VST→POWER Act). Rendered as the ranked feed at `site/nexus.html`.

### Caveats / traps
- A trade matches a bill only if the ticker's sector intersects the bill's
  subjects. For a basket trader (MTG) on an off-topic bill this correctly
  yields ZERO — that's the point.
- **Amended vehicles carry the WRONG granular subjects.** HR 4346 (CHIPS &
  Science Act) was originally a Legislative-Branch Appropriations bill; its
  `legislativeSubjects` are still the original shell's ("Architect of the
  Capitol", "Arkansas", "Terrorism") with NO "semiconductor". Only its
  `policyArea` ("Science, Technology, Communications") reflects the final
  content. This is the core reason matching is policy-area-primary, not
  subject-based — the flagship loop matches via policyArea alone.
- Omnibus / appropriations / budget resolutions / H.Res "rules" have broad or
  no specific subjects — excluded as bill vehicles by `v_trade_bill_nexus`
  title filters (`%relief act%`, `%reconciliation%`, `%omnibus%`, `%national
  defense authorization%`, `%rescissions act%`, plus a `LENGTH(bill_title) >= 6`
  guard against degenerate stub titles like "of"). The subject-count guard above
  is the generic backstop for any other omnibus vehicle.
- ETFs/index funds have no single SIC — leave sector NULL (already excluded by
  `v_suspicious_trades` asset-type filter).

## OpenSecrets — per-member donor industry breakdown (verified 2026-05-24)

Powers the donor side of Pattern Discovery v2 (`donor-sector-vote-alignment`).
OpenSecrets publishes each member's campaign money already classified into a
3-tier taxonomy (Sector → Industry → Category). We ingest the **Industry** level
and crosswalk it to the existing economic-sector themes (`donor_industry_theme`).

### Access — NOT the API, NOT the widget endpoint
- The OpenSecrets **API** is key-gated and we have no key; skipped.
- The data-bearing widget endpoint
  `/widgets/industries_contribution_details_widget?cid=&cycle=&mpid=...` is
  **hard-blocked by Cloudflare WAF** (HTTP 403 at the Chrome level, regardless of
  a valid `_app_session` cookie). Do NOT target it.
- **What works:** the normal member profile page
  `https://www.opensecrets.org/profiles/{slug}/us_congress/industries?mpid={mpid}&cycle={cycle}`
  is not WAF-gated and embeds the fully rendered industries table (the lazy
  turbo-frame arrives `complete`). Include `&cycle=` (else defaults to latest).
- OpenSecrets is behind Cloudflare bot protection, so plain HTTP 403s — the page
  must be fetched with a real browser (browser-harness). This makes the harvest
  a browser step, NOT a headless/cron loader. Raw HTML is frozen to
  `pfd-cache/opensecrets/<cycle>/<member_id>.html`; `db/load-opensecrets.ts` is a
  pure parser over those files (cron-safe, idempotent).

### Resolving a member → OpenSecrets CID + mpid (no API key)
1. slug = lowercase name, spaces→hyphens, strip apostrophes/periods.
2. GET `/members-of-congress/{slug}/summary` (follow redirect).
3. CID from `og:image`: `congress-members/photos/([Nn]\d{8})\.jpg`.
4. mpid from the final URL: `mpid=(\d+)`.
Common-name collisions (e.g. "Mike Johnson") may need state disambiguation.

### Page structure (the parser contract)
DataTables nested-child layout: each sector is a top-level `<tr>` (sector name +
3 money cells) whose hidden cell holds a nested `<table>` of its industries, each
a `[name, total, individuals, pacs]` `<tr>`. The parser walks every row's cells
in groups of `[label, $, $, $]`; a leading group whose label is one of the 13
sector names sets the current sector and is **skipped** (its dollars equal the
sum of its industries — storing it would double count). Deduped by industry name.

### Crosswalk to themes (the only judgment — static, auditable)
`donor_industry_theme(industry_pattern, theme)` maps an ILIKE pattern on the
industry name to one of the 12 economic-sector themes (same set as
`theme_bill_match`). Seeded by `db/load-sector-crosswalk.ts`. Industries with no
pattern (Labor, Ideology, Lawyers, Retired, Education, public-sector,
single-issue) are deliberately UNMAPPED — they carry no tradable-industry theme,
so they sit outside the donor↔sponsorship lens and are excluded from
`v_member_donor_theme`. v1 patterns — expect eyeball-tuning as more members load.

### Caveats / traps
- The widget endpoint worked during the first probe but is now WAF-blocked; the
  profile page is the stable target.
- The profile page defaults to the latest cycle when `&cycle=` is omitted — a
  page saved without it is mislabeled (e.g. 2026 data in a `2024/` file).
- Domain-scraping mechanics live in
  `~/Developer/browser-harness/agent-workspace/domain-skills/opensecrets/`.

---

## USAspending API — District federal contract awards

**Base URL:** `https://api.usaspending.gov/api/v2`
**Auth:** none. No documented hard rate limit — still cache every response and page politely.
**Probe date:** 2026-07-15. Frozen artifacts: `pfd-cache/usaspending-probe-2026-07-15/`
**Probe target:** NJ-05 (Gottheimer), CY2023, contract award types A/B/C/D.

### Endpoint 1 — Itemized awards for a district

`POST /search/spending_by_award/`

```json
{
  "filters": {
    "award_type_codes": ["A","B","C","D"],
    "place_of_performance_locations": [{"country":"USA","state":"NJ","district_current":"05"}],
    "time_period": [{"start_date":"2023-01-01","end_date":"2023-12-31"}]
  },
  "fields": ["Award ID","Recipient Name","Award Amount","Awarding Agency",
             "Start Date","End Date","Description","naics_code","naics_description"],
  "sort": "Award Amount", "order": "desc", "limit": 25, "page": 1
}
```

Sample frozen at `spending_by_award_nj05_2023.json` (25 awards; top = PsychoGenics
$45.9M HHS R&D, HydroGeoLogic $15.5M DoD Maywood FUSRAP remediation). Response
carries `page_metadata.hasNext` for pagination and each award a
`generated_internal_id` (stable key, e.g. `CONT_AWD_75N95019F00088_7529_…`).

### Endpoint 2 — NAICS rollup for a district (detector substrate)

`POST /search/spending_by_category/naics/` — same `filters` object, returns
aggregated dollars per NAICS code. Sample frozen at
`spending_by_naics_nj05_2023.json` (NJ-05 2023 top: 423450 medical wholesalers
$43.0M, 336413 aircraft parts $28.8M, 541715 phys/eng/life R&D $18.8M).
`spending_level` is `"transactions"` — transaction dollars in the period, not
award ceilings; do not mix the two levels in one metric.

### Caveats / traps
- **Two district fields:** `district_current` (today's map) vs
  `district_original` (map at award time). Redistricting moves awards between
  them — pick ONE per analysis and state it. For "money into the member's
  district while they held the seat", `district_original` is the honest filter;
  the probe used `district_current`.
- **Place-of-performance is FPDS-recorded, not description-derived:** the NJ-05
  probe returned an Arcadis superfund award whose description says
  Camden/Gloucester City (NJ-01 territory). The filter is working off the
  recorded PoP district; expect a tail of such mismatches — never re-derive
  location from description text.
- **Search window floor:** time_period earliest is 2007-10-01 (API message);
  older data only via bulk download endpoints.
- **Award Amount ≠ period spend:** `spending_by_award` returns total award
  obligation (multi-year, e.g. the $45.9M award started 2019); the time_period
  filter selects awards *active/transacting* in the window, not dollars scoped
  to it. Use Endpoint 2 for period-scoped dollars.
- **NAICS ≠ SIC:** the trade side maps tickers via `sic_theme`; a separate
  NAICS→theme crosswalk (same 12 themes, same collision-exclusivity rule as
  `donor_industry_theme` — see `lib/donor-crosswalk.test.ts`) is required
  before the detector can compare district contracts to themes.

### district_current vs district_original — measured delta (probe 2026-07-16)

GA-14 CY2023 NAICS rollup queried with both fields (GA redrew its map effective
the 2024 cycle, so CY2023 awards diverge). Frozen at
`spending_by_naics_ga14_2023_district_{current,original}.json`.

- `district_current`: top-10 = $27.1M (Aircraft Parts $11.3M, Facilities
  Support $4.2M, Poultry $4.1M, Phys/Eng R&D $2.6M, Bldg Construction $1.6M,
  Architectural $1.0M …)
- `district_original`: top-10 = $23.2M (Aircraft Parts $11.3M, Poultry $4.1M,
  Facilities Support $1.6M, Nursing Care $1.5M, Bldg Construction $1.4M,
  Aluminum Mfg $1.1M …)

$3.9M top-10 delta; R&D and Architectural vanish under the original map,
Nursing Care and Aluminum Mfg appear. The field choice materially changes the
theme mix — the detector uses `district_original` (map at award time; see
`docs/2026-07-15-district-contracts-detector.md`).
