# s3 evidence analysis — Cleo Fields (F000110, House)

Snapshot before subsequent independent checks. Stage-absence and stop-rule conclusions below are superseded by `../closeout-review.md`, `../conductor-continuation.md`, `../s3/independent-checks.json`, and `../s3/source-to-loaded.json`. The source-side inspection remains useful; the overall bill-stage failure remains unresolved.

Analyst: Claude (read-only evidence analyst). Candidate `56efb3bc4308206d406553162cd39274df0efc8b`.
This is **evidence analysis, not the final independent certification review**.

## State asserted before writing

Analyst cwd `/home/captainanime/Developer/civiclens-track-b-trials/closeout-2026-09-14-inputs`; central HEAD `56efb3bc…f8b`; central `git status --porcelain` = the 3 preexisting modified docs + untracked `replays-v2/`, unchanged by this analysis; frozen input DB `a766c8917a0e6b42ddc488758eb0b1a66abb37d24c873a74b4cc9d6fd7e4a38b` identical before and after all reads, no WAL. DB access was in-memory + `ATTACH … (READ_ONLY)` only. No pipeline, loader, extractor, render, scoring, test, OCR, install, network, commit, or git-state change.

## Outcome: the stratum failed closed on an external source outage

`s3/external-failure.json` records `outcome: "failed"`, `classification: "external source unavailability, not an implementation defect"` at stage `bills (--load-bills --bioguide F000110 --api-pass)`.

| attempt | evidence | exit | observed |
|---|---|---|---|
| 1 | `s3/bills.json` | **1** | Pass 1 regex backfill 391 filled / 309 unparseable / 700 scanned; Pass 2 GovTrack API 50 calls, 49 resolved, then `Fatal: fetch failed` |
| 2 (single authorized manual rerun) | `s3/bills-rerun-1.json` | **1** | Pass 1 0 filled / 254 unparseable / 254 scanned; Pass 2 `Fatal: fetch failed` |

- **Failed closed, not silently partial.** Both attempts exited nonzero with `Fatal:`; neither published an incomplete vote→bill linkage.
- **DB integrity across both failures.** `dbBefore == dbAfter == e2b4c3cfdd4df11eeb85a26b5a881a89620ac16ed3cdf289c27488b847582c39` in `bills.json`, in `bills-rerun-1.json`, and in the `dbIntegrity` record. The main DB file hash is unchanged across both failed attempts.
- **Rerun policy respected.** `rerunPolicy`: exactly one manual rerun used; no ad hoc retry loop added; member, inputs, and acceptance rule unchanged between attempts (both commands are byte-identical: `agents/pipeline.ts --load-bills --bioguide F000110 --api-pass`).
- **Source-side, not local.** The recorded read-only reachability probe: `https://www.govtrack.us/` HTTP 200 in 0.271 s; `https://www.govtrack.us/api/v2/vote?limit=1` no response, curl code 000, timed out at 25 s; `https://api.congress.gov/` HTTP 200. An unrelated upstream responding normally while GovTrack's site is up but its `/api/v2` endpoint is unreachable is consistent with source-side unavailability rather than local network loss or a candidate defect.

**Correctly classified.** A transient external failure is **not** a source-backed limitation and cannot close the stratum. s3 is **not** a pass, **not** `verified-empty`, and **not** `needs_manual_formatting`. The worker's own record states this explicitly (`notASourceBoundLimitation`). I concur: nothing in the available evidence supports substituting a historical pass.

## Stages that did complete (recorded, not sufficient to close the stratum)

`s3/setup.json`: candidate `56efb3bc…f8b` (matches), `dbInitialSha256` `a766c891…a38b` (matches frozen input DB). **All 47 declared sources verified present and hash-matching by me — 0 missing, 0 mismatched** (43 non-index + 4 index files).

**Canonical identity** (`s3/identity.json`: slug `cleo-fields`, bioguide `F000110`, chamber `house`) independently confirmed from the frozen `legislators-current.yaml`: `bioguide: F000110`, `official_full: Cleo Fields`, current term `type: rep`, `2025-01-03` → `2027-01-03`, `state: LA`, `district: 6` (plus two historical LA-04 terms 1993–1997). House chamber ⇒ `--load-pfd` branch; no Senate loader appears in any s3 record. All commands member-scoped (`--bioguide F000110` / `cleo-fields`), never `--all`.

| stage | evidence | exit | result |
|---|---|---|---|
| baseline-before | `s3/baseline-before.json` | 0 | ok; DB `a766c891…a38b` before and after |
| onboarding (`--append "Cleo Fields"`) | `s3/onboarding.json` | 0 | ok; 7 agent files written; DB `a766c891…a38b` → `e2b4c3cf…2c39` |
| sponsored | `s3/sponsored.json` | 0 | ok — 28 fetched, 17 upserted, 17 w/ policyArea, 0 no-policy, 11 skipped |
| cosponsored | `s3/cosponsored.json` | 0 | ok — 594 fetched, 594 inserted, 0 dup/skipped |
| **bills** | `s3/bills.json`, `s3/bills-rerun-1.json` | **1** | **failed** (external) |

`stageNotReached` (recorded, and confirmed by me as absent from disk): `extract-*`, `house-pfd`, `fec-ie`, `patterns`, `theme-gaps`, `baseline-after`, `corpus`, `typecheck`, `tests`, `renders`, `checkpoint`, `db-audit-complete`, `control-after-serial`.

Consequently there is **no** `s3/db-audit-complete.json` (so no `crossMemberRows` / `parkedTimingRows` measurement), **no** corpus/typecheck/test evidence, **no** render determinism evidence, and — confirmed by direct inspection — **no s3 control page** (`closeout-v2-s3-cleo-fields/site/members/josh-gottheimer.html` does not exist) and **no** `pipeline/artifacts/` directory. OpenSecrets was never reached, so it is neither collected nor recorded as `not-collected`.

## Control-page comparison: not possible

**Section 2 cannot be performed for s3.** The stratum never reached its render stage, so no s3 control render exists to compare against the pristine control. This is an unavoidable consequence of the failure, not an omission in the analysis. (The control FEC source cache *is* present and hash-equal at `faccf341…cab9`, and no `josh-gottheimer` theme artifact exists on either side — but with no rendered page these preconditions have nothing to gate.)

## Independent source-side verification of the Cleo disclosure corpus

The loader never ran, so **no target delta rows and no extractor-produced JSON exist** for s3. I therefore did the strongest check the boundary permits: verifying the frozen source corpus itself, directly from the authoritative index XMLs and the frozen **native `.txt`** text. I did **not** invoke the extractor, did **not** run OCR, and did **not** rely on any earlier historical assertion — every number below I computed from the frozen files.

### 21 indexed filings — confirmed

Parsing all four frozen index XMLs and filtering to surname `FIELDS` / first token `CLEO` yields **28 index records**, of which **exactly 21 are `FilingType='P'` (PTR)**:

| year | P-type count |
|---|---:|
| 2025 | 10 |
| 2026 | 11 |
| **total** | **21** |

Non-PTR Cleo records correctly excluded: `A` 10069053, `A` 10075765, `A` 10075772, `C` 10060316, `H` 10067751, `X` 30021885 (all y2024 LA06), `O` 10074378 (y2025 LA06).

The 21 indexed PTR DocIDs are **set-equal to the 21 frozen PDFs** in `s3/setup.json` — `in_index_not_frozen = []`, `frozen_not_in_index = []`:

`20027855, 20030472, 20030803, 20031017, 20032106, 20033326, 20033424, 20033493, 20033559, 20033616` (2025, all `LA06`) · `20033732, 20033858, 20034018, 20034179, 20034295, 20034357, 20034591, 20034800, 20034894, 20035023, 20035345` (2026, all `LA06`)

Each has both a `.pdf` and a `.txt` in `data/caches/pfd-cache/{2025,2026}/fields-cleo-<docid>.{pdf,txt}` — 21 PDFs, 21 native text files, all hash-verified. **No indexed filing is missing from the frozen cache and no frozen filing is absent from the index.**

### 233 expected visible rows — confirmed from native text

Counting transaction rows in the frozen `.txt` (anchored on transaction-type + transaction date + notification date + amount band):

| filing | rows | filing | rows |
|---|---:|---|---:|
| 2025/20027855 | 1 | 2026/20033732 | 5 |
| 2025/20030472 | 44 | 2026/20033858 | 6 |
| 2025/20030803 | 58 | 2026/20034018 | 6 |
| 2025/20031017 | 38 | 2026/20034179 | 2 |
| 2025/20032106 | 21 | 2026/20034295 | 1 |
| 2025/20033326 | 8 | 2026/20034357 | 1 |
| 2025/20033424 | 11 | 2026/20034591 | 1 |
| 2025/20033493 | 4 | 2026/20034800 | 4 |
| 2025/20033559 | 2 | 2026/20034894 | 3 |
| 2025/20033616 | 15 | 2026/20035023 | 1 |
| | | 2026/20035345 | 1 |
| **2025 subtotal** | **202** | **2026 subtotal** | **31** |

**Total = 233**, matching the expected visible-row count exactly.

**Independent cross-check:** asset-type bracket tokens in the same text total `[ST]` 226 + `[OT]` 6 + `[GS]` 1 = **233** — a second, structurally independent count that agrees with the row count.

### First / last source row of every filing

| filing | first row | last row |
|---|---|---|
| 2025/20027855 | S (partial) 02/05/2025 $500,001 – NVIDIA Corporation – Common | (same, n=1) |
| 2025/20030472 | P 06/05/2025 $15,001–$50,000 Alphabet Inc. – Class C Capital Stock | P 06/25/2025 $100,001 – Taiwan Semiconductor |
| 2025/20030803 | P 07/30/2025 $15,001 – Advanced Micro Devices, Inc. (AMD) | P 07/10/2025 $15,001 – Uber Technologies, Inc. Common |
| 2025/20031017 | P 08/01/2025 $15,001 – Advanced Micro Devices, Inc. (AMD) | P 08/15/2025 $15,001 – Taiwan Semiconductor |
| 2025/20032106 | P 09/17/2025 $15,001 – Alphabet Inc. – Class C Capital Stock | P 09/10/2025 $1,001–$15,000 Uber Technologies, Inc. Common |
| 2025/20033326 | P 10/10/2025 $15,001 – Alphabet Inc. – Class A Common | P 10/10/2025 $15,001 – Palantir Technologies Inc. – Class A |
| 2025/20033424 | P 10/23/2025 $100,001 – Alphabet Inc. – Class A Common | P 10/23/2025 $50,001 – UNITED STATES TREASURY BILL; |
| 2025/20033493 | P 11/13/2025 $1,001–$15,000 Apple Inc. – Common Stock (AAPL) | P 11/03/2025 $100,001 – Netflix, Inc. – Common Stock (NFLX) |
| 2025/20033559 | P 11/20/2025 $100,001 – Netflix, Inc. – Common Stock (NFLX) | P 11/20/2025 $100,001 – Netflix, Inc. – Common Stock (NFLX) |
| 2025/20033616 | P 12/15/2025 $15,001 – Alphabet Inc. – Class A Common | S 12/11/2025 $50,001 – Uber Technologies, Inc. Common |
| 2026/20033732 | P 12/26/2025 $50,001 – Alphabet Inc. – Class A Common | S 12/26/2025 $1,001–$15,000 Opendoor Technologies Inc – |
| 2026/20033858 | P 01/12/2026 $1,001–$15,000 Alphabet Inc. – Class C Capital Stock | P 01/08/2026 $1,001–$15,000 Taiwan Semiconductor |
| 2026/20034018 | P 02/03/2026 $50,001 – Advanced Micro Devices, Inc. (AMD) | P 02/03/2026 $100,001 – Micron Technology, Inc. – Common |
| 2026/20034179 | P 03/12/2026 $1,001–$15,000 Microsoft Corporation – Common | (same asset/date, n=2) |
| 2026/20034295 | P 03/16/2026 $1,001–$15,000 Alphabet Inc. – Class C Capital Stock | (same, n=1) |
| 2026/20034357 | P 04/09/2026 $1,001–$15,000 Taiwan Semiconductor | (same, n=1) |
| 2026/20034591 | P 05/14/2026 $1,001–$15,000 Apple Inc. – Common Stock (AAPL) | (same, n=1) |
| 2026/20034800 | P 06/15/2026 $1,001–$15,000 Alphabet Inc. – Class C Capital Stock | P 06/04/2026 $1,001–$15,000 Quantinuum Inc. – Class A Common |
| 2026/20034894 | P 06/26/2026 $1,001–$15,000 NVIDIA Corporation – Common Stock | (same, n=3) |
| 2026/20035023 | P 07/10/2026 $1,001–$15,000 Taiwan Semiconductor | (same, n=1) |
| 2026/20035345 | P 08/13/2026 $1,001–$15,000 Apple Inc. – Common Stock (AAPL) | (same, n=1) |

Note the source rows are **not** date-sorted within a filing (e.g. 20030803 runs 07/30 → 07/10), so any loader must preserve document order by index rather than assume chronology.

### Non-purchases — all 13 enumerated

Transaction types across all 233 rows: **P 220, S 11, S (partial) 2** ⇒ **13 non-purchases**:

| filing | type | tx date | asset |
|---|---|---|---|
| 2025/20027855 | S (partial) | 02/05/2025 | NVIDIA Corporation – Common Stock (NVDA) [ST] |
| 2025/20030472 | S | 06/30/2025 | Intel Corporation – Common Stock |
| 2025/20030803 | S | 07/28/2025 | BITMINE IMMERSIN TECH INC |
| 2025/20033424 | S | 10/30/2025 | Chipotle Mexican Grill, Inc. Common |
| 2025/20033616 | S | 12/11/2025 | Arm Holdings plc – American |
| 2025/20033616 | S | 12/11/2025 | AT&T Inc. (T) [ST] |
| 2025/20033616 | S | 12/11/2025 | CoreWeave, Inc. – Class A Common |
| 2025/20033616 | S | 12/15/2025 | SoundHound AI, Inc. – Class A |
| 2025/20033616 | S | 12/11/2025 | Uber Technologies, Inc. Common |
| 2026/20033732 | S (partial) | 12/26/2025 | FIGMA INC CLASS A (FIG) [OT] |
| 2026/20033732 | S | 12/26/2025 | FIGMA INC CLASS A (FIG) [OT] |
| 2026/20033732 | S | 12/26/2025 | IREN Limited – Ordinary Shares |
| 2026/20033732 | S | 12/26/2025 | Opendoor Technologies Inc – |

### Wrapped / multiline / [OT] / [GS] exceptions

**[OT] — 6 rows, all Figma Inc. Class A (FIG)**, note the inconsistent source casing/punctuation across filings (a real normalization hazard):
- `Figma Inc. Class A (FIG) [OT]` P 08/01/2025 → 08/04/2025, $15,001–$50,000 *(amount band wrapped across lines)*
- `Figma Inc. Class A (FIG) [OT]` P 08/01/2025 → 08/04/2025, $1,001–$15,000
- `Figma Inc. Class A (FIG) [OT]` P 09/10/2025 → 09/10/2025, $1,001–$15,000
- `Figma Inc Class A (FIG) [OT]` P 10/10/2025 → 10/10/2025, $1,001–$15,000 *(no period after "Inc")*
- `FIGMA INC CLASS A (FIG) [OT]` S (partial) 12/26/2025 → 12/26/2025, $1,001–$15,000 *(all caps)*
- `FIGMA INC CLASS A (FIG) [OT]` S 12/26/2025 → 12/26/2025, $15,001–$50,000 *(all caps, amount band wrapped)*

**[GS] — 1 row**, in 2025/20033424: `UNITED STATES TREASURY BILL; DUE 01/22/2026 [GS]`, P 10/23/2025 → 10/23/2025, $50,001–$100,000. This row is doubly exceptional: the **asset name itself is split across lines** (`UNITED STATES TREASURY BILL;` / `DUE 01/22/2026 [GS]`) **and** its amount band wraps. It has no ticker.

**Wrapped amount bands — 3**, where `$X -` ends a line and `$Y` begins the next: 2025/20031017 (`$15,001 -` / `$50,000`), 2025/20033616 (`$15,001 -` / `$50,000`), 2026/20033732 (`$15,001 -` / `$50,000`).

**Wrapped asset names — 69 across 13 filings** (asset text continues on a following line before the ticker/bracket): 20027855 (1), 20030472 (9), 20030803 (19), 20031017 (7), 20032106 (6), 20033326 (4), 20033424 (2), 20033616 (9), 20033732 (2), 20033858 (1), 20034018 (4), 20034179 (2), 20034800 (3).

**Boundary stated faithfully.** All of the above is **source-side only**. Because the extractor and loader never ran for s3, there is no produced JSON and no loaded row to compare against, so **no source-to-loaded reconciliation is possible for this stratum**. These 233 rows are the *expected* target, established independently from the frozen index and native text; whether the candidate's extractor and loader reproduce them is exactly what remains unproven. No OCR was used; the `.txt` files are native extracted text frozen alongside the PDFs.

## Verdict

**s3 — FAILED** (external source unavailability; correctly failed closed, correctly classified, not a pass and not `verified-empty`).

The failure is attributable to GovTrack `/api/v2` being unreachable, not to the candidate: the loader aborted nonzero before publishing partial linkage, the DB hash is unchanged across both attempts, both failed attempts are preserved, and exactly one authorized rerun was used.

### Outstanding evidence (what would be needed to close s3)

1. A successful `--load-bills --bioguide F000110 --api-pass` run once GovTrack `/api/v2` is reachable — this requires fresh authorization, since the single permitted manual rerun is already consumed.
2. All stages after `bills`: `extract-*`, `house-pfd`, `fec-ie`, `patterns`, `theme-gaps`, `baseline-after`, `corpus`, `typecheck`, `tests`, renders ×2, `checkpoint`, `db-audit-complete` (for `crossMemberRows` / `parkedTimingRows`), `control-after-serial`.
3. An s3 control render, without which the region-level control comparison cannot be performed.
4. Source-to-loaded reconciliation of the **233 rows across 21 filings** established above — including the 13 non-purchases, the 6 [OT] rows with inconsistent casing, the 1 multiline [GS] Treasury Bill row, the 3 wrapped amount bands, and preservation of document order where source rows are not chronological.
5. An explicit OpenSecrets outcome (`not-collected` or otherwise).

Scope note: this is not the final six-stratum certification. Under the frozen defect rule this is the **first** stratum failure; a second would stop Track B.
