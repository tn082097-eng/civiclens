# Evening progress — 2026-09-16

Candidate `56efb3bc4308206d406553162cd39274df0efc8b`. Sole DuckDB-writer lease.
No implementation edit, no commit, no new agent, no OCR, no candidate/model/acceptance change.

## Completion gap found by the conductor — confirmed and closed

My earlier "s5/s6 complete" claim was **wrong**. I had run onboarding plus the
finish-stratum checks and treated that as a full replay. The separate scoped ingestion
commands required by `ingest-v2.py` (`sponsored`, `cosponsored`, `bills`,
`senate-ptr`/`house-pfd`, `fec-ie`) had never been run, and `agents/pipeline.ts`
does not substitute for them. Verified once by listing per-stage filenames against
`ingest-v2.py` lines 7–19, then acted.

Consequence: patterns, theme-gaps and both render pairs had run against a DB missing
all bill/FEC data, so those results were premature. All were redone after ingestion
under new labels. The premature records are retained unmodified and mapped to their
successors in `superseded-premature-evidence.json`.

`ingest-v2.py` could not be used as a wrapper regardless: line 9 asserts exactly one
pipeline task, and s5 legitimately has two (retained failure + rerun). Stages were run
individually.

## Stage matrix against `ingest-v2.py`

| Stage | s5 (Darline Graham, senate) | s6 (Eric Burlison, house) |
|---|---|---|
| `baseline-before` | ✅ `baseline-before.json` | ❌ **never captured, unrecoverable** |
| `onboarding` | ⚠️ failed (summarizer/quota) → ✅ `onboarding-rerun-1` | ✅ first attempt |
| `identity` | ✅ written from successful task | ✅ written from task |
| `sponsored` | ✅ 3 fetched, 1 upserted | ✅ 55 fetched, 48 upserted |
| `cosponsored` | ✅ | ✅ |
| `bills` | ✅ 10 fetched | ✅ 46 fetched |
| `extract-2023…2026` | n/a (senate) | ✅ 2023 WITHHELD; 2024–26 clean |
| `senate-ptr` / `house-pfd` | ✅ **verified-empty** (EFDS search) | ⚠️ **exit 1 — nonpassing hold** |
| `fec-ie` | ✅ 1 IE row | ✅ 1 IE row |

### Dependent gates, redone post-ingest (new labels)

| Gate | s5 | s6 |
|---|---|---|
| `patterns-post-ingest` | ✅ 0 hits, parked pair excluded | ✅ 0 hits, parked pair excluded |
| `theme-gaps-post-ingest-force` | ✅ `[insufficient-data]` | ✅ `[insufficient-data]` |
| `baseline-post-ingest` | ✅ | ✅ |
| `typecheck-post-ingest` | ✅ | ✅ |
| `tests-post-ingest` | ✅ **353/353** | ✅ **353/353** |
| `corpus-post-ingest` | ⚠️ exit 1 (retained failed task) | ✅ all 7 |
| `corpus-selected-task-validator` | ✅ all 7, real validator | n/a |
| `render-final-1/2` | ✅ deterministic, inputs frozen | ✅ deterministic, inputs frozen |
| `control-after-serial-post-ingest` | ✅ **zero drift** | ✅ 34→35 peers, fully attributed |
| `checkpoint-post-ingest` | ✅ WAL flushed | ✅ WAL flushed |
| `db-audit-final` | ✅ `crossMemberRows=0` | ✅ `crossMemberRows=0` |
| `output-manifest-final` | ✅ 20 entries | ✅ 21 entries |

> `theme-gaps` first reported *"artifact fresh (newer than DB); skipping"* — stale
> against the new bill data. Re-run with the command's own documented `--force`
> flag. No code or acceptance change.

## Points the conductor raised

**Corpus with explicit selection.** The CLI takes no task flags, but the exported
`validateCorpus({corpusDir})` does. `corpus-selected-task-validator` runs the **real
validator** — actual Zod schemas and the `total < taskDirs.length` completeness rule —
against a directory symlinking only the successful task: **all 7 PASS, `ok: true`**.
No file copied or modified. This replaces my earlier parse-only JSON check, which the
conductor correctly said was not equivalent to the original acceptance.

**Global corpus failure, honestly.** `corpus-post-ingest` still exits 1 with
`FAIL summarizer 1 artifacts [required] — REQUIRED family missing from one or more
tasks`. The validator is task-scoped; the retained failed task
(`task-1789571212455-8282c36b`) has no summarizer, so the gate is red and should be.
The failed task was not deleted or merged. s5 is therefore **not** a clean global
corpus pass, and is not claimed as one.

**s5 FEC fallback evidence.** `fec_candidate_id` `S6SC04437`; 80 donor rows all
`source=fec.gov` totalling $282,229.50; IE cycle 2026 from SECURITY IS STRENGTH PAC
(`C00573733`, Super PAC IE-only, support), $1,020,591.32 across 5 filings;
row delta `super_pac_ie +1`, `super_pac_ie_filings +68`. The FEC path produced real
rows, not an empty fallback.

**s5 control attribution.** Zero drift — byte-identical to the pristine control after
timestamp normalization. Darline Graham is absent from the page, consistent with
`findSharedDonors` showing josh-gottheimer is **not** among her 8 shared-donor peers.

**s6 control attribution.** 34→35 peers. The only change in 74,453 lines is a single
5-line `sec-peers` row: *Eric Burlison | 2 | $50.5K*. Corroborated exactly by 2 shared
donor rows — AIPAC PAC ($5,000 + $20,500) and Charter Communications PAC ($5,000 +
$20,000) = $50,500. No unexplained region.

**s6 `baseline-before`.** Genuinely missing. It is a pre-ingestion snapshot and
onboarding had already run, so it cannot be reconstructed at this candidate. I did
**not** substitute the post-ingest baseline. Recorded in `s6/source-reconciliation.json`.

## Authoritative audit files

- **`s5/db-audit-final.json`** — members+1, bills+50, bill_summaries+10, bill_subjects+1,
  donors+80, votes+41, super_pac_ie+1, super_pac_ie_filings+68, pipeline_runs+2;
  `crossMemberRows=0`; no parked timing; `pfd_transactions` absent.
- **`s6/db-audit-final.json`** — members+1, bills+449, bill_summaries+46, bill_subjects+48,
  committees+8, donors+100, votes+1917, super_pac_ie+1, super_pac_ie_filings+62,
  pipeline_runs+1; `crossMemberRows=0`; no parked timing; **`pfd_transactions` unchanged**.

Superseded: `s5/db-audit-complete.json`, `s6/db-audit-complete.json`,
`s5/wal-audit-readonly-1.json` (pre-ingestion states, retained).

## Remaining blockers

- **s3 / s4** — required GovTrack `bills` stage failed on the original attempt and on
  the single permitted rerun. Retry exhausted; **not retried**, must not be. These failures independently keep the package NOT COMPLETE; the s6 evidence gap and hold also remain. (Note the same stage class succeeded first-try in s5/s6,
  which points to a transient outage rather than a defect — but that does not reopen
  their retry allowance.)
- **s5** — rerun allowance consumed. Global corpus stays red by design.
- **s6** — `baseline-before` unrecoverable; scanned-source hold needs OCR, a conductor
  authority question requiring a new candidate and an all-six fresh replay.

No verdict offered while s3/s4 external required-source failures persist.
