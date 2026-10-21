# s2 evidence analysis — John W. Mannion (M001231, House)

Analyst: Claude (read-only evidence analyst). Candidate `56efb3bc4308206d406553162cd39274df0efc8b`.
This is **evidence analysis, not the final independent certification review**.

## State asserted before writing

| Item | Value |
|---|---|
| Analyst cwd | `/home/captainanime/Developer/civiclens-track-b-trials/closeout-2026-09-14-inputs` |
| Central checkout HEAD | `56efb3bc4308206d406553162cd39274df0efc8b` (= candidate) |
| Central `git status --porcelain` | 3 preexisting modified docs (`docs/prompts/bulk-download-legislators-and-house-ptrs.md`, `docs/trials/2026-09-06/civiclens-completion-plan.md`, `docs/trials/2026-09-08-run-any-member/plan.md`) + untracked `replays-v2/` — unchanged by this analysis |
| Frozen input DB sha256 | `a766c8917a0e6b42ddc488758eb0b1a66abb37d24c873a74b4cc9d6fd7e4a38b` — identical before and after all reads; no WAL created |
| DB access mode | `DuckDBInstance.create(':memory:')` + `ATTACH … AS frozen (READ_ONLY)` only. No `getDb()`, no default-mode open, no write, no target-DB access |

No pipeline, loader, render, scoring, test, OCR, dependency install, network request, commit, or git-state change was performed. `analysis/` is created inside the already-untracked `replays-v2/`, so tracked git state is untouched.

## 1. Candidate, setup, inputs, identity, outcomes

`s2/setup.json`: `candidate` = `56efb3bc…f8b` (matches), `dbInitialSha256` = `a766c891…a38b` (matches frozen input DB), `cacheInitiallyAbsent: true`.

**All 5 declared source hashes re-verified by me against the worktree files — 5/5 OK, 0 mismatches:**

| path | sha256 |
|---|---|
| `data/caches/legislators-cache/legislators-current.yaml` | `a90636ae…8cd2` |
| `data/caches/pfd-cache/index/2023FD.xml` | `60e5dcf8…c10d` |
| `data/caches/pfd-cache/index/2024FD.xml` | `99576a8c…5f9e` |
| `data/caches/pfd-cache/index/2025FD.xml` | `0b0b0cd2…0814` |
| `data/caches/pfd-cache/index/2026FD.xml` | `3d010744…17d9` |

**Canonical identity / chamber.** `s2/identity.json`: slug `john-w-mannion`, bioguide `M001231`, chamber `house`. Independently confirmed from the frozen `legislators-current.yaml`: `bioguide: M001231`, `official_full: John W. Mannion`, one term `type: rep`, `start 2025-01-03`, `end 2027-01-03`, `state: NY`, `district: 22`. `s2/db-audit-complete.json` `identity` row agrees: `chamber: "house"`, `state: "NY"`.
Chamber branch correct: `--load-pfd` was run (`s2/house-pfd.json` command `agents/pipeline.ts --load-pfd 2023,2024,2025,2026 --bioguide M001231`); **no Senate loader appears in any s2 record.** Member-scoped throughout (`--bioguide M001231` / `--member john-w-mannion`), never `--all`.

**Stage outcomes — all explicit, all exit 0**: baseline-before, onboarding, sponsored (10/10/10 policyArea), cosponsored (325/325/0 dup), bills (39/39; member scope skipped global NULL-title refill), house-pfd (`verified-empty` ×4, §4), fec-ie (1 member-cycle row, 1 with IE, 0 errored), patterns, theme-gaps, baseline-after, corpus, typecheck, tests, renders, checkpoint, db-audit-complete, control-after-serial.

**OpenSecrets = `not-collected`**, recorded explicitly in `claude-execution.md` as optional and deliberately not run. No s2 evidence file presents it as absence of donor data. Correct per AGENTS.md ("never present that state as evidence that no donor data exists").

**Corpus / typecheck / tests / baseline / renders — actual results, not historical substitution:**
- `s2/corpus.json` exit 0: 7/7 families **PASS**, each `1/1 valid (0 unparseable)` — researcher, data-checker, code-checker, trade-analyst, summarizer, predictor, final-review. This is `1/1`, not `0/0`.
- `s2/typecheck.json` exit 0, empty output (`tsc --noEmit`).
- `s2/tests.json` exit 0. I re-parsed the command array: **50 explicit `.test.ts` files**; forbidden pair absent (verified by regex over the command: no `timing-detectors-baseline.test.ts`, no `confirmatory-guard-inpath.test.ts`). Tail: `# tests 353 / # pass 353 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0`. No skips, no 0/0.
- `s2/render-determinism.json`: `equal: true`; raw sha256 `52dee56f…fa89` identical **twice even before normalization**; normalized `5e5aeb77…b159` twice. Normalization regex is exactly the single generated-timestamp pattern.
- `s2/render-inputs.json`: `equal: true` across **13 tracked input files**, all hash-equal between the two renders — no input drifted between renders.
- Baseline row-count deltas (`baseline-before` → `baseline-after`) reconcile **exactly** with the delta JSON (§ below).

**`crossMemberRows` / timing.** `s2/db-audit-complete.json`: **`crossMemberRows: 0`**, **`parkedTimingRows: []`**. Every changed table is additions-only with `removed: 0` and `otherMemberRows: []`:

| table | added | baseline before → after | Δ matches |
|---|---|---|---|
| members | 1 | 57 → 58 | ✓ |
| donors | 100 | 4443 → 4543 | ✓ |
| votes | 669 | 103953 → 104622 | ✓ |
| bills | 335 | 169818 → 170153 | ✓ |
| bill_summaries | 39 | 1323 → 1362 | ✓ |
| bill_subjects | 10 | 37040 → 37050 | ✓ |
| committees | 6 | 381 → 387 | ✓ |
| super_pac_ie | 4 | 305 → 309 | ✓ |
| super_pac_ie_filings | 4 | 6985 → 6989 | ✓ |
| pipeline_runs | 1 | 173 → 174 | ✓ |
| **pfd_transactions** | **absent from changedTables** | **5277 → 5277** | ✓ (corroborates §4) |

`s2/patterns.json` confirms the timing-safe path: `(onboarding-safe: running 1 detector(s); parked timing pair [trade-vote-alignment, spousal-trade-timing] excluded — use score-anomaly.ts for those.)`, result `donor-sector-vote-alignment: 0 hit(s)`. The two ADR-0003 notes state the detectors have **not** consumed their confirmatory runs and that this recompute path is not the confirmatory event. No `score-anomaly.ts` or `*-baseline.ts` runner appears in any s2 record.

**Frozen source / parsed JSON boundary (stated faithfully).** s2's disclosure evidence is the authoritative House **index XML** only (`2023FD.xml`–`2026FD.xml`). There are no PTR PDFs or extracted JSONs for Mannion because the index contains no PTR filing for him. My §4 finding is therefore a direct read of the frozen authoritative index — the strongest available form for a negative — and is **not** a parsed-JSON-only inference. No original filing document exists to inspect, because no such filing is indexed.

## 2. Control page vs pristine — every changed region mapped

Pristine control: `closeout-v2-control-reference/site/members/josh-gottheimer.html`.
s2 control: `closeout-v2-s2-john-mannion/site/members/josh-gottheimer.html` (`s2/control-after-serial.json`, rendered serially after the stratum finished, exit 0, `15d 500t 1750p 35peers`, DB hash `13ee6d16…be06` unchanged before and after, `walBefore=walAfter=null`).

Method identical to s1: split into 15 regions (prefix + the 13 ordered IDs of `MEMBER_SECTION_IDS` in `render/member-sections.ts:5-9` + suffix), anchored at the start of the tag carrying `id="<id>"` (note `sec-receipts` carries its id on a `<section class="receipts">` wrapper, not an `<h2>`). Normalization removes **only** `(?<= · generated )\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z(?=</div>)`; exactly **one** match per file (control `2026-09-16 08:55Z`, s2 `2026-09-16 14:50Z`).

**Byte preservation asserted:** region concatenation === whole file on both sides (control 8,416,531 chars; s2 8,416,684 chars).

| region | verdict | C bytes | s2 bytes | Δ |
|---|---|---|---|---|
| 00-prefix | IDENTICAL | 10822 | 10822 | 0 |
| sec-identity | IDENTICAL | 615 | 615 | 0 |
| sec-glance | IDENTICAL | 1016 | 1016 | 0 |
| sec-receipts | IDENTICAL | 352 | 352 | 0 |
| sec-coherence | IDENTICAL | 87 | 87 | 0 |
| sec-money-votes | IDENTICAL | 3071 | 3071 | 0 |
| sec-timeline | IDENTICAL | 1279018 | 1279018 | 0 |
| sec-trades | IDENTICAL | 7081303 | 7081303 | 0 |
| sec-donors | IDENTICAL | 5073 | 5073 | 0 |
| sec-revolving | IDENTICAL | 17621 | 17621 | 0 |
| sec-outside-spending | IDENTICAL | 2555 | 2555 | 0 |
| **sec-peers** | **DIFFERENT** | 5239 | 5392 | **+153** |
| sec-patterns | IDENTICAL | 8160 | 8160 | 0 |
| sec-cosponsor | IDENTICAL | 1384 | 1384 | 0 |
| zz-suffix | IDENTICAL | 215 | 215 | 0 |

`changed_regions = ["sec-peers"]`; all 14 other regions byte-identical after timestamp normalization. **No unexplained region.**

**Exact sec-peers delta** — pure insertion, **0 bytes removed**, common prefix 1,576 / common suffix 3,663:

```
w-mannion.html">John W. Mannion</a></td>\n    <td class="num">5</td>\n    <td class="num">$125.0K</td>\n  </tr>\n  <tr>\n    <td><a class="member" href="john-
```

Parsed peer table: control 34 rows → s2 35 rows. Added: **John W. Mannion at index 9, shared=5, $125.0K**. Removed: none. **Displacement:** exactly 25 peers shift down by one rank (Cornyn 9→10, Jim Jordan 10→11, Katie Porter 11→12, Lois Frankel 12→13, Chuck Schumer 13→14, Maxine Waters 14→15, Dan Goldman 15→16, Sheldon Whitehouse 16→17, Don Beyer 17→18, Mike Johnson 18→19, Blake Moore 19→20, Adam Schiff 20→21, Nancy Pelosi 21→22, Elizabeth Warren 22→23, Susan Collins 23→24, Cory Booker 24→25, Frank Pallone 25→26, Josh Hawley 26→27, Mike Rogers 27→28, Ilhan Omar 28→29, Pramila Jayapal 29→30, Steve Scalise 30→31, Michael McCaul 31→32, Mike Turner 32→33, Bernie Sanders 33→34) with **`shared_count` and `combined_amount` unchanged for every one** — a pure rank shift, no recomputation of existing peers.

### Reproducing the changed region from exact input rows

Query semantics: `db/queries/shared-donors.sql` — join `donors a` to `donors b` on `a.donor_canonical = b.donor_canonical AND a.member_id <> b.member_id`, `COUNT(*) AS shared_count`, `SUM(a.amount + b.amount) AS combined_amount`, `ORDER BY shared_count DESC, combined_amount DESC, peer_id ASC` (`render/build.ts:1610` via `findSharedDonors`, rendered at `build.ts:1680-1688`, `sec-peers` shell at `build.ts:1842`).

Inputs: Josh's **99 unchanged** donor rows read from the frozen DB (`frozen.donors WHERE member_id='josh-gottheimer'`, in-memory + READ_ONLY ATTACH) joined to the **100 delta-added** `john-w-mannion` donor rows in `s2/db-audit-complete.json`. `john-w-mannion` has **0 rows in the frozen DB** (confirmed by query), so every Mannion row is new. `donors` has no `donor_id` column; the join key is `donor_canonical`. No duplicate canonicals on either side, so `COUNT(*)` = distinct shared donors.

| donor_canonical | josh.amount | mannion.amount | a.amount+b.amount |
|---|---:|---:|---:|
| NEW DEMOCRAT COALITION ACTION FUND | 40000 | 5000 | 45000 |
| THE COUNCIL OF INSURANCE AGENTS & BROKERS POLITICAL ACTION COMMITTEE | 20000 | 5000 | 25000 |
| UA UNION PLUMBERS & PIPEFITTERS VOTE! PAC (UNITED ASSOCIATION OF JOURNEYMEN AND APPRENTICES OF THE PLUMBING & PIPEFITTING INDUSTRY OF THE UNITED STATES AND CANADA) | 10000 | 10000 | 20000 |
| NEA FUND FOR CHILDREN AND PUBLIC EDUCATION | 10000 | 10000 | 20000 |
| NEW YORK LIFE INSURANCE COMPANY POLITICAL ACTION COMMITTEE | 10000 | 5000 | 15000 |

`shared_count = 5` → rendered `5`. `combined_amount = 45000+25000+20000+20000+15000 = 125000` → `fmtMoney(125000)` (`render/build.ts:211-217`): `125000 >= 1000` ⇒ `$${(125000/1000).toFixed(1)}K` = **`$125.0K`**. Matches the inserted row exactly.

**Rank position derived, not assumed:** control indices 0–8 all have `shared_count ≥ 6` (Susie Lee 10, Jim Himes 7, Bill Foster 7, Debbie Wasserman Schultz 7, Jared Moskowitz 6, Scott Peters 6, Steven Horsford 6, Tom Emmer 6, Hakeem Jeffries 5 — Jeffries is 5 with $176.1K > $125.0K) and control index 9 (John Cornyn) has `shared_count = 3`. A row with `shared_count=5, combined=$125.0K` sorts after Jeffries (5, $176.1K, higher combined) and before Cornyn (3) ⇒ **index 9**, exactly as rendered. The `35peers` count in `control-after-serial.json` matches the 35 parsed rows.

**Control-side preconditions:**
- Control FEC source cache hash-equal: `data/caches/pfd-cache/fec-ie/H6NJ05171/2024-funders3.json` = `faccf341b7474956f57fb071455b3c23459b31a0047fb1223004defcc308cab9` in **both** `closeout-v2-control-reference` and `closeout-v2-s2-john-mannion` (matches `control/inputs.json`).
- Theme artifact for `josh-gottheimer` **absent on both sides**: `closeout-v2-control-reference/pipeline/artifacts/` does not exist at all; `closeout-v2-s2-john-mannion/pipeline/artifacts/` contains only `john-w-mannion.theme-gaps.json`. No `josh-gottheimer*` artifact on either side.

## 3. Disclosure-row reconciliation

**Zero disclosure rows to reconcile.** `pfd_transactions` does not appear in the s2 `changedTables`, and `pfd_transactions` is 5,277 in both `baseline-before` and `baseline-after`. There is no target delta disclosure row, no parsed JSON, and no original native text — because the authoritative index contains no PTR filing for this member (§4). This is a correct empty reconciliation, not an unverified skip.

## 4. Source-backed zero House PTRs across 2023–2026 — independently verified

The loader's own output string is **not** the evidence I relied on. I re-parsed the four frozen index XMLs directly and replicated the loader's proof conditions (`db/load-pfd.ts:355-390`).

| index file | total `<Member>` records | `FilingType='P'` records |
|---|---:|---:|
| 2023FD.xml | 2385 | 460 |
| 2024FD.xml | 2293 | 451 |
| 2025FD.xml | 2918 | 515 |
| 2026FD.xml | 1603 | 379 |
| **total** | **9199** | **1805** |

- **Malformed-P fail-closed condition** (`year===null || !docId || !first || !last || !stateDistrict` on any P record): **0 malformed P records** across all 9,199. The negative proof is not invalidated.
- **All four index files present** on disk (650,480 / 625,362 / 793,323 / 431,311 bytes) — the loader's `missing authoritative House index for ${year}` throw could not have been silently bypassed.
- **Every index record with surname MANNION, any year, any filing type** (5 records, all `NY22`, all `John W.`):

| FilingType | year | StateDst | DocID | FilingDate |
|---|---|---|---|---|
| C | 2023 | NY22 | 10056138 | 11/10/2023 |
| X | 2023 | NY22 | 8219936 | 8/24/2023 |
| C | 2024 | NY22 | 10059807 | 5/14/2024 |
| H | 2024 | NY22 | 10067141 | 5/14/2025 |
| O | 2025 | NY22 | 10076752 | 5/13/2026 |

  **`FilingType='P'` count for Mannion = 0** in every year. C/X/H/O are not PTRs.
- **Ambiguity fail-closed condition**: the only P-type filings in NY22 across all four years belong to `Williams, Brandon McDonald` (docs 20025387, 20025437, both 2024). Surname ≠ Mannion, so they are filtered out before the first-name ambiguity check — the `ambiguous target identity` throw is correctly not triggered, and no same-surname record was silently dropped.
- **Term-window nuance, stated plainly.** Mannion's only House term is 2025-01-03 → 2027-01-03. The loader's per-year district set is therefore empty for 2023 and 2024 and `{NY22}` for 2025 and 2026. For 2023/2024 the zero is trivially true (he held no House seat); the substantive source-backed zeros are 2025 and 2026. The surname scan above is the stronger result: **no P-type Mannion record exists in any of the four indexes**, so the four-year zero holds on its own terms and does not depend on the term-window filter.

This is a source-backed `verified-empty`, not a silent skip and not an empty corpus: the member's corpus is non-empty (10 sponsored, 325 cosponsored, 39 bill summaries, 669 votes, 335 bills, 100 donors, 4 super-PAC IE rows).

## Verdict

**s2 — PASS-CHECKS.**

All checks in scope resolved affirmatively on inspected evidence: candidate/setup/input hashes verified (5/5), canonical identity and House chamber branch correct, every stage outcome explicit and exit 0, OpenSecrets explicitly `not-collected`, corpus 7/7 PASS at 1/1 (no 0/0), typecheck clean, 353/353 tests pass with 0 skipped and the forbidden confirmatory pair excluded, render determinism `equal: true` from hash-identical inputs, `crossMemberRows: 0` and `parkedTimingRows: []`, baseline deltas reconcile exactly with the delta JSON, the single changed control region fully reproduced from exact input rows, control FEC cache hash-equal, theme artifact absent on both sides, and the zero House PTR result independently re-derived from the frozen authoritative indexes.

**No blockers. No unexplained region. No outstanding evidence for s2.**

Scope note: this verdict covers the s2 checks enumerated above. It is not the final six-stratum certification, which remains the separate independent review.
