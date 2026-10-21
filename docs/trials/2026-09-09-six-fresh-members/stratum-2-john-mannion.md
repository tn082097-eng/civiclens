# Stratum 2 result - John W. Mannion

**Outcome: PASS.** John W. Mannion (`john-w-mannion`, `M001231`, House)
completed the isolated onboarding path at `e7c7bcd`.

| Check | Result |
|---|---|
| Agent task | `task-1789011269348-43dc1a12`; final reviewer approved |
| Research | 10 bills, 657 votes, 100 donors |
| Sponsored / cosponsored | 10 / 314 |
| Bill linkage | 376 regex, 274 API, 7 source-unresolvable; 28 summaries |
| House PTR | authoritative 2023-2026 indexes each proved zero target PTRs; all four loads explicitly `verified-empty`; DB unchanged |
| FEC IE 2026 | 1 member-cycle with IE |
| OpenSecrets | `not-collected` |
| Timing-safe patterns | 0 hits; confirmatory timing pair did not run |
| Theme gaps | insufficient data: 0 trades, 0 receipts |
| Baseline | 58 members; 80.4% vote-to-bill linkage |
| Verification | 296/296 tests; TypeScript clean; seven artifact schemas valid |
| Render | two byte-identical selected-member renders, SHA-256 `57c0afc2a317381e19b81a0803e519b1d1a794bc0b0563f081fd45059cf474ee` |

An initial baseline command was accidentally launched from the central checkout
and failed before opening a valid trial database. It made no data change; the
same check then passed from the correct disposable worktree. The source database
remained byte-identical. No OCR or publication action occurred.
