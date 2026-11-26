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

### Endpoint 3 — Recipient rollup for a district (recipient-detector substrate)

`POST /search/spending_by_category/recipient/` — same `filters` object as the
NAICS rollup (Endpoint 2), `limit` up to 100. Returns aggregated dollars per
recipient: `results[]` rows carry `name`, `amount`, `recipient_id`
(hash-suffixed id, `…-C` child / `…-R` recipient). Probe (2026-07-17): 4
districts (NJ-05, FL-23, CA-17, OH-10), top-100 recipients each, CY2023–25,
`district_original` filter. Frozen at
`pfd-cache/usaspending-recipient-probe-2026-07-17/`
(`recipient_probe_2026-07-17.json` full per-district resolved/unresolved
lists + `probe_recipients.py`; the script's `member_tickers.json` input is a
DB export, not frozen).

### Recipient → parent resolution

`GET /recipient/{recipient_id}/` returns `parent_name`/`parent_uei` (SAM.gov
hierarchy). The source does the hard subsidiary→parent step: HOWMEDICA
OSTEONICS → STRYKER CORPORATION, GE AVIATION → GENERAL ELECTRIC, DB CONTROL
→ HEICO. Probe cost-capped parent lookups to the top-40 unmatched recipients
per district — a full harvest should look up every unmatched recipient.

Full-harvest quirk (2026-07-18): 4 of 21,598 profile fetches 502 **persistently**
(retried across runs and re-probed directly with curl — server-side, not
transient): SUPPLYCORE LLC, NOBLE SUPPLY & LOGISTICS LLC, ASRC FEDERAL
FACILITIES LOGISTICS LLC, NATIONAL INDUSTRIES FOR THE BLIND (all `…-C` ids;
the `…-R` variant 400s). All four are private/nonprofit with no public
ticker, so the missing `parent_name` rows cost zero candidates.

Retry 2026-07-19: SUPPLYCORE LLC recovered (parent = itself, no SEC ticker);
the other 3 still 502. Regenerated worklist byte-identical (427 candidates)
— zero candidate impact confirmed, as predicted. Don't burn more time on
the remaining 3.

### SEC ticker universe

`https://www.sec.gov/files/company_tickers.json` — ~8k issuers as
`{cik_str, ticker, title}`. **Requires a User-Agent header** (e.g.
`CivicLens research <email>`) or the SEC returns 403.

Auto-resolution (normalized-name match, own name then parent name) covered
3%–65% of top-100 recipient dollars by district: NJ-05 38% ($212.6M of
$566.2M), CA-17 65% (incl. $3.9B Lockheed), FL-23 3%, OH-10 8%. One genuine
trade overlap surfaced immediately: NICE SYSTEMS INC ($30.9M NJ-05
contracts) ↔ Gottheimer traded NICE.

### Trap — aggressive suffix-stripping collides

Normalizing away corporate suffixes across ~8k SEC names produces false
positives: ULCC (Frontier *Airlines*) matched FRONTIER TECHNOLOGY INC (a
$306M private defense firm); SCI (funeral homes) matched ENTERPRISE
TECHNOLOGY SOLUTIONS. Auto-matching is a candidate generator only — any
shipped edge needs a hand-curated `recipient_ticker` confirm table (the
sic_theme philosophy). Only member-overlap pairs need curation, so the
curated surface stays small.

## Official House listing and XML — acquisition adapter freeze (2026-10-07)

Frozen primary-source samples and SHA256 receipts: `fixtures/votes/house-acquisition/manifest.json`. The House inventory was captured October 4 EDT (October 5 UTC), covering the fixed inclusive September 26, 2022–September 26, 2026 window. All 249 listing pages were saved; 2,466 published rows reconcile, of which 2,012 are in window. This is published-index completeness at capture time, not complete detail acquisition or historical immutability.

Current listing endpoint: `https://clerk.house.gov/Votes/MemberVotes?CongressNum=119&Session=1st&Page=37`; detail XML: `https://clerk.house.gov/evs/2025/roll001.xml`. Saved samples include the penultimate/final listing pages, 2023 Speaker-election blank statuses, and 2025 roll 1 QUORUM XML. Duplicate top/bottom counters must agree; malformed top pagination actions must not be repaired into evidence, and valid numbered continuation can exist without a Next arrow.

This package validates raw listing correspondence and XML roll metadata and retains every response. It does not normalize voters, infer bill/non-bill classification, implement Senate acquisition, install the pinned collector, integrate loaders or certify the pipeline. The existing ADAPT collector design remains downstream; metadata validation here is an acquisition gate only.

---

## Shared official-vote contract and Senate sample (2026-10-08)

Contract: `docs/official-vote-source-contract-2026-10-08.md` defines canonical identity (§1), coverage window (§2), position normalization (§3), roll resolution / bill classification (§4), the TypeScript API (§5 lib/vote-source.ts, §7 skills/researcher/official-votes.ts) and acquisition-manifest wire format (§6). All agents receive the spec; wire fields are the single source of truth.

`fixtures/votes/manifest.json` (version 1) is the package provenance index, listing official frozen samples with SHA256, HTTP status, bytes, captured date and contract role. The Senate sample `fixtures/votes/official-samples/senate-119-1-roll00001.xml` (URL: `https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_00001.xml`, SHA256 `9d71d78a54c83522babd743209ca4a1a27baa2df122d6830c50ec2aa512ea17e`, captured 2026-09-26, 28,670 bytes) is a Senate document/bill classification and identity sample only — it tests classification of S. 5 cloture as `resolved_bill s 5` and verifies date/congress identity against real Senate XML. It is not used to test position normalization. No frozen official House speaker-election, Senate nomination, or treaty-document XML exists in this package; tests for those record types are SYNTHETIC (labeled in test comments). Evidence logs and test artifacts are in `artifacts/official-votes-contract-2026-10-08/`. Senate acquisition, live HTTP, identity mapping and consumer integration remain downstream.

---

## Official vote runtime — GovTrack replacement samples and pins (2026-10-16)

Frozen before any build against them. The provenance index is
`fixtures/votes/manifest.json` (version 2). Receipts are in the ignored run
directory `artifacts/govtrack-replacement-2026-10-16-0907/source-packet/receipts.json`.
Every request below returned HTTP 200 with no redirect and a complete body.

| Sample | URL | Bytes | SHA256 |
|---|---|---|---|
| House 2025 roll 2, Election of the Speaker | `https://clerk.house.gov/evs/2025/roll002.xml` | 96,942 | `a452d484b1a1219dd61061fe870ab9c3fa087de512b24033ff6db86a2b38c0c4` |
| House 2025 roll 6, H R 29 On Passage | `https://clerk.house.gov/evs/2025/roll006.xml` | 94,574 | `58c75e9750226a49c55712812dc40dda0e67a192e5e18f4a49cbf32e3346ed6e` |
| Senate 119/1 roll 3, S.Amdt. 14 to S. 5 | `https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_00003.xml` | 28,532 | `f099e753743dc41ebd73aeb6164bb69cb1a52033859c1123fc8ea9ffe77fe94d` |
| Senate 119/1 roll 570, S. 2296 passage | `https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_00570.xml` | 29,078 | `abf2ebf8da845213e464d9eec4d258b90394efd90d5c66d915f41cc48da7ae7a` |
| Senate 119/1 roll 655, PN416-9 nomination | `https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_00655.xml` | 104,536 | `edf44e13beb93b2010b809f36cdab594ad159c81a0ad992cdaf8806a07ac66c5` |
| Senate 119/1 vote menu (659 votes) | `https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_119_1.xml` | 419,112 | `bbf37be1e0fe327fb6cd623cc7b2ed56253f5410ec0066831ba5eba605244a0c` |

The menu was captured 2026-09-26 in the reliability-evidence packet. The other
five were captured 2026-10-16 13:11 UTC. Existing samples, House 2025 roll 1
(QUORUM) and Senate 119/1 roll 1, remain valid. No treaty, House amendment or
House journal/adjourn/motion XML is frozen.

**Identity snapshot (current, refreshed 2026-11-24).** The source is
`unitedstates/congress-legislators` at commit
`2b1fe728159fe5f5e145277794106e800719eb50`, CC0. Receipts are in the ignored
run directory `artifacts/2026-11-24-roster-freshness/identity-probe/`
(`source-receipts.json`, and `license-receipt-2b1fe72.json` for the LICENSE).
Every capture below returned HTTP 200 with no redirect and a complete body. The
data captures were fetched on 2026-11-24 between 06:37:21 and 06:37:23 UTC; the
LICENSE was fetched on 2026-11-26 at 12:20:14 UTC. Its bytes are identical to
the LICENSE recorded for `d5af3d2` (CC0 1.0 Universal).

| Capture | URL | Bytes | SHA256 |
|---|---|---|---|
| `legislators-current.yaml` | `https://raw.githubusercontent.com/unitedstates/congress-legislators/2b1fe728159fe5f5e145277794106e800719eb50/legislators-current.yaml` | 1,081,522 | `e805231b79539bf1a0d2ae2fc0698f41a60165ee28ec1f467ba7730884e5e753` |
| `legislators-historical.yaml` | `https://raw.githubusercontent.com/unitedstates/congress-legislators/2b1fe728159fe5f5e145277794106e800719eb50/legislators-historical.yaml` | 8,997,407 | `ea7a1e35e7854418033b155420b522d3cefffc9763b67d7044cde45b8e49a355` |
| previous historical (re-fetch of `d5af3d2`) | `https://raw.githubusercontent.com/unitedstates/congress-legislators/d5af3d2d2490f8c6532c9490b1f47a76cacca699/legislators-historical.yaml` | 8,997,407 | `9641615f336b3113d6f89152e3441128cbdc3f61ccf87c65da3a015076c78c91` |
| Senate, Ohio senators | `https://www.senate.gov/states/OH/senators.htm` | 41,832 | `9e1175dd3efa7083157e8a0f9886a3e31c7dab90082139e8ebe2bd124433d120` |
| Senate, Florida senators | `https://www.senate.gov/states/FL/senators.htm` | 33,019 | `dc926af30f37e94a582fd5a7f0b654a919a0677ec9171146223244242474708c` |
| Ohio Revised Code 3521.02 | `https://codes.ohio.gov/ohio-revised-code/section-3521.02` | 16,561 | `c3de34c3e854f9b82b12a00a432fe7c12fbac233a7fa064999ea0edd931cac74` |
| `LICENSE` | `https://raw.githubusercontent.com/unitedstates/congress-legislators/2b1fe728159fe5f5e145277794106e800719eb50/LICENSE` | 7,048 | `a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499` |

Why it was refreshed: under the previous pin, Jon Husted (H001104/S438) and
Ashley Moody (M001244/S439) both ended on 2026-11-03. Official Senate XML records
both voting from 2026-11-09 through 2026-11-20, so the identity check rejected 23
November Senate rolls. On the captured Senate pages, both senators' service runs
from Jan. 21, 2025 to "Present".

The derived mapping is
`fixtures/votes/identity/legislators-2b1fe72-voting-terms.json`, sha256
`c5c8509eb23ad9e414644810cfef5f160508b87a1cd4a3472ebea2af1fa2fe46`. It holds
895 people and 2,492 terms and uses contract version 2. Against the previous
mapping, only two people differ:

- H001104 Husted: the appointed term now ends `2026-12-15` instead of
  `2026-11-03`. The new end matches Ohio R.C. 3521.02: an appointee serves
  "until the fifteenth day of December" after the next regular state election.
- M001244 Moody: a special-election term runs `2026-11-04` to `2029-01-03`
  after the appointed term ends `2026-11-03`.

The historical YAML is the same length as before but has a different hash. The
re-fetched `d5af3d2` copy matches its original pin, and the 49 changed lines are
start/end dates of terms in 2001 or earlier. All of them fall before the floor
and none reaches the derived mapping.

**As-of limit.** The snapshot is trusted only through `as_of` `2026-11-24`, the
capture date. Identity lookups after that date fail with `date_after_snapshot`
until the pin is refreshed. This limit also bounds Husted's scheduled end date:
it is not used past 2026-11-24, and an early departure would not go undetected
past the capture date. Whether service on 2026-12-15 itself counts (the end date
is inclusive) is therefore not relied on.

**Identity snapshot (superseded).** The original source is
`unitedstates/congress-legislators` at commit
`d5af3d2d2490f8c6532c9490b1f47a76cacca699`, licensed CC0. Its derived mapping
`fixtures/votes/identity/legislators-d5af3d2-voting-terms.json` (sha256
`582e5b3e…ac9fe8`) is kept for the archived validation records that cite it. The
current loader rejects it.

| File | Bytes | SHA256 |
|---|---|---|
| `legislators-current.yaml` | 1,081,187 | `bd32e62b1c89e9585e4ec49df5676563510e9435d779c061ff50139833f73a49` |
| `legislators-historical.yaml` | 8,997,407 | `9641615f336b3113d6f89152e3441128cbdc3f61ccf87c65da3a015076c78c91` |

The historical file comes from the second fetch of the same pin. The first
fetch hit an 8 MiB cap and is kept only as an incomplete `.partial`, which is
never parsed. The raw YAML is not committed. Instead, a deterministic derived
mapping goes under `fixtures/votes/identity/`. It covers every person with a
House/Senate term ending on or after `2019-01-03` and records its own hash and
derivation command. Earlier dates fail closed.

**Collector.** The parser is `unitedstates/congress` at
`8184bcb13160da2389dea4c902de67817db681fc`, archive sha256
`bbd159e67fd0c9c451636eeaad5e1981cd38e148560ad211e3d0f54b437f3ff5`. It was
verified in
`artifacts/official-votes-contract-2026-10-08/collector-runtime-gate-a-1/gate-a/`.
That gate's static check STOPPED on `import utils` in `congress/run.py`. The
cause is a classifier defect: run.py appends its own `tasks/` directory to
sys.path, and this runtime does not use the `run.py` entrypoint. The failed
record is preserved unchanged. The vote path vendored here is in
`tools/congress-collector/vendor/`.

Official vote rows are the House Clerk roll-call XML and the Senate LIS
roll-call XML. GovTrack is no longer an active source for votes or for
vote→bill resolution. Historical GovTrack URLs stored in old artifacts and DB
rows stay readable as legacy provenance only.

## 2026-10-21 House metadata-label compatibility evidence

Captured official `118-2023/h700` uses one `committee` label with literal text
`U.S. House of Representatives`, with no `chamber` label. The complete 95,657-byte
HTTP 200 response has SHA-256
`c53ffef161351875dfa2e8ba69c17b718fb35f0fd2d8606168b8e9ba1589eea9`.
The saved repair-packet XML was checked byte for byte against the original
retained response; its original `malformed_source` receipt remains unchanged.

The original `house-20261021T232934Z-79090ba9` capture finished `incomplete` under
candidate `e3eb78956c36f1a4a275a8907d2f01f10f2ce6ba`: 1,989 complete HTTP 200
responses, 1,366 acquired rolls, 623 metadata-label failures and 477 published
rolls outside the window. Its failed manifest and receipts remain immutable.
The shared plain/exact `chamber`/`committee` helper was subsequently integrated
locally into active Python source before validation and subsequent commit/PR
packaging; the original base commit does not identify this repaired candidate.

A receipt-preserving offline derivative already exists at
`artifacts/full-window-validation-2026-10-21/house-revalidated-committee-1/`.
Its `revalidation.json` records no new HTTP requests and a derived manifest hash
of `6d6d4d44359597c0f54c3aa061d5c3e3099cb3c59cc32355a5aa2efbba1aa99f`.
The existing strict replay at
`artifacts/full-window-validation-2026-10-21/checks/house-offline-replay-1/summary.json`
records a pass across all 1,989 required House rolls for each of `H001047` and
`A000370`, with 3,978 total isolated validation DB rows, 25 `unsupported_record`
roll-resolution outcomes and four evidence-only `outOfServiceListings`.

The review identified gaps in the first derivative's provenance linkage. The
replacement `house-revalidated-committee-2` and `checks/house-offline-replay-2`
now exist: the strict replay passed with hash-bound derivation proof, original
failure states and capture timestamps preserved, and no new House HTTP requests.
The proof also hashes the revalidation utility; original candidate revision remains
null in that proof because the original manifest did not record it. Controller
preflight separately identifies the original base. The controller addressed the
three review findings; no second reviewer approval is claimed.
See [source proof, original hashes and current evidence limits](docs/house-metadata-compatibility-source-2026-10-21.md).
The initial stdlib workbench was preparation; the subsequent replay is bounded
to two targets. Neither is House-wide member coverage or certification.

## 2026-10-21 Senate empty-document procedural-vote evidence

Frozen official `118-2024/s140` (April 17, 2024, motion to adjourn the Court of
Impeachment sine die) has no source `document` or `amendment` elements. The exact
27,960-byte HTTP 200 body is
`fixtures/votes/official-samples/senate-procedural-2024-roll140.xml`, SHA-256
`2ea755a07b4d9115619b17f4bd6d0e1af76032f6441dcde95b4c91aff6f99439`; the adjacent `.receipt.json`
retains the complete original acquisition record and source-manifest digest.
The sample is indexed in `fixtures/votes/manifest.json`; no new HTTP was used.

The Senate source capture already acquired all 1,675 required rolls with complete
HTTP 200 receipts; no revalidation derivative is needed. The original first full
offline replay at `checks/senate-offline-replay-1` under the full-window artifacts
remains failed: twelve `bundle first document mismatch` analysis failures for
`118-2024/s129` through `118-2024/s140`, failed normalization for both targets
`S000033` and `W000817`, and persistence `not_run`. Their captured bridge
projections have `documents: []` and six explicit empty document fields.

The generic fix accepts that empty array only with exactly those six explicit
empty strings; no bill is inferred. Completed `checks/senate-offline-replay-2`
passed all 1,675 rolls, zero bridge/analysis failures, and 1,675 persisted votes
for each target (3,350 isolated rows); the first target remained unchanged after
the second load. The twelve procedural resolutions stay `unsupported_record`
with null bill; one separate roll remains `ambiguity`. The final TypeScript
vote-path suite passed 359/359. See [source receipt, preserved failure and completed
verification](docs/senate-empty-document-source-2026-10-21.md). These two-target
results are not all-member certification or release readiness.
