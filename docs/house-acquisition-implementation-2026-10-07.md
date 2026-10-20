# House acquisition package — implementation ledger

Authorization: maintainer's October 7 “ok lets continue” follows the status
report identifying the isolated House acquisition adapter as the next bounded
step. Scope is that adapter and its saved-source/failure tests. No production
load, source retry of the frozen strata, OCR, certification, integration,
commit, push or publication is part of this package.

Base: `cd49c2c05d53f62aeca8fcbc334870dcff191d93`, code-equivalent to frozen
candidate `56efb3bc`. New worktree: `/home/captainanime/Developer/civiclens-reliability-votes`,
branch `codex/reliability-official-votes`. Native creation returned “Not a git
repository” for this home-directory chat; used the exact worktree/base in the
existing reviewed plan. Protected checkout dirty-file hashes/status captured
before work. Existing Node modules reused through local dependency links; no
installation or DB/cache symlinks.

Ruling: implement the House receipt/metadata boundary with standard-library
Python before installing the selected collector — it consumes the newly proven
inventory and does not replace the downstream parser choice — cost if wrong:
this acquisition interface would need adjustment at collector integration.

Ruling: vacated markers remain `unsupported_record` until identity-bound
exclusion authority is implemented — substring-only upstream skipping is unsafe
and must not grant completion — cost if wrong: a legitimate vacated roll causes
a conservative incomplete run until reviewed.

Completed preparation: source fixture freeze and SOURCES.md entry, isolated
path checks, allowed baseline suite 338/338 (46 files; forbidden confirmatory
and timing-runner tests excluded).

Test-first evidence: `adapter-red.log` shows the missing implementation; first
implementation attempt failed because a leftover scaffold function overrode
the real acquisition function on import. Removed that duplicate; retained
`adapter-attempt-1.log`. Second attempt passed 28 tests. Saved inventory check
reconciles all 249 pages, 2,466 published rolls and 2,012 selected rolls. These
are acquisition-boundary checks, not pipeline certification.

Final review and verification are recorded below when complete.

## Final review and verification

One read-only fresh-context review found two consequential cases: invalid XML
encoding could abort before a persisted receipt, and malformed listing-detail
URLs could be silently rewritten. Both were reproduced in regression tests
(`review-fixes-red.log`), corrected once, and verified (`review-fixes-green.log`).
No second review loop. Additional direct verification covers canonical output
paths, partial/incomplete HTTP bodies, response-size caps, and Content-Length
mismatches. Partial bytes are retained with `body_complete: false`; they never
grant acquisition completion.

Final adapter suite: 36/36. Allowed project regression suite: 338/338, 46 files;
`confirmatory-guard-inpath.test.ts` and `timing-detectors-baseline.test.ts` were
explicitly excluded under the plan. TypeScript and `git diff --check` exit 0.
Final saved-source validation rechecks 249 pages, 2,466 published records and
2,012 selected records with the pinned inventory SHA256. Protected main, launch
and Track B HEAD/status/dirty-file hashes are identical before/after; the new
worktree has no database or data/cache symlinks.

No live acquisition ran. Tests injected the transport or used saved bytes.
No collector was installed; this package retains its downstream adaptation
gate. No deferred review findings. No commits, integration or publication.

Full-inventory offline accounting: 2,466 manifest records, including 454
`excluded_outside_window` and 2,012 `incomplete_fetch` (zero HTTP calls,
`max_rolls=0`). The deliberate no-acquisition run remains `incomplete`; it does
not prove XML availability. Took 68.839 seconds. Evidence: 
`artifacts/official-house-acquisition/2026-10-07-offline-accounting/manifest.json`.

Terminal condition: LOCAL COMPLETION VERIFIED for this isolated adapter
package. Overall CivicLens remains NOT COMPLETE / NOT CERTIFIED. Next bounded
source work is one explicitly scoped live acquisition pass; Senate and semantic
collector/identity/bill integration remain downstream.

## 2026-10-08 shared official-vote contract package

Authorization: maintainer's explicit bounded package. Haiku subagents ran T1–T17 (test writers, implementers, fixture curator, docs, reviewers 9–17); the session hit its usage limit mid review-fix round (`CHECKPOINT.md`). On resumption the coordinator applied the T3 validator and T5 adapter review fixes directly and performed the T18 interop / T19 suite checks itself. T20 final review was run externally by ChatGPT (GPT-6, thinking effort Medium, via browser-harness; `task20-chatgpt-review.md`): DEFECTS FOUND, five validator/identity gaps, all five reproduced by the coordinator and fixed test-first in one correction round (spec §7 T20 amendment).

Scope: shared contract across canonical identity, coverage window, position normalization, bill resolution (non-bill subtype rules), TypeScript API (lib/vote-source.ts + skills/researcher/official-votes.ts), acquisition-manifest validation, frozen fixtures, and aligned adapter. No live downloads, installs, DB, OCR, replays, confirmatory/preregistered analysis, renders, commits, or deployment. No new worktrees.

Exclusions: Senate acquisition, identity mapping (member/BioGuide), consumer integration (fetch.ts, agents/, db/, render/), bill-reference canonical storage, public artifacts.

Reused from October 7 work: House adapter (tools/congress-collector/adapter.py, reused and aligned to the new manifest contract; prior safety behavior retained), frozen inventory (fixtures/votes/house-acquisition/) and receipts (fixtures/votes/manifest.json records), 249 official listing pages, 2,466 published rolls, 2,012 in-window rolls. Note: manifest wire format was changed in this package (contract/contract_version/chamber replace legacy `version`; new record/metadata/report fields; per-recorded-vote single <vote> enforcement; amendment fields).

Added: shared contract (docs/official-vote-source-contract-2026-10-08.md §0–10), lib/vote-source.ts (canonical identity, window math, position normalization, bill classification per §1–5), skills/researcher/official-votes.ts (manifest validation per §7), interop helper (tools/congress-collector/make_interop_manifest.py, SYNTHETIC), Senate sample copy (fixtures/votes/official-samples/senate-119-1-roll00001.xml with manifest entry for identity testing), tests for contract APIs and adapter alignment.

Key rulings from contract: (1) Classifier never infers election context; election is passed explicitly in tests (SYNTHETIC). (2) No frozen speaker-election, nomination, or treaty XML; tests for those are SYNTHETIC. (3) QUORUM with vote_type QUORUM → `authoritative_non_bill` subtype `quorum`. (4) Empty legis_num → `unsupported_record`, not evidence of non-bill. (5) Missing member → `not_recorded`, never `absent`. (6) Position `Guilty`, `Not Guilty`, `Present, Giving Live Pair` → `other`, never `nay`/`absent`. (7) JOURNAL → subtype `journal`; ADJOURN → subtype `adjourn`. (8) Response path relative only; no absolute paths or `..`. (9) `acquired` means downloaded + identity-checked only; validation flags remain false. (10) Vacated marker stays `unsupported_record` (existing ruling retained). Review round (one consolidation): fixed December month arithmetic in the adapter, roll/congress positive-integer enforcement, dotted bill designations, validator field-type checks and recording of helper failures; details in the evidence folder.

Evidence folder: `artifacts/official-votes-contract-2026-10-08/` (agent task logs, protected-checkout snapshot, test outputs). The 2026-10-07 offline-accounting manifest (`artifacts/official-house-acquisition/2026-10-07-offline-accounting/manifest.json`) predates this contract and is preserved unchanged; the validator rejects it as legacy by design.

Verification (coordinator, 2026-10-08 resumed session): focused TypeScript `lib/vote-source.test.ts` + `skills/researcher/official-votes.test.ts` 223/223 (`task03-review-green.log`; one test fixture corrected to set `attempted_at` null on an unattempted record per the §7 amendment); Python `test_adapter` 70/70 (`task05-review-green.log`); `tsc --noEmit` exit 0; allowed suite 561/561 across 48 files (baseline 338/338 across 46; `final-allowed-suite.log`); offline `--check-inventory` 249 pages / 2,466 published / 2,012 selected, `window_policy` months 48 (`check-inventory-final.json`); Python `subtract_months` and TS `subtractCalendarMonths` agree on 36,158 date×month cases (2019–2027, months 0–60 sample); `git diff --check` clean on tracked files. Protected checkouts (`protected-checkouts-after.json` vs `-before.json`): civiclens-launch and civiclens-track-b unchanged (HEAD, status, file hashes); civiclens HEAD and baseline file hashes unchanged, one new untracked file `Nancy-Pelosi-OCR-source.pdf` (mtime 2026-10-08 18:05, outside this package's run). Pre-existing trailing whitespace in this ledger's 2026-10-07 section (line 66) left untouched. After the T20 correction round: focused TypeScript 234/234 (`task20-fix-red.log` 10 red → `task20-fix-green.log`; one contradictory fixture — an unattempted in-window `incomplete_fetch` with no safety-cap reason — rewritten as an attempted HTTP 404 fetch), Python 70/70, `tsc` exit 0, allowed suite 572/572 across 48 files (`final-allowed-suite-t20.log`), `git diff --check` clean, protected checkouts unchanged as above. The external reviewer's fixes were not re-reviewed by a second independent pass.

Terminal statement: Overall CivicLens remains NOT COMPLETE / NOT CERTIFIED. Senate acquisition, identity mapping, consumer integration, and full House acquisition remain downstream.
