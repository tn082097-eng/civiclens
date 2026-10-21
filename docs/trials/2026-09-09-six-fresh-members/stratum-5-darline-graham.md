# Stratum 5 result - Darline Graham

**Outcome: PASS.** Darline Graham (`darline-graham`, `G000608`, Senate)
completed the frozen no-FEC-ID-source trial at `e7c7bcd`.

The frozen legislators snapshot had no `id.fec`, which is the stratum's pre-run
predicate. During onboarding the normal fallback found `S6SC04437`; that is a
successful resolution, not evidence that the frozen predicate was false.

| Check | Result |
|---|---|
| Agent task | `task-1789013923607-6a656d66`; final reviewer approved |
| Research | 1 bill, 37 votes, 80 donors; source reported no committee assignments |
| Sponsored / cosponsored | 3 fetched / 49 fetched |
| Bill linkage | 16 regex, 2 API, 19 source-unresolvable; 9 summaries |
| Senate PTR | live target-specific EFDS search for 2023-2026 found 0; durable receipt written; loader printed `verified-empty` |
| FEC fallback | resolved `S6SC04437`; 2026 IE loaded: 1 aggregate, 68 filings |
| OpenSecrets | `not-collected` |
| Timing-safe patterns | 0 hits; confirmatory timing pair did not run |
| Theme gaps | insufficient data: 0 trades, 0 receipts |
| Verification | baseline, 296/296 tests, TypeScript, and seven artifact schemas passed |
| Render | two byte-identical selected-member renders, SHA-256 `1c5c2bc6be75cf636ba7a8b62f0bc211a479b2193324d96fc4e432719a711973` |

Only the disposable database changed. The source database remained
byte-identical. No production write, push, publication, deployment, OCR, or
confirmatory timing run occurred.
