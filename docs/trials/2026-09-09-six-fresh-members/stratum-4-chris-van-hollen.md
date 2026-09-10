# Stratum 4 result - Chris Van Hollen

**Outcome: FAILED certification.** The source-backed zero-PTR Senate path and
deterministic renderer worked, but two required onboarding outputs did not.

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

No manual retry was made after the pipeline's built-in summarizer retry. The
failure remains attached to the frozen member, as the protocol requires. The
source database remained byte-identical, and no production or publication
action occurred.
