# Historical analyst progress snapshot

Superseded for current execution status by `../evening-progress.md` and `../closeout-review.md`. Original snapshot retained below.

# Analysis progress — closeout replays v2, strata 2–6

Analyst: Claude (read-only evidence analyst). Candidate `56efb3bc4308206d406553162cd39274df0efc8b`.
Evidence analysis only — **not** the final independent certification review.
Execution worker's durable log: `../claude-execution.md`. s1 report: `../s1/claude-evidence.md`.

## State asserted (re-checked before each write)

| Item | Value |
|---|---|
| Analyst cwd | `/home/captainanime/Developer/civiclens-track-b-trials/closeout-2026-09-14-inputs` |
| Central HEAD | `56efb3bc4308206d406553162cd39274df0efc8b` |
| Central `git status --porcelain` | 3 preexisting modified docs + untracked `replays-v2/` — unchanged by this analysis |
| Frozen input DB sha256 | `a766c8917a0e6b42ddc488758eb0b1a66abb37d24c873a74b4cc9d6fd7e4a38b` (unchanged across all reads, no WAL) |
| DB access | in-memory DuckDB + `ATTACH … (READ_ONLY)` only |

Writes confined to `analysis/sN-evidence.md` and this file, inside the already-untracked `replays-v2/`. No implementation, protocol, source cache, task artifact, main, `.env`, production, or git-state change. No DB write, no default-mode DB open, no pipeline/loader/render/scoring/test/OCR/install/network. No commits. No agents.

## Status

| Stratum | Member | Verdict | Report |
|---|---|---|---|
| s1 | Tina Smith (S001203, Senate) | PASS-CHECKS (prior task) | `../s1/claude-evidence.md` |
| s2 | John W. Mannion (M001231, House) | **PASS-CHECKS** | `s2-evidence.md` |
| s3 | Cleo Fields (F000110, House) | **FAILED** (external: GovTrack `/api/v2` outage; failed closed) | `s3-evidence.md` |
| s4 | Chris Van Hollen (V000128, Senate) | **PENDING** — replay in progress | — |
| s5 | Darline Graham (G000608, Senate) | **PENDING** — not started | — |
| s6 | Eric Burlison (B001316, House, scanned hold) | **PENDING** — not started | — |

## Completed analyses

### s2 — PASS-CHECKS
5/5 input hashes verified; identity M001231 / House / NY-22 confirmed against frozen YAML; House branch correct (`--load-pfd`, no Senate loader); all stages exit 0 with explicit outcomes; OpenSecrets explicitly `not-collected`; corpus 7/7 PASS at 1/1 (no 0/0); typecheck clean; 353/353 tests pass, 0 skipped, forbidden confirmatory pair excluded from the 50-file list; render determinism `equal: true` from hash-identical inputs (13 files); `crossMemberRows: 0`, `parkedTimingRows: []`; baseline row-count deltas reconcile exactly with the delta JSON.
Control page: **only `sec-peers` changed** (+153 bytes, 14/15 regions byte-identical after timestamp-only normalization, byte preservation asserted). Pure insertion of one row (0 removed): John W. Mannion, index 9, shared=5, `$125.0K`, displacing 25 peers down exactly one rank with all values unchanged. Reproduced from 5 exact donor rows (frozen Josh × delta-added Mannion on `donor_canonical`, sum 45000+25000+20000+20000+15000 = 125000 → `fmtMoney` → `$125.0K`); rank position derived from the SQL ORDER BY. Control FEC cache hash-equal `faccf341…cab9`; `josh-gottheimer` theme artifact absent both sides.
Zero House PTRs **independently re-derived** from the frozen indexes: 9,199 records / 1,805 P-type / 0 malformed; Mannion appears 5× (C, X, C, H, O) with **0 P-type in any year**; the only NY-22 P filings belong to a different surname, so the ambiguity guard is correctly untriggered; `pfd_transactions` 5277 → 5277. No blockers.

### s3 — FAILED
`--load-bills … --api-pass` aborted nonzero twice with `Fatal: fetch failed` (attempt 1 + the single authorized rerun). Probe shows GovTrack `/api/v2` unreachable while govtrack.us and api.congress.gov return 200 ⇒ source-side. DB hash `e2b4c3cf…2c39` unchanged across both attempts; loader failed closed. Correctly **not** a pass and **not** `verified-empty`.
Completed before failure: baseline-before, onboarding, sponsored (28/17/17), cosponsored (594/594/0). All 47 declared sources present and hash-matching. Identity F000110 / House / LA-06 confirmed.
No render ⇒ **control comparison impossible for s3**; no `db-audit-complete` ⇒ no `crossMemberRows` measurement; no extractor/loader output ⇒ **no source-to-loaded reconciliation possible**.
Source-side corpus **independently verified** from frozen files: **21 indexed PTR filings** (10×2025, 11×2026, all LA06) set-equal to the 21 frozen PDFs, zero missing either direction; **233 visible rows** counted from native `.txt` (2025: 202, 2026: 31), cross-checked by bracket tokens `[ST] 226 + [OT] 6 + [GS] 1 = 233`; 13 non-purchases enumerated (P 220 / S 11 / S-partial 2); exceptions characterized — 6 `[OT]` Figma rows with inconsistent source casing, 1 multiline `[GS]` US Treasury Bill row, 3 wrapped amount bands, 69 wrapped asset-name lines; source rows are not chronological within a filing. No OCR, no extractor invocation.

## Pending

- **s4** Chris Van Hollen — replay in progress (`s4/setup.json`, `s4/baseline-before.json` present). Awaiting completion. Required: complete successful target/range-specific Senate zero receipts.
- **s5** Darline Graham — not started. Required: complete Senate zero receipts; record frozen YAML missing FEC and the actual normal fallback.
- **s6** Eric Burlison — not started. Required: must remain `withheld` / `needs_manual_formatting` and **not** pass; verify official DocID `8219414` hash/source, extractor + loader nonzero due to a genuine hold, and no missing indexed/source failure concealed as a hold.
