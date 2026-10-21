# Stratum 4 result - Chris Van Hollen

**Outcome: PASS after one focused generic repair and a fresh replay.** Attempt 1
remains recorded below as a real failure. The frozen protocol allowed one
generic fix cycle for an implementation defect; commit `20f62c0` made required
onboarding outputs fail closed, and attempt 2 then completed in a new scratch
worktree at that commit.

## Attempt 2 - pass

| Check | Result |
|---|---|
| Agent task | `task-1789088675047-77057722`; final reviewer approved |
| Research | 117 bills, 1,700 votes, 100 donors |
| Summarizer | completed on the first attempt; `summarizer.json` present and schema-valid |
| Required artifacts | researcher, data-checker, and summarizer each 1/1 valid; all seven produced artifact families schema-valid |
| Cosponsorship | complete: 6,912 fetched, 6,524 inserted, 388 existing/duplicate; 0 incomplete members |
| Sponsored | 628 fetched, 380 upserted, 248 skipped; 380 rows carried policy areas |
| Bill linkage | 123 newly resolved through the API, 979 remained source-unresolvable; 9 summaries fetched |
| Senate PTR | frozen successful EFDS receipt proved 0 filings; loader printed `verified-empty`; PTR rows unchanged |
| FEC IE 2026 | 1 member-cycle checked, 0 with IE, 0 errors |
| OpenSecrets | `not-collected` |
| Timing-safe patterns | 0 hits; confirmatory timing pair did not run |
| Theme gaps | insufficient data: 0 trades, 0 receipts |
| Baseline | 58 members; 79.7% vote-to-bill linkage |
| Verification | 313/313 tests passed; TypeScript clean |
| Render | two byte-identical selected-member renders after all loaders, stamp-stripped SHA-256 `55717222ec05f401cc4f5c949128790015ba73c7e5fce68b4079761c0eb2cdce` |

The scratch database began as the frozen source database and changed only in
the expected onboarding tables. Its row-count additions were: one member, one
pipeline run, 1,700 votes, 6,915 member-scoped bill rows, 100 donors, 15
committee rows, 379 bill-subject rows, and 9 bill summaries. A symmetric row
comparison across every base table found these to be pure additions with zero
removed or rewritten rows; the member-scoped subset found **zero cross-member
additions or removals**.

The source database remained byte-identical at SHA-256
`a766c8917a0e6b42ddc488758eb0b1a66abb37d24c873a74b4cc9d6fd7e4a38b`.
No production write, push, publication, deployment, OCR, or confirmatory run
occurred.

## Attempt 1 - preserved failure

The source-backed zero-PTR Senate path and deterministic renderer worked, but
two required onboarding outputs did not.

| Check | Result |
|---|---|
| Agent task | `task-1789013077340-60df01f0` |
| Research | 117 bills, 1,700 votes, 100 donors |
| Summarizer | **failed**: Claude CLI timed out after 120 seconds twice; pipeline continued without a summary |
| Cosponsorship | **failed/incomplete**: fetch terminated before target rows were loaded |
| Sponsored | 628 fetched, 380 upserted, 248 skipped |
| Bill linkage | 598 regex, 123 API, 979 source-unresolvable; 9 summaries |
| Senate PTR | frozen successful EFDS receipt proved 0 filings; loader printed `verified-empty`; DB unchanged |
| FEC IE 2026 | 0 IE, no fetch error |
| Timing-safe patterns | 0 hits; confirmatory timing pair did not run |
| Theme gaps | insufficient data: 0 trades, 0 receipts |
| Baseline | 58 members; 79.7% vote-to-bill linkage |
| Verification | 296/296 tests and TypeScript passed |
| Corpus validator | misleadingly reported PASS while summarizer was `0/0`; this is a discovered gate defect |
| Render | two byte-identical selected-member renders, SHA-256 `ee2b5c84cb6fdb1d51179bea7eb91df81a881953f247617e1b5cf4c41dbb154e` |

No manual retry was made after the pipeline's built-in summarizer retry. This
failed attempt remains attached to the frozen member rather than being erased
or relabeled. It led to the one permitted focused generic repair cycle.
