# s4 evidence analysis — Chris Van Hollen (V000128, Senate)

Snapshot before subsequent independent checks. Stage-absence and stop-rule conclusions below are superseded by `../closeout-review.md`, `../conductor-continuation.md`, and `../s4/independent-checks.json`. The overall bill-stage failure remains unresolved.

Analyst: Claude (read-only evidence analyst). Candidate `56efb3bc4308206d406553162cd39274df0efc8b`.
This is **evidence analysis, not the final independent certification review**.

## State asserted before writing

Analyst cwd `/home/captainanime/Developer/civiclens-track-b-trials/closeout-2026-09-14-inputs`; central HEAD `56efb3bc…f8b`; central `git status --porcelain` = the 3 preexisting modified docs + untracked `replays-v2/`, unchanged by this analysis; frozen input DB `a766c8917a0e6b42ddc488758eb0b1a66abb37d24c873a74b4cc9d6fd7e4a38b` identical before and after all reads, no WAL. DB access in-memory + `ATTACH … (READ_ONLY)` only. No pipeline, loader, render, scoring, test, OCR, install, network, commit, or git-state change.

## Outcome: failed closed on the same external outage as s3

`s4/external-failure.json`: `outcome: "failed"`, `classification: "external source degradation (GovTrack /api/v2 intermittent), not an implementation defect"`, stage `bills (--load-bills --bioguide V000128 --api-pass)`.

I re-read both step records directly rather than relying on the summary:

| attempt | evidence | exit | HEAD | started → finished (UTC) | dbBefore == dbAfter | output |
|---|---|---|---|---|---|---|
| 1 | `s4/bills.json` | **1** | `56efb3bc…f8b` | 15:03:36 → 15:03:50 | ✓ `80568fce…488d` | Pass 1 regex 596 filled / 1104 unparseable / 1700 scanned; Pass 2 GovTrack → `Fatal: The operation was aborted due to timeout` |
| 2 (single authorized rerun) | `s4/bills-rerun-1.json` | **1** | `56efb3bc…f8b` | 15:04:29 → 15:04:42 | ✓ `80568fce…488d` | Pass 1 0 filled / 1104 unparseable / 1104 scanned; Pass 2 → `Fatal: The operation was aborted due to timeout` |

- **Failed closed.** Both attempts exited nonzero with `Fatal:`; no partial vote→bill linkage was published.
- **DB integrity.** `dbBefore == dbAfter == 80568fce5c6125266c26ef95b012437009783605c0f156fad1608464372d488d` in both records — verified by me from the raw JSON, not from the summary.
- **Rerun policy respected.** I compared the two command arrays byte-for-byte: **identical** (`agents/pipeline.ts --load-bills --bioguide V000128 --api-pass`). Member, inputs, acceptance rule, and timeout unchanged; no retry loop added; exactly one rerun used.
- **Same external cause as s3, independently corroborated by the pattern.** Both strata failed at the *same* `--load-bills` Pass 2 GovTrack resolution step, ~11 minutes apart, on the same candidate HEAD, with unrelated upstreams healthy. The recorded latency samples show `/api/v2` swinging between unreachable (curl 000 @ 25 s), HTTP 200 @ 28.331 s, and HTTP 200 @ ~0.21 s within minutes, while `govtrack.us` root stayed 200 ~0.27 s and `api.congress.gov` stayed 200 throughout. That is upstream instability, not local network loss and not a candidate defect. Note the two failures present different symptoms of one condition — s3 `fetch failed` (connection refused/unreachable), s4 `operation was aborted due to timeout` (slow response) — which is consistent with a degrading endpoint rather than two independent faults.

**Correctly classified.** A transient external failure is not a source-backed limitation. s4 is **not** a pass, **not** `verified-empty`.

## Stages that completed before the failure

`s4/setup.json`: candidate `56efb3bc…f8b` (matches), `dbInitialSha256` `a766c891…a38b` (matches frozen input DB), `cacheInitiallyAbsent: true`. **Both declared sources verified present and hash-matching by me — 2/2 OK:**

| path | sha256 |
|---|---|
| `data/caches/legislators-cache/legislators-current.yaml` | `a90636ae…8cd2` |
| `data/caches/senate-ptr-cache/_search-receipts/V000128.json` | `0d984a75…83b1` |

**Canonical identity / chamber.** `s4/identity.json`: slug `chris-van-hollen`, bioguide `V000128`, chamber `senate`. Independently confirmed from the frozen `legislators-current.yaml`: `bioguide: V000128`, `official_full: Chris Van Hollen`, `lis: S390`, **two Senate terms** — `type: sen` 2017-01-03 → 2023-01-03 (MD, class 3) and 2023-01-03 → 2029-01-03 (MD, class 3) — preceded by House MD-08 terms 2003–2017. The member is a **sitting senator**, so the Senate disclosure branch applies. `fec:` present with `H2MD08126` and `S6MD03441`.

| stage | evidence | exit | result |
|---|---|---|---|
| baseline-before | `s4/baseline-before.json` | 0 | ok; DB `a766c891…a38b` before and after |
| onboarding (`--append "Chris Van Hollen"`) | `s4/onboarding.json` | 0 | ok — APPROVED, task `task-1789570440288-f9d00580`, 7 agent files; DB `a766c891…a38b` → `80568fce…488d` |
| sponsored | `s4/sponsored.json` | 0 | ok — 632 fetched, 384 upserted, 380 w/ policyArea, 4 no-policy, 248 skipped |
| cosponsored | `s4/cosponsored.json` | 0 | ok — 6919 fetched, 6531 inserted, 388 dup/skipped |
| **bills** | `s4/bills.json`, `s4/bills-rerun-1.json` | **1** | **failed** (external) |

All commands member-scoped (`--bioguide V000128` / `chris-van-hollen`), never `--all`.

`stageNotReached` (recorded, and confirmed absent from disk by me): `senate-ptr`, `fec-ie`, `patterns`, `theme-gaps`, `baseline-after`, `corpus`, `typecheck`, `tests`, `renders`, `checkpoint`, `db-audit-complete`, `control-after-serial`.

Consequently: **no** `db-audit-complete.json` ⇒ no `crossMemberRows` / `parkedTimingRows` measurement; **no** corpus/typecheck/test/baseline-after evidence; **no** render determinism evidence; **no s4 control page** (confirmed: `closeout-v2-s4-chris-van-hollen/site/members/josh-gottheimer.html` does not exist). OpenSecrets never reached, so no explicit outcome is recorded for it.

## Control-page comparison: not possible

**Section 2 cannot be performed for s4** — the stratum never reached its render stage, so no s4 control render exists to compare against the pristine control. This is a consequence of the failure, not an omission.

## Senate zero receipt — complete, successful, target- and range-specific

This is the one substantive s4 requirement I *can* settle on current evidence, because the receipt is a frozen input. **However, note the boundary precisely: the receipt was verified, but the `senate-ptr` loader stage never ran**, so there is no loaded-row outcome to reconcile against it.

`data/caches/senate-ptr-cache/_search-receipts/V000128.json` (sha256 `0d984a7504b64954efb42b473ef98e0257edf4ff49fe11d2489c59bb94b483b1`, matches `s4/setup.json`), full contents:

```json
{
  "schemaVersion": 1,
  "kind": "senate-ptr-search",
  "status": "success",
  "bioguideId": "V000128",
  "canonicalName": "Chris Van Hollen",
  "fromYear": 2023,
  "toYear": 2026,
  "filingIds": [],
  "filingCount": 0,
  "sourceUrl": "https://efdsearch.senate.gov/search/report/data/",
  "fetchedAt": "2026-09-10T03:10:24.256Z"
}
```

I checked it against every clause of `validateReceipt()` in `lib/senate-ptr-receipt.ts:43-70`:

| requirement | value | result |
|---|---|---|
| `schemaVersion === 1` | 1 | ✓ |
| `kind === 'senate-ptr-search'` | matches | ✓ |
| **`status === 'success'`** | `success` | ✓ — a complete, successful search, not an error or partial |
| `bioguideId` and `canonicalName` non-empty | `V000128` / `Chris Van Hollen` | ✓ **target-specific** |
| `bioguideId` matches target | `V000128` = `s4/identity.json` bioguide | ✓ |
| `fromYear`/`toYear` integers, `from <= to` | 2023 → 2026 | ✓ **range-specific**, covers the full 4-year window |
| `filingIds` array, no blanks, no dupes, `filingCount === filingIds.length` | `[]`, `0 === 0` | ✓ |
| `sourceUrl === SENATE_PTR_SEARCH_SOURCE` | `https://efdsearch.senate.gov/search/report/data/` | ✓ authoritative EFDS endpoint |
| `fetchedAt` parseable | `2026-09-10T03:10:24.256Z` | ✓ |

The zero is therefore an **authoritative, identity-matched, source-backed zero** over the declared 2023–2026 range, not a missing or malformed search: a receipt that failed any clause would have thrown rather than presenting `filingCount: 0`. The frozen Senate cache for this worktree contains exactly this one file and no filing JSONs (verified by directory scan), consistent with `filingCount: 0`.

**Boundary stated faithfully.** This receipt establishes the *source-side* zero. It does **not** establish that the candidate's `--load-senate-ptr` stage consumed it correctly, because that stage never ran. Closing s4 still requires the loader to run and record the `verified-empty` outcome against this receipt.

## Disclosure-row reconciliation

**Not possible.** No `senate-ptr` stage, no delta, no loaded rows. The expected target is zero rows (per the receipt above), but that expectation is unverified against the candidate's behavior.

## Verdict

**s4 — FAILED** (external source degradation; correctly failed closed, correctly classified, not a pass and not `verified-empty`).

This is the **second** stratum failure. Per the frozen defect rule recorded in `s4/external-failure.json` (`stopRule`), Track B execution stops here; the worker halted and returned to the conductor without attempting a repair and without changing any timeout, retry policy, acceptance rule, or member selection. I confirmed no replay process is running and that s5/s6 worktree DBs remain at the untouched frozen hash `a766c891…a38b`.

### Outstanding evidence (what would be needed to close s4)

1. A successful `--load-bills --bioguide V000128 --api-pass` once GovTrack `/api/v2` is stable — requires fresh authorization, since the single permitted manual rerun is consumed.
2. `senate-ptr` stage execution recording `verified-empty` against receipt `V000128.json` (the receipt itself is already verified above; the loader's consumption of it is not).
3. Chamber-branch confirmation *in execution*: `--load-senate-ptr` must run and `--load-pfd` must not. Identity resolves to `senate`, but no disclosure loader has yet run for this member, so the branch is correct on paper and unexercised in fact.
4. All remaining stages: `fec-ie`, `patterns`, `theme-gaps`, `baseline-after`, `corpus`, `typecheck`, `tests`, renders ×2, `checkpoint`, `db-audit-complete` (for `crossMemberRows` / `parkedTimingRows`), `control-after-serial`.
5. An s4 control render, without which the region-level control comparison cannot be performed.
6. An explicit OpenSecrets outcome (`not-collected` or otherwise).

Scope note: this is not the final six-stratum certification.
