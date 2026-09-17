Frozen DB hash unchanged, no WAL created. Evidence collection complete.

## s1 Evidence (bounded; not a certification verdict)

### Boundaries honored
Frozen DB `data/civiclens.duckdb` = `a766c891…a38b` before and after my reads (matches `s1/setup.json dbInitialSha256`); no WAL created. All DB access via `DuckDBInstance.create(':memory:')` + `ATTACH … AS frozen (READ_ONLY)`; no `getDb()`, no target-DB access, no pipelines/renders/scoring/network/commits/agents. All Bash was read-only (no redirection, no file writes).

### A. Control-page attribution — exact

Control `josh-gottheimer.html`: reference `634979dc…` (8,447,562 B) vs s1 `739d2cc0…` (8,447,705 B). Split into 15 regions (prefix + 13 registry IDs from `render/member-sections.ts:5-9` + suffix). Note: `sec-receipts` carries its id on a `<section class="receipts">` wrapper, not an `<h2>`; anchors split at the owning tag start. All 13 IDs present in registry order in both files.

**Byte preservation asserted:** region concatenation === full file, both sides (8,416,531 / 8,416,674 chars).
**Normalization:** only `(?<= · generated )\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z(?=</div>)` — exactly one occurrence per file (control `2026-09-16 08:55Z`, s1 `2026-09-16 08:56Z`).

| region | verdict | Δbytes |
|---|---|---|
| prefix, sec-identity, sec-glance, sec-receipts, sec-coherence, sec-money-votes, sec-timeline, sec-trades, sec-donors, sec-revolving, sec-outside-spending, sec-patterns, sec-cosponsor, suffix | **IDENTICAL** (14/15) | 0 each |
| **sec-peers** | **DIFFERENT** | **+143** |

`changed_regions = ["sec-peers"]`; every other region byte-identical after timestamp normalization. Verified, not assumed.

**Exact sec-peers delta** — pure insertion, **0 bytes removed**, common prefix 3,636 / suffix 1,603:
```
tina-smith.html">Tina Smith</a></td>\n    <td class="num">2</td>\n    <td class="num">$30.0K</td>\n  </tr>\n  <tr>\n    <td><a class="member" href="
```
One `<tr>` at rendered index 23 of 35 (control had 34 rows; `render-*.json` output strings agree: `34peers` → `35peers`). Position sits between Elizabeth Warren (2, $43.0K) and Susan Collins (2, $28.9K) — exactly where `ORDER BY shared_count DESC, combined_amount DESC, peer_id ASC` (`db/queries/shared-donors.sql:22`) places it.

### B. The two shared donor joins — concrete rows

`frozen.donors` schema: `member_id, donor_name, donor_canonical, donor_type, amount, latest_date, cycles, source, source_url, confidence, fetched_at`. **No `donor_id` column** — the join key is `donor_canonical` (per `shared-donors.sql:17`). Frozen DB: josh-gottheimer = 99 rows, tina-smith = **0 rows** (absent pre-s1), 57 members, 4,443 donors total. No duplicate canonicals on either side, so `COUNT(*)` = distinct shared donors.

Joining those 99 immutable Josh rows to the 100 delta-added `tina-smith` donor rows on `donor_canonical`:

| donor_canonical | josh.amount | tina.amount | a.amount+b.amount |
|---|---|---|---|
| INTERNATIONAL ASSOCIATION OF FIREFIGHTERS INTERESTED IN REGISTRATION AND EDUCATION PAC | 10000 | 5000 | 15000 |
| NEW YORK LIFE INSURANCE COMPANY POLITICAL ACTION COMMITTEE | 10000 | 5000 | 15000 |

`shared_count = 2` → rendered `2`. `combined_amount = SUM(a.amount+b.amount) = 30000` → `fmtMoney(30000)` = `$${(30000/1000).toFixed(1)}K` = **`$30.0K`** (`render/build.ts:211-217`). Matches the inserted row exactly.

### C. All 20 Senate transactions — source → loaded

Mapping taken from `db/load-senate-ptr.ts:205-223`. All 11 frozen source hashes re-verified against `s1/setup.json`: **11/11 OK, 0 mismatches**; also consistent with `frozen-render-check.json` `inputsBefore`/`inputsAfter` (`identicalInputs: true`, `equal: true`).

Source counts: **9 filings / 20 rows**; per-year **2023: 2/6, 2024: 2/3, 2025: 2/3, 2026: 3/8** — matches the expected split exactly. Receipt `_search-receipts/S001203.json`: `status=success`, `filingCount=9`, its 9 `filingIds` set-equal to the cached filing IDs.

Delta `pfd_transactions`: 20 added, 0 removed, `otherMemberRows=[]`, all `member_id='tina-smith'`.

**14 fields × 20 rows = 280 checks, 0 mismatches**, 0 loaded rows without a source row, 0 source rows without a loaded row. `tx_index` zero-based and contiguous within every filing (`7c840533:0,1,2` · `de3cd462:0,1,2` · `c337b418:0` · `cf08c60c:0,1` · `82093483:0` · `ec33423d:0,1` · `3f315067:0,1,2,3` · `5a00d807:0,1` · `a8f2bab8:0,1`).

| # | filing#tx | yr | owner | ticker | type | date | band |
|---|---|---|---|---|---|---|---|
| 0 | 7c840533#0 | 2023 | spouse | CSII | sale | 2023-04-05 | $50,001 - $100,000 |
| 1 | 7c840533#1 | 2023 | spouse | MDT | sale | 2023-04-05 | $100,001 - $250,000 |
| 2 | 7c840533#2 | 2023 | spouse | CSII | sale | 2023-04-05 | $50,001 - $100,000 |
| 3 | de3cd462#0 | 2023 | spouse | AORT | purchase | 2023-11-16 | $50,001 - $100,000 |
| 4 | de3cd462#1 | 2023 | spouse | TCMD | purchase | 2023-11-08 | $100,001 - $250,000 |
| 5 | de3cd462#2 | 2023 | spouse | AORT | purchase | 2023-11-10 | $50,001 - $100,000 |
| 6 | c337b418#0 | 2024 | spouse | TCMD | purchase | 2024-11-12 | $50,001 - $100,000 |
| 7 | cf08c60c#0 | 2024 | spouse | PODD | sale-partial | 2024-04-04 | $50,001 - $100,000 |
| 8 | cf08c60c#1 | 2024 | spouse | NEE | sale-partial | 2024-04-04 | $100,001 - $250,000 |
| 9 | 82093483#0 | 2025 | spouse | HBAN | sale | 2025-11-21 | $100,001 - $250,000 |
| 10 | ec33423d#0 | 2025 | spouse | PEP | sale | 2025-02-11 | $100,001 - $250,000 |
| 11 | ec33423d#1 | 2025 | spouse | GIS | sale | 2025-02-11 | $100,001 - $250,000 |
| 12 | 3f315067#0 | 2026 | spouse | PODD | sale | 2026-05-07 | $100,001 - $250,000 |
| 13 | 3f315067#1 | 2026 | spouse | DXCM | sale | 2026-05-07 | $100,001 - $250,000 |
| 14 | 3f315067#2 | 2026 | spouse | PODD | sale-partial | 2026-04-29 | $100,001 - $250,000 |
| 15 | 3f315067#3 | 2026 | spouse | DXCM | sale-partial | 2026-04-29 | $100,001 - $250,000 |
| 16 | 5a00d807#0 | 2026 | spouse | MMM | sale | 2026-03-31 | $50,001 - $100,000 |
| 17 | 5a00d807#1 | 2026 | spouse | BRK.B | sale | 2026-03-31 | $100,001 - $250,000 |
| 18 | a8f2bab8#0 | 2026 | spouse | BRK.B | sale-partial | 2026-01-27 | $100,001 - $250,000 |
| 19 | a8f2bab8#1 | 2026 | spouse | **NULL** | sale | 2026-01-27 | $50,001 - $100,000 |

Null preserved as NULL (not `""`) in the one row that has it (a8f2bab8#1). `asset`, `assetType`, `comment` and `ptrUrl→source_url` matched on every row (included in the 280 checks). Loader-constant columns are uniform and consistent with `load-senate-ptr.ts`: `filing_status='New'`, `match_method='exact_senate_lastname'`, `match_confidence=1`, and `sub_account`/`location`/`notification_date`/`filer_state_district` all NULL (the loader hardcodes these; they are not source-derived).

### D. Cross-member isolation and control-run conditions
`crossMemberRows = 0`; `parkedTimingRows = []`; every changed table has `removed=0` and `otherMemberRows=[]` (bill_subjects 287, bill_summaries 10, bills 2997, committees 13, donors 100, members 1, pfd_transactions 20, pipeline_runs 1, super_pac_ie 3, votes 1700 added).

Control FEC cache byte-identical across both worktrees (`faccf341…cab9`). Theme artifact: control-reference has **no** `pipeline/artifacts/` directory; s1 has only `tina-smith.theme-gaps.json` — no `josh-gottheimer` theme artifact on either side (ABSENT both sides, as `control/setup.json` records). Serial renders confirmed non-overlapping: control 08:55:14→08:55:39, then s1 08:55:39→08:56:03; DB hashes unchanged on both (`a766c891…` / `3fbf0882…`), `walBefore=walAfter=null`. The earlier overlapped pair (08:54:06/08:54:21) is recorded and superseded in `control/order-deviation.json`.

### Stated boundary
**No original EFDS HTML exists in the frozen cache.** The senate-ptr-cache contains 0 non-JSON files and no `rawHtml`/`sourceHtml` field inside any filing JSON. Section C therefore verifies *parsed-source-JSON → loaded-row* fidelity only. It is **not** an independent inspection of the original Senate filing tables, and does not rule out a parser-level error upstream of the frozen JSON.

### Blockers
None for the s1 scope as specified. This is evidence collection for s1 only — no six-stratum certification claim is made.
