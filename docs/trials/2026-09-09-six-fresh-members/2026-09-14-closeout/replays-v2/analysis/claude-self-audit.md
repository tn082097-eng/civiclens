# Claude self-audit of the Track B six-fresh-member closeout

(Not the protocol's independent certification review — see caveat.)

Reviewer: Claude (Opus 5). Date: 2026-09-16. Mode: read-only audit.

> **Independence caveat — read this first.** The same agent (Claude) executed
> the s5 WAL resolution, the s5 rerun, and the s6 stages. This audit therefore
> reviews, in part, its own work, and does NOT satisfy the protocol's
> requirement for an independent final certification review. It is a
> self-audit: useful for catching internal inconsistency, not a substitute for
> a reviewer who did not execute these strata. Findings below should be
> weighted accordingly, and the strata this agent executed (s5, s6) warrant
> the most scrutiny from a genuinely independent reviewer.

Candidate: `56efb3bc4308206d406553162cd39274df0efc8b` on `codex/track-b-certification`.
Evidence commit: `0353529` "Record candidate replay evidence and explicit Track B blockers".

## Verdict

**NOT CERTIFIED — and the package correctly says so.**

(Subject to the independence caveat above: this is a self-audit, not the
independent review the protocol requires.)

This review does not grant certification and does not lift any gate. It confirms
that the evidence package is internally consistent, that its stated blockers are
real, and that no acceptance rule was bent to manufacture a pass. Two
documentation defects were found. Neither changes the verdict.

Certification remains barred by `protocol.md`: all six strata must pass on the
applicable final code, and a formatting hold is not a pass.

## What was verified mechanically

Every claim below was re-derived from the repo or the evidence JSON, not taken
from a summary.

| Check | Result |
|---|---|
| Evidence commit matches manifest | 223 files, zero drift both directions |
| Evidence/implementation separation | all 223 under `docs/`; no source file in the evidence commit |
| Implementation frozen | candidate is ancestor of HEAD; `0353529` is the ONLY commit between |
| Confirmatory registry hash | live `f9037353…` == recorded `f9037353…` |
| Timing detectors | both `trade-vote-alignment` and `spousal-trade-timing` still `registered`, unconsumed |
| Parked timing rows | `parkedTimingRows = []` in all six strata |
| Cross-member isolation | `crossMemberRows = 0` in all six strata |
| Chamber branch rule | correct in all six; no House loader on a senator, no Senate loader on a rep |
| Identity resolution | all six bioguides match the protocol's frozen selections |
| Test suite | 353/353 pass, 0 fail, 0 skipped |
| Excluded test files | exactly 2 of 52: `timing-detectors-baseline.test.ts`, `confirmatory-guard-inpath.test.ts` — both forbidden runner-class |
| TypeScript | exit 0, all six |
| Artifact families | 7/7 in s1, s2, s3, s4, s6; s5 7/7 on its successful task |
| Render determinism | byte-identical after timestamp normalization in s1, s2, s5, s6 |
| Production DB | `a766c891…` at `~/Developer/civiclens` — untouched |
| Track-b checkout DB | `cc752c5c…` — unchanged |
| Working tree | still exactly the 3 preserved dirty docs |
| Push state | no `origin/codex/track-b-certification`; nothing pushed |

## Blockers (confirmed real, not artifacts of bookkeeping)

**1. s3 / s4 — external source failure, retries exhausted.**
Cleo Fields and Chris Van Hollen both failed `--load-bills` Pass 2 at GovTrack
`/api/v2`, on the original attempt and the one permitted rerun. The evidence
correctly classifies this as external, with a read-only reachability probe
showing the endpoint swinging between ~0.21s, ~28s, and unreachable within
minutes while `govtrack.us` root and `api.congress.gov` stayed healthy. DB file
hash unchanged across both failed attempts in both strata — the loader failed
closed. Neither stratum is a pass; neither is `verified-empty`. Lifting this
needs explicit maintainer authority.

**2. s6 — withheld scanned filing.**
Burlison DocID 8219414 has a 2-byte text layer. Recorded `withheld` /
`needs_manual_formatting`, reason `empty-input`, OCR not invoked. 2024/2025/2026
are genuine `verified-empty` against the authoritative Clerk index.
`pfd_transactions` row delta is 0 — row-level proof the hold entered nothing.
Correctly handled, and correctly not a pass.

**3. s6 — `baseline-before` never captured.**
Honestly recorded as unrecoverable; explicitly NOT substituted with a post-run
check. The conductor refused that substitution, which is the right call.

## Findings

### Finding 1 — `s6/identity.json` carries an incorrect explanatory note (low severity, evidence hygiene)

`s6/identity.json` and `s5/identity.json` contain a byte-identical `note`:

> "ingest-v2.py normally emits this, but it asserts exactly one pipeline task;
> s5 legitimately has two (retained failure + rerun), so stages were run
> individually."

That justification is true of s5 and false of s6. s6 onboarded successfully on
the first attempt (`onboarding.json` exit 0) and references exactly one task,
`task-1789604336595-31f470a0`. The note was copied from s5 without adaptation.

The substantive fields are correct — slug, bioguide B001316, chamber house, and
task id all verify against `onboarding.json` and the DB audit. Only the
explanation is wrong.

Impact: none on the verdict. It matters because a reader auditing s6 could
conclude s6 had a retained failure and a rerun, which would wrongly imply s6
consumed its manual rerun allowance. It did not. Recommend correcting the note
to state the actual reason s6's stages were run individually.

### Finding 2 — stale acceptance-check line in `final-certification-review.md` (low severity, documentation)

Under "Acceptance checks" the file asserts:

> "Every selected-member page rendered deterministically twice."

At this candidate that is not true for s3 and s4, which have no render artifacts
at all. This is not a missing-evidence defect: both `external-failure.json`
records explicitly list `renders` under `stageNotReached`, because the bills
stage failed before rendering was reached. The claim is a leftover from the
historical draft describing the earlier trial.

`closeout-review.md` states the current position accurately ("s1/s2 each
produced matching renders"), so the two documents disagree. The stale line sits
above the "Historical draft below" marker, in the section a reader would take as
current. Recommend scoping it to the strata that reached rendering.

## Points of quality worth recording

These are places where the package resisted an easy shortcut:

- **s5 corpus failure preserved, not laundered.** Global `validate:corpus` still
  exits 1 because the retained failed task genuinely lacks summarizer,
  code-checker, and final-review (4/7). The successful task was validated
  separately at 7/7 by the real validator. The failed task was not deleted or
  merged. Per-task artifact hashes are recorded for both.
- **The s5 WAL correction.** An earlier claim that s5's DB was unchanged rested
  on the file hash alone, while an 88KB WAL held 124 uncommitted rows from the
  failed onboarding. This was caught, corrected in writing, and re-audited
  WAL-aware. A file hash alone is now explicitly rejected as proof of unchanged
  logical state.
- **The premature-evidence correction.** s5/s6 were once described as complete
  before the scoped ingestion stages had run. The superseded records were kept
  unmodified and mapped to successors in `superseded-premature-evidence.json`
  rather than overwritten.
- **s6 control drift attributed exactly.** The Gottheimer control page gained
  one peer row. Attributed to exactly 2 shared donors: AIPAC PAC
  ($5,000 + $20,500) and Charter Communications PAC ($5,000 + $20,000) = $50,500,
  matching the rendered "2" and "$50.5K" against a live `findSharedDonors` query.
  DB hash unchanged across the query. No unexplained region.
- **Bills stage succeeded in s5 and s6 first try.** Same stage class that failed
  externally in s3/s4. Corroborates the external-cause classification and means
  neither s5 nor s6 consumed a retry.

## Recommendation

The package is sound as a documented negative. Three paths, in the order I would
consider them:

1. **Fix the two documentation findings.** Small, no new authority needed, and
   it removes the only internal inconsistencies a future reader would trip on.
2. **Decide on the OCR path.** This is the only route to certification. It
   requires a NEW frozen candidate and an all-six fresh replay — including s1/s2,
   which currently pass. It also makes the s3/s4 retry question moot, since a
   fresh replay gives both clean attempts. Largest effort; needs explicit
   authorization.
3. **Do not lift the s3/s4 retry boundary on its own.** It buys five-of-six and
   still no certification, because s6 stays held regardless, and the
   authorization is likely wasted if OCR follows.

No production write, merge, push, publication, deployment, OCR, or confirmatory
run occurred during this review. The working tree, HEAD, and both databases are
byte-identical to their pre-review state.
