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
