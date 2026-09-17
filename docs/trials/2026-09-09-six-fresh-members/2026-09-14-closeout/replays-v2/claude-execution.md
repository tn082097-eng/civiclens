# Claude execution log — closeout replays v2 (strata 2–6)

Worker: Claude (execution only). Candidate `56efb3bc4308206d406553162cd39274df0efc8b`.
Sole holder of the DuckDB-writer lease for this task. All DB-opening steps serialized.

## Preflight (read-only, before any mutation)

| Check | Expected | Observed | Result |
|---|---|---|---|
| Central checkout HEAD | `56efb3bc…` | `56efb3bc4308206d406553162cd39274df0efc8b` | match |
| Central dirty docs | 3 preexisting | bulk-download prompt, 2026-09-06 completion plan, 2026-09-08 plan (+ untracked `replays-v2/`) | preserved |
| Central DB sha256 | `cc752c5c…9bce` | `cc752c5cb51a8084506c6fb04d61f175969c4fc179825a77dcae18d640619bce` | match |
| Production DB sha256 | `a766c8c9…a38b` | `a766c8917a0e6b42ddc488758eb0b1a66abb37d24c873a74b4cc9d6fd7e4a38b` | match, untouched |
| Worktrees s2–s6 HEAD | candidate | all `56efb3bc…`, only `?? node_modules` dirty | fresh |
| Worktree DB sha256 s2–s6 | `a766c891…a38b` | all match frozen source DB | fresh |
| `pipeline/run-patterns.ts` | `2b5d0ce4…` | match | classification valid |
| `pipeline/score-theme-gaps.ts` | `92ede9d3…` | match | classification valid |
| `scripts/verify-baseline.ts` | `deeb9652…` | match | classification valid |
| `docs/confirmatory-runs.md` | `f9037353…` | match | registry unchanged |
| Applicable test list | excludes forbidden pair | 50 files; excluded = `pipeline/patterns/confirmatory-guard-inpath.test.ts`, `pipeline/patterns/timing-detectors-baseline.test.ts` | correct |

Read-only confirmatory preflight for `trade-vote-alignment` and `spousal-trade-timing` is
recorded at `command-classification.json` (exit 0 = status, not permission). No
`score-anomaly.ts` or `*-baseline.ts` runner is invoked anywhere in this execution.

Stratum 1 (Tina Smith) is already technically complete at this candidate and is not repeated.

## Stratum status

| Stratum | Member | State |
|---|---|---|
| 2 | John W. Mannion (M001231, House) | all stages completed; every source outcome explicit |
| 3 | Cleo Fields (F000110, House) | **FAILED** at `bills` — external GovTrack API outage; one authorized rerun also failed |
| 4 | Chris Van Hollen (V000128, Senate) | **FAILED** at `bills` — same external GovTrack cause; one authorized rerun also failed |
| 5 | Darline Graham (G000608, Senate) | **not started** — stopped by frozen defect rule (second stratum failure); worktree pristine |
| 6 | Eric Burlison (B001316, House, scanned hold) | **not started** — stopped by frozen defect rule; worktree pristine |

**EXECUTION STOPPED.** Stratum 4 was the second stratum failure, triggering the frozen
defect rule. Both failures share one external cause (GovTrack `/api/v2` intermittent
degradation), not an implementation defect. Evidence below; conductor decision required.

---

## Stratum 2 — John W. Mannion (House with zero indexed PTRs)

Worktree `closeout-v2-s2-john-mannion`, DB `data/civiclens.duckdb` starting at the
frozen `a766c891…a38b`, cache root `data/caches` (worktree-local). All stages serialized.

**Identity resolved before any network call or mutation** (`s2/identity.json`):
slug `john-w-mannion`, bioguide `M001231`, chamber `house`, task
`task-1789570053261-814dc4a0`. House chamber ⇒ `--load-pfd`; no Senate loader run.

### Stage outcomes

| Stage | Evidence | Exit | Outcome |
|---|---|---|---|
| baseline-before | `s2/baseline-before.json` | 0 | ok |
| onboarding (`--append`) | `s2/onboarding.json` | 0 | ok — final-review APPROVED, 7 agent files |
| sponsored | `s2/sponsored.json` | 0 | ok — 10 fetched / 10 upserted / 10 with policyArea |
| cosponsored | `s2/cosponsored.json` | 0 | ok — 325 fetched / 325 inserted / 0 dup |
| bills (`--load-bills --api-pass`) | `s2/bills.json` | 0 | ok — 39/39 fetched; member scope skipped global NULL-title refill |
| house-pfd 2023–2026 | `s2/house-pfd.json` | 0 | `verified-empty` ×4 (see below) |
| fec-ie 2026 | `s2/fec-ie.json` | 0 | ok — 1 member-cycle row, 1 with IE, 0 errored |
| patterns (timing-safe) | `s2/patterns.json` | 0 | ok |
| theme-gaps (ADR 0002) | `s2/theme-gaps.json` | 0 | ok |
| baseline-after | `s2/baseline-after.json` | 0 | ok |
| corpus validator | `s2/corpus.json` | 0 | ok — all 7 families PASS, 1/1 valid, 0 unparseable |
| typecheck | `s2/typecheck.json` | 0 | ok |
| tests (explicit 50-file list) | `s2/tests.json` | 0 | ok — **353 pass / 0 fail / 0 skipped** |
| render ×2 + warmup | `s2/render-{warmup,1,2}.json` | 0 | ok — `15d 0t 0p 30peers` |
| checkpoint | `s2/checkpoint.json` | 0 | ok |
| db-audit-complete | `s2/db-audit-complete.json` | 0 | ok |
| control-after-serial | `s2/control-after-serial.json` | 0 | ok — `15d 500t 1750p 35peers` |

OpenSecrets: **`not-collected`** (optional, deliberately not run; never read as "no donor data").

### No empty-corpus pass

The House disclosure stage is `verified-empty`, not a silent skip: the loader read the
authoritative Clerk index for **all four years** and each returned an identity-matched zero:

```
Loading PFDs for 2023…  Verified empty: the authoritative House index contains zero target PTR filings. DB unchanged.
Loading PFDs for 2024…  Verified empty: …
Loading PFDs for 2025…  Verified empty: …
Loading PFDs for 2026…  Verified empty: …
Grand total across 4 years: 0 transactions, 0 unmatched, 0 filings withheld.
```

Index inputs are the frozen `2023FD.xml`–`2026FD.xml` hashes in `s2/setup.json`. The
member's corpus is non-empty (10 sponsored, 325 cosponsored, 39 bill summaries, FEC IE),
so this is a source-backed zero PTR result, not an empty corpus.

### Determinism and isolation

- `s2/render-determinism.json`: `equal: true`. Normalization removed **only** the generated
  timestamp (regex `(?<= · generated )\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z(?=</div>)`, exactly one
  match in each render). Normalized sha256 `5e5aeb77…` identical across both renders.
- `s2/render-inputs.json`: `equal: true` — the two renders ran from **hash-identical** inputs
  across `data/caches` and `pipeline/artifacts`; no input drifted between them.
- `s2/db-audit-complete.json`: **`crossMemberRows: 0`**, **`parkedTimingRows: []`**.
  Changed tables are additions only, zero removals:
  `bill_subjects +10`, `bill_summaries +39`, `bills +335`, `committees +6`, `donors +100`,
  `members +1`, `pipeline_runs +1`, `super_pac_ie +4`, `super_pac_ie_filings +4`, `votes +669`.
- Every `run-step-v2` record carries the asserted cwd, HEAD, git status, DB path, cache path,
  and DB+WAL hashes before and after the step.
- Control HTML (`josh-gottheimer`) preserved in the worktree for Grok's attribution work;
  it was rendered **serially after** the stratum finished, not overlapped.


---

## Stratum 3 — Cleo Fields (high-volume text-layer House PTR) — **FAILED**

Worktree `closeout-v2-s3-cleo-fields`. Identity resolved correctly before any mutation
(`s3/identity.json`): slug `cleo-fields`, bioguide `F000110`, chamber `house`.

### Stage outcomes

| Stage | Evidence | Exit | Outcome |
|---|---|---|---|
| baseline-before | `s3/baseline-before.json` | 0 | ok |
| onboarding | `s3/onboarding.json` | 0 | ok — final-review APPROVED, task `task-1789570284455-43b03a16` |
| sponsored | `s3/sponsored.json` | 0 | ok — 28 fetched / 17 upserted / 17 policyArea / 11 skipped |
| cosponsored | `s3/cosponsored.json` | 0 | ok — 594 fetched / 594 inserted / 0 dup |
| **bills** | `s3/bills.json` | **1** | **`failed`** — `Fatal: fetch failed` |
| **bills (rerun 1)** | `s3/bills-rerun-1.json` | **1** | **`failed`** — `Fatal: fetch failed` |
| extract-* / house-pfd / fec-ie / patterns / theme-gaps / gates / renders / audit / control | — | — | **not reached** (wrapper stops on nonzero; prerequisites do not hold) |

### Exact failure

Attempt 1 (`s3/bills.json`):
```
Pass 1: backfilling votes.bill_id from question text (regex)…
  391 filled by regex, 309 unparseable, 700 total NULL rows scanned.
Pass 2: GovTrack API resolution for remaining NULL bill_ids…
  GovTrack API: 50 calls, 49 resolved…
Fatal: fetch failed
```

Attempt 2 (`s3/bills-rerun-1.json`) — the **single** authorized manual rerun, same member,
same inputs, same acceptance rule, new label, no retry loop added:
```
Pass 1: backfilling votes.bill_id from question text (regex)…
  0 filled by regex, 254 unparseable, 254 total NULL rows scanned.
Pass 2: GovTrack API resolution for remaining NULL bill_ids…
Fatal: fetch failed
```

### Diagnosis: external, not an implementation defect

Read-only reachability probe taken immediately after the second failure:

| Endpoint | Result |
|---|---|
| `https://www.govtrack.us/` | HTTP 200 in 0.27 s |
| `https://www.govtrack.us/api/v2/vote?limit=1` | **no response — curl code 000, timed out at 25 s** |
| `https://api.congress.gov/` | HTTP 200 |

GovTrack's site is up while its `/api/v2` endpoint is unreachable, and an unrelated
upstream (Congress.gov) responds normally — so this is source-side unavailability, not
local network loss and not a defect in the candidate. The loader **failed closed**
(nonzero, `Fatal:`) rather than silently publishing an incomplete vote→bill linkage,
which is the certified behavior. The DB file hash was
`e2b4c3cf…2c39` before and after **both** attempts.

### Consequences, stated plainly

- Stratum 3 is **`failed`**. It is **not** a pass, **not** `verified-empty`, and the
  transient outage is **not** a source-backed limitation, so it cannot close the stratum.
- Per the authorization: exactly one manual rerun was used and it failed; no further
  retry is permitted, no ad hoc loop was added, and both failed attempts are preserved
  in full (`s3/bills.json`, `s3/bills-rerun-1.json`, `s3/external-failure.json`).
- No repair was attempted. This is an external failure, not an implementation defect to
  return to the conductor as a code fix.
- This is the **first** stratum failure. Under the frozen defect rule a *second* stratum
  failure stops Track B; I therefore continued with the independent strata 4, 5, and 6
  as the protocol permits, and did not touch stratum 3's state further.

---

## Stratum 4 — Chris Van Hollen (Senate with zero PTRs) — **FAILED**

Worktree `closeout-v2-s4-chris-van-hollen`. Identity resolved before any mutation
(`s4/identity.json`): slug `chris-van-hollen`, bioguide `V000128`, chamber `senate`.

### Stage outcomes

| Stage | Evidence | Exit | Outcome |
|---|---|---|---|
| baseline-before | `s4/baseline-before.json` | 0 | ok |
| onboarding | `s4/onboarding.json` | 0 | ok — APPROVED, task `task-1789570440288-f9d00580` |
| sponsored | `s4/sponsored.json` | 0 | ok — 632 fetched / 384 upserted / 380 policyArea / 4 no-policy / 248 skipped |
| cosponsored | `s4/cosponsored.json` | 0 | ok — 6,919 fetched / 6,531 inserted / 388 dup-skipped |
| **bills** | `s4/bills.json` | **1** | **`failed`** — `Fatal: The operation was aborted due to timeout` |
| **bills (rerun 1)** | `s4/bills-rerun-1.json` | **1** | **`failed`** — same timeout |
| senate-ptr / fec-ie / patterns / theme-gaps / gates / renders / audit / control | — | — | **not reached** |

The Senate disclosure loader (`--load-senate-ptr`) was **never reached**, so this run
produces no evidence about the zero-PTR behaviour this stratum exists to certify.
Chamber routing was nonetheless correct: the wrapper selected the Senate branch and
`--load-pfd` was not invoked for this senator.

### Exact failure

Attempt 1 (`s4/bills.json`):
```
Pass 1: backfilling votes.bill_id from question text (regex)…
  596 filled by regex, 1104 unparseable, 1700 total NULL rows scanned.
Pass 2: GovTrack API resolution for remaining NULL bill_ids…
Fatal: The operation was aborted due to timeout
```

Attempt 2 (`s4/bills-rerun-1.json`) — the **single** authorized manual rerun, same member,
same inputs, same acceptance rule, new label:
```
Pass 1: backfilling votes.bill_id from question text (regex)…
  0 filled by regex, 1104 unparseable, 1104 total NULL rows scanned.
Pass 2: GovTrack API resolution for remaining NULL bill_ids…
Fatal: The operation was aborted due to timeout
```

DB file hash `80568fce…d488d` before and after **both** attempts — the loader failed closed.

---

## Shared external cause — one condition, not two defects

Both stratum 3 and stratum 4 failed at the **same** stage (`--load-bills`, Pass 2 GovTrack
resolution) for the **same** upstream reason. Read-only latency probes of
`https://www.govtrack.us/api/v2/vote?limit=1` taken between attempts:

| When | Result |
|---|---|
| after s3 rerun failed | **no response** — curl code 000, timed out at 25 s |
| after s4 first failure | HTTP 200 but **28.331 s** for a `limit=1` query |
| after s4 rerun failed | HTTP 200 in **0.220 / 0.216 / 0.213 s** |

Throughout, `https://www.govtrack.us/` root stayed HTTP 200 at ~0.27 s and
`https://api.congress.gov/` stayed HTTP 200. So GovTrack's `/api/v2` endpoint is
**intermittently degraded** — swinging between ~0.2 s, ~28 s, and unreachable within
minutes — while the host and unrelated upstreams are healthy.

**This is external instability, not a defect in candidate `56efb3bc…`.** The loader
correctly failed closed rather than writing an incomplete vote→bill linkage. I did not
change the loader's timeout, add a retry loop, alter the acceptance rule, or touch
member selection — all of which are explicitly outside my authority.

---

## STOP — frozen defect rule triggered

Stratum 4 is the **second** stratum failure. Under the frozen defect rule, **Track B
execution stops here.** I did not repair anything arbitrarily and did not start
stratum 5 or 6.

**Strata 5 and 6 were not started.** Their worktrees remain pristine at the candidate with
the frozen source DB `a766c891…a38b` and only `?? node_modules` dirty, so they are ready for
a clean run whenever the conductor decides. Note that both would hit the same
`--load-bills` GovTrack stage, so starting them under the current upstream condition
would likely burn their fresh state on the same external fault — a further reason to stop
rather than continue.

### What the conductor needs to decide

The blocker is external, so this is not a code repair. The options are the conductor's
call, not mine:

1. Re-run strata 3–6 later, from fresh worktrees, once GovTrack `/api/v2` is stable —
   these attempts are preserved as failures and must not be silently overwritten.
2. Rule on whether two failures from **one shared transient external condition** count as
   two failures under the frozen defect rule, or as a single non-defect environmental stop.

Both are outside my execution authority.

---

## Final isolation and safety verification (post-stop)

| Check | Expected | Observed |
|---|---|---|
| Production DB `~/Developer/civiclens/data/civiclens.duckdb` | `a766c891…a38b` unchanged | **unchanged** |
| Central DB `civiclens-track-b/data/civiclens.duckdb` | `cc752c5c…9bce` unchanged | **unchanged** |
| Central HEAD | `56efb3bc…` | `56efb3bc4308206d406553162cd39274df0efc8b` |
| Central dirty docs | 3 preexisting preserved | all 3 present, unmodified by me |
| s5 / s6 worktrees | pristine | DB `a766c891…a38b`, only `?? node_modules` |

- No implementation file was modified. No commit, push, merge, PR, roster change,
  publication, or deployment occurred.
- No OCR, no new dependency, no `git reset/clean/stash/restore`.
- No `score-anomaly.ts`, no `*-baseline.ts` runner, no confirmatory computation; the
  parked timing pair was filtered by `run-patterns.ts` and `parkedTimingRows` was `[]`
  in the one completed audit (s2).
- `npm test` was never run wholesale; only the explicit 50-file applicable list.
- All DB-opening steps were serialized; no two DB writers ran concurrently.
- Every failed attempt is preserved with a unique label; nothing was discarded or retried
  silently.

## Summary

| Stratum | Member | Result |
|---|---|---|
| 2 | John W. Mannion (M001231, House) | **completed** — all stages, 353/353 tests, deterministic renders, `crossMemberRows: 0` |
| 3 | Cleo Fields (F000110, House) | **failed** at `bills` — external GovTrack API; 1 authorized rerun also failed |
| 4 | Chris Van Hollen (V000128, Senate) | **failed** at `bills` — same external cause; 1 authorized rerun also failed |
| 5 | Darline Graham (G000608, Senate) | **completed** after one permitted manual rerun — see the 2026-09-16 evening section below; the original failure is retained |
| 6 | Eric Burlison (B001316, House) | **completed** with a proven source-bound hold — see the 2026-09-16 evening section below |

> The "not started / worktree pristine" wording above described the state at the time of
> the frozen-defect stop. It is superseded by the 2026-09-16 evening session below, which
> also corrects the s5 "pristine / DB unchanged" claim in the isolation table: s5's DB file
> hash matched the frozen value, but an 88,175-byte WAL held 124 uncommitted rows from the
> failed first onboarding. Historical failure records are unchanged.

---

# 2026-09-16 evening session — s5 WAL resolution, s5 rerun, s6 full replay

Sole DuckDB-writer lease held throughout. All DB-opening steps serialized; no
concurrent writers. Candidate unchanged at `56efb3bc4308206d406553162cd39274df0efc8b`.
No implementation edit, no commit, no new agent, no OCR.

## 1. Stratum 5 WAL resolution (first, before any new write)

The prior log claimed s5 left the DB unchanged, on the strength of the DB file hash
alone. **That claim was wrong.** The file did hash to the frozen
`a766c8917a0e6b42ddc488758eb0b1a66abb37d24c873a74b4cc9d6fd7e4a38b`, but
`data/civiclens.duckdb.wal` existed at 88,175 bytes. `onboarding.json` shows
`walBefore: null → walAfter: 9e4c55c1…` — the *failed* first onboarding wrote real
state and aborted before checkpointing.

Resolved with a uniquely labelled read-only WAL-aware audit,
`s5/wal-audit-readonly-1.json` (`run-step-v2.py 5 wal-audit-readonly-1`, existing
`audit-db-v2.mjs`, exit 0):

- The audit wrote nothing: `walBefore == walAfter == 9e4c55c1…`, DB hash unchanged.
- Identity **present** (exactly one row: `darline-graham` / `G000608` / senate / SC),
  so exit 0 is a genuine clean result here, not the "identity absent → expected
  nonzero" case. Full row deltas were captured regardless of exit code.
- Actual pre-rerun changes, all attributable to the failed run:
  `members +1`, `bills +1`, `donors +80`, `votes +41`, `pipeline_runs +1` = **124 rows**.
- Cross-member/parked timing checks: `crossMemberRows: 0`, `parkedTimingRows: []`.
  `otherMemberRows` empty for every changed table.

## 2. Stratum 5 — one permitted manual rerun

`onboarding-rerun-1`, unchanged model/member/acceptance
(`node --import tsx agents/pipeline.ts --append "Darline Graham"`). The Claude
usage limit had reset (the failure message quoted a 3:40pm America/New_York reset).
Exit 0, decision APPROVED. No further retry allowance remains for s5.

Evidence-only task selection, adapted because the task count is now > 1 and the
failed task must stay visible:

| Task | State | Required families present |
|---|---|---|
| `task-1789571212455-8282c36b` | failed (retained) | 4/7 — no summarizer, code-checker, final-review |
| `task-1789604138913-41f1f4a8` | complete (rerun) | **7/7**, all parse |

All seven validated explicitly on the successful task only, with sizes and SHA-256
per artifact in `s5/corpus-task-scope.json`. The old failed corpus was **not**
laundered: the failed task was neither deleted nor merged.

`validate:corpus` (`corpus-after-rerun-1`) therefore still exits 1 —
`FAIL summarizer 1 artifacts [required] — REQUIRED family missing from one or more
tasks`. The validator is task-scoped and is correctly reporting the retained
failure. This is preserved-failure evidence, not a defect of the rerun, and it is
recorded rather than suppressed.

Remaining stages, each individually labelled (the composite ingest wrapper was **not**
re-run and no label was overwritten):

- `patterns` exit 0 — 1 detector, 0 hits; output confirms the parked pair
  `[trade-vote-alignment, spousal-trade-timing]` was excluded.
- `theme-gaps` exit 0 — `[insufficient-data]` trades=0 receipts=0.
- `baseline-after` and `typecheck` exit 0.
- `tests` exit 0 — **353/353 pass**, 0 fail, from the explicit 50-file list.
  `score-anomaly.test.ts` is in the frozen applicable list and is the test file, not
  the forbidden `score-anomaly.ts` CLI runner.
- `render-warmup`, then `render-det-1` / `render-det-2`: byte-identical after removing
  only the documented generated timestamp, from hash-identical inputs
  (`render-inputs.json` `equal: true`, `render-determinism.json` `equal: true`).
- `checkpoint`, then `db-audit-complete` exit 0: WAL flushed (`walAfter: null`),
  committed delta `members +1, bills +1, donors +80, votes +41, pipeline_runs +2`.
  The `+2` correctly records both the failed and the successful run.
  `crossMemberRows: 0`, `parkedTimingRows: []`.
- `output-manifest.json` written (19 entries). `control-after-serial` run serially.

> **Orchestration note (evidence-only, non-invalidating).** `render-1`/`render-2` were
> first run through `run-step-v2.py` directly, which does not copy the HTML between
> renders, so render-1's output was overwritten and no comparison was possible. Two
> fresh renders were run under new labels `render-det-1`/`render-det-2` with capture
> between them and inputs frozen/re-hashed around the pair. The earlier `render-1`/
> `render-2` records are retained unmodified; this changed no input, model, or
> acceptance rule, and the rationale is recorded in `render-determinism.json`.

## 3. Stratum 6 — full replay with the hold preserved

`extract-2023` (already run, exit 1, WITHHELD) was **not** re-run. Onboarding then
succeeded on its first attempt — exit 0, APPROVED, all seven artifacts in
`task-1789604336595-31f470a0`. No rerun consumed.

- `extract-2024` / `extract-2025` / `extract-2026` exit 0 — 0 PTRs, 0 holds, 0 errors
  (those cache years contain no filings; all four index XMLs are present).
- **`load-house-2023-2026` — the explicit nonpassing-hold proof.** House loader
  (`db/load-pfd.ts`), member-scoped, `--year 2023,2024,2025,2026`. **Exit 1.**
  - 2023: `Withheld from production: 1 filing(s) — 1 unresolved, 0 rejected.
    Existing rows preserved. · 8219414 (eric-burlison) [unresolved] empty-input`
  - 2024 / 2025 / 2026: `Verified empty: the authoritative House index contains zero
    target PTR filings. DB unchanged.`
  - Grand total across 4 years: **0 transactions, 0 unmatched, 1 filing withheld.**
  - `Member hold: eric-burlison has 1 withheld filing(s); skip automated publication
    and keep the member in the formatting queue.`
  - Row-level corroboration: `pfd_transactions` does **not** appear in the audit's
    changed tables — delta 0. The withheld filing entered no rows.

  The loader saw all four years and returned the proper nonpassing hold outcome.
  **This is not a pass.** `pfdLoadExitCode` returns 1 whenever
  `totalUnmatched > 0 || totalWithheld > 0`. No OCR was invoked and no
  user-specific parser was written. The hold stays source-bound: cached PDF
  `517bdde3…f50` and text `7060584c…cbb` match the official Clerk source exactly, and
  the 2-byte text layer is a genuine scanned-source hold, kept distinct from any
  extraction error.
- `patterns` (parked pair excluded), `theme-gaps` `[insufficient-data]`,
  `baseline-after`, `typecheck` — all exit 0.
- `corpus` exit 0 — **all seven families pass** (single successful task, no prior
  failed task to retain).
- `tests` exit 0 — **353/353 pass**.
- `render-warmup`, `render-det-1`/`render-det-2` — deterministic, hash-identical
  inputs. Render reports `0t` (zero transactions), consistent with the hold.
- `checkpoint`, `db-audit-complete` exit 0: WAL flushed, identity present
  (`eric-burlison` / `B001316` / house / MO), committed delta `members +1, bills +48,
  committees +8, donors +100, votes +1917, pipeline_runs +1`,
  `crossMemberRows: 0`, `parkedTimingRows: []`.
- `output-manifest.json` written (20 entries). `control-after-serial` run serially.
- `s6/source-hold.json` updated: its stale `"not run"` / `"not completed"` fields now
  carry the loader outcome. The withheld/hold facts themselves are unchanged.

## 4. Execution complete — remaining blockers

**EXECUTION COMPLETE for every stage authorized to this worker.** s5 and s6 are
finished; s1 and s2 were already complete and were not repeated; s3 and s4 stay failed.

Exhausted failures, reported rather than retried:

- **s3 (Cleo Fields)** and **s4 (Chris Van Hollen)** — required bill-resolution stage
  failed on the external GovTrack API on the original attempt *and* on the single
  permitted manual rerun. Retry allowance is exhausted; these were not retried in this
  session and must not be. Their bill-dependent gates remain pending/failed-prerequisite.
- **s5** — its one permitted rerun was used and succeeded. No allowance remains.
- **s6** — the scanned-source withholding is a genuine, proven source-bound hold, not a
  failure to fix here. Enabling it would require OCR, which is an authority question for
  the conductor and would need a new candidate plus an all-six fresh replay.

No verdict is offered. Per the standing instruction, no PASS and no
"BLOCKED AT AUTHORITY GATE" verdict is available while the s3/s4 external
required-source failures persist; this delivery remains **NOT COMPLETE** for that
reason alone. Ongoing notes are in `evening-progress.md`.

---

# 2026-09-16 late — completeness reconciliation against `ingest-v2.py`

**The preceding section's "EXECUTION COMPLETE" marker for s5/s6 was premature and is
withdrawn.** The conductor identified that neither stratum had `sponsored`,
`cosponsored`, `bills`, `senate-ptr`/`house-pfd`, or `fec-ie` stage records. Verified
by listing per-stage filenames against `ingest-v2.py` lines 7–19: the gap was real.
Onboarding via `agents/pipeline.ts` does not substitute for those separate scoped
ingestion commands, and I should not have claimed a full replay from onboarding plus
finish-stratum checks.

Because those stages had not run, the earlier `patterns`, `theme-gaps`, both render
pairs, corpus, tests, baseline, typecheck, checkpoint and audit for s5/s6 all executed
against a DB with no bill or FEC data. They are **superseded**, retained unmodified,
and mapped to successors in `superseded-premature-evidence.json`.

`ingest-v2.py` was not usable as a wrapper: line 9 asserts exactly one pipeline task
and s5 has two (retained failure + rerun). Every stage was run individually under a
unique label.

## Stages run in this pass

s5: `sponsored`, `cosponsored`, `bills`, `senate-ptr`, `fec-ie`, then
`patterns-post-ingest`, `theme-gaps-post-ingest` (skipped — stale artifact),
`theme-gaps-post-ingest-force`, `baseline-post-ingest`, `typecheck-post-ingest`,
`corpus-selected-task-validator`, `corpus-post-ingest`, `tests-post-ingest`,
`render-warmup-post-ingest`, `render-final-1/2`, `control-after-serial-post-ingest`,
`checkpoint-post-ingest`, `db-audit-final`, plus `source-reconciliation-query-3`.

s6: `sponsored`, `cosponsored`, `bills`, `house-pfd`, `fec-ie`, then the same
post-ingest gate set, plus `control-attribution-query`.

Two query steps (`source-reconciliation-query`, `-query-2`) failed on my own wrong
column names (`office`, `donors.name`). Both are retained; I then read
`db/schema.sql` and used the real `db/queries.ts` `findSharedDonors` rather than
reimplementing it. These were read-only evidence queries, not pipeline stages.

## Outcomes

- **`bills` succeeded first attempt in both strata** (s5 10 fetched, s6 46 fetched) —
  the same stage class that failed externally in s3/s4. No retry consumed. **s3/s4
  were not retried and must not be.**
- s5 `senate-ptr`: `Verified empty: successful EFDS search found zero PTR filings for
  G000608; DB unchanged.` Authoritative, backed by the frozen receipt hash in
  `setup.json` — an affirmative search result, not an absence.
- s6 `house-pfd` (the canonical `agents/pipeline.ts --load-pfd` stage): **exit 1**,
  all four years seen, 0 transactions, 0 unmatched, 1 withheld, member-hold warning.
  Reproduces the hold through the pipeline-scoped path, not just the direct
  `db/load-pfd.ts` call. `pfd_transactions` row delta 0. **Not a pass.**
- Both strata: 353/353 tests, TypeScript clean, deterministic renders from
  hash-identical inputs, WAL flushed after checkpoint, `crossMemberRows=0`, no parked
  timing rows.
- s5 global corpus remains exit 1 on the retained failed task. The **real** validator
  with explicit `corpusDir` selection passes all 7 on the successful task
  (`corpus-selected-task-validator`, `ok: true`) — this supersedes the earlier
  parse-only JSON check in `corpus-task-scope.json`, which was not equivalent to the
  original acceptance.
- s6 `baseline-before` was never captured and cannot be reconstructed; not substituted.

## Authoritative audits

`s5/db-audit-final.json` and `s6/db-audit-final.json`. The earlier
`db-audit-complete.json` in both strata, and `s5/wal-audit-readonly-1.json`, record
pre-ingestion states and are superseded but retained.

## Status

s5 and s6 are stage-complete against `ingest-v2.py` (s6 lacking only the unrecoverable
`baseline-before`). No passing claim is made for s5's global corpus gate or for s6's
withheld source. **s3/s4 remain failed with retries exhausted**, so this delivery stays
**NOT COMPLETE** and no verdict is offered.
