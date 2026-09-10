# Stratum 6 result - Eric Burlison

**Outcome: PASS with source-backed disclosure withholding.** Eric Burlison
(`eric-burlison`, `B001316`, House) completed the isolated non-OCR path at
`e7c7bcd`.

The frozen official Clerk PDF for DocID `8219414` has no usable native text.
Its `pdftotext -layout` output contains only form-feed separators. The filing
was recorded as unavailable/withheld; the extractor and loader were not invoked
and no OCR ran.

| Check | Result |
|---|---|
| Agent task | `task-1789011533728-ed45c22b`; final reviewer approved |
| Research | 48 bills, 1,898 votes, 100 donors |
| Sponsored / cosponsored | 55 fetched / 393 inserted |
| Bill linkage | 614 API, 38 source-unresolvable; 28 summaries |
| House PTR | DocID 8219414 withheld: native text unavailable, OCR prohibited |
| FEC IE 2026 | 1 aggregate, 61 filing rows |
| OpenSecrets | `not-collected` |
| Timing-safe patterns | 0 hits; confirmatory timing pair did not run |
| Theme gaps | insufficient data: 0 trades, 0 receipts |
| Baseline | 58 members; 80.6% vote-to-bill linkage |
| Verification | 296/296 tests; TypeScript clean; seven artifact schemas valid |
| Render | two byte-identical selected-member renders, SHA-256 `71c4ec6946ef6870d3fad34e37b1500c38faedfd4736bb038650cda23d8ea55a` |

The fixed Josh Gottheimer control page could not be compared directly with the
older committed bytes because its theme-gap JSON is ignored and absent in a
fresh trial, while the committed page is an older database snapshot. A
same-input pristine render comparison isolated only the generated minute and
Eric's expected insertion into a global outside-spending peer table; Josh's own
records did not change. This exposes a weakness in an unconditional byte-level
reference gate, not cross-member data corruption.

The source database remained byte-identical. No production or publication
action occurred.
