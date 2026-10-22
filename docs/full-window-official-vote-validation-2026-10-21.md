# Official vote full-window validation — 2026-10-21

**Vote-path validation passed; CivicLens is not certified or released.**
The frozen window is 2022-10-21 through 2026-10-21 inclusive (48 calendar
months), bounded to official listings at their recorded retrieval times.

Validation ran before commit on `codex/full-window-validation`, based on merged
commit `e3eb78956c36f1a4a275a8907d2f01f10f2ce6ba`. The production repairs
validated then are the repairs carried by this branch.
The merged commit alone did not pass this validation. The worktree is
`/home/captainanime/Developer/civiclens-full-window-validation`.

## Completed evidence

| Chamber | Required rolls | Source listings | Targets | Persisted rows | Bridge/analysis failures |
|---|---:|---:|---|---:|---:|
| House | 1,989 | 249 pages | H001047, A000370 | 1,989 each; 3,978 total | 0 / 0 |
| Senate | 1,675 | 5 menus | S000033, W000817 | 1,675 each; 3,350 total | 0 / 0 |

Every required roll has a retained complete HTTP 200 body, canonical source URL,
receipt, retrieval timestamps and SHA-256. The listings additionally account for
477 House and 352 Senate rolls outside the window. No caps, sampled inventories,
fixture-map acquisition or invented source receipts were used for these full runs.
No source HTTP request was retried to obtain a passing result.

The hash-locked pinned collector ran offline in a loopback-only namespace. Every
required roll cleared the strict collector/identity/voter/total cross-checks.
Actual member normalization and `planVoteBatch`/`applyVoteBatch` wrote only new
validation DuckDBs. In each chamber the first target's row snapshot remained
unchanged after loading the second. This proves the four selected target paths,
not all-member behavior or complete bill resolution.

Resolution outcomes remain explicit:

- House: 1,944 resolved bills, 20 authoritative non-bills, 25 unsupported records;
  four out-of-service `Not Voting` listings retained as evidence without attributed votes.
- Senate: 708 resolved bills, 954 authoritative non-bills, 12 unsupported records,
  one ambiguous record (`118-2024/s128`, official/pinned bill-identity disagreement).
- Every unsupported/ambiguous resolution keeps a null bill. These outcomes were
  not silently relabeled or counted as successful bill matches.

## Repairs and retained failures

1. The original House capture acquired all response bodies but rejected 623
   metadata records because the historic XML uses explicit House `committee`
   instead of `chamber`. A shared strict helper now supports the explicit label
   combinations in acquisition and bridge extraction. Invalid/duplicate/structured
   labels remain failures. The original incomplete run is unchanged; a separately
   identified offline derivative revalidates the retained bytes with original
   outcomes, timestamps and source hashes preserved.
2. The first Senate replay failed 12 procedural rolls because TypeScript treated
   `documents: []` as a bundle requiring a first item. The narrow consistency fix
   accepts it only with exactly six explicit empty projection fields. It infers no
   bill and retains existing checks for nonempty bundles. The failed replay remains
   unchanged, and neither target was persisted in that failed attempt.

Real regression fixtures and unchanged original receipt records are included as
new local regression files. The detailed [House proof](house-metadata-compatibility-source-2026-10-21.md)
and [Senate proof](senate-empty-document-source-2026-10-21.md) distinguish preparation,
failed executions and completed repaired verification.

Claude Code Opus wrote its plan before dispatching three actual Haiku agents for
source auditing, identity auditing and the replay harness. Codex integrated and
verified the repairs; a separate bounded worker prepared source fixtures/docs.
Independent Opus House review requested three documentation/provenance changes,
all addressed by controller disposition and verified hash-bound replay; no second
House approval is claimed. Independent Opus Senate source review returned APPROVE.
Reviewer source judgments do not substitute for the controller's executed checks.

Final checks: 359/359 vote-path TypeScript tests, 205/205 collector Python tests,
TypeScript typecheck, 16 provenance controls, rejection of altered bodies/proofs,
fixture-to-source byte/receipt equality, original-failure hash integrity, and all
11 protected production/public artifacts unchanged. No production database was
created in the candidate.

## Evidence availability and remaining release gates

A [compact versioned evidence package](validation/2026-10-21-official-votes/README.md)
contains actual summaries, censuses, persistence snapshots, original-failure records,
review outputs and decision-logic copies with a hash manifest. Full raw source captures
and temporary databases remain local; a fresh clone cannot replay the entire window
from this compact package alone.

Canonical full run evidence remains under `artifacts/full-window-validation-2026-10-21/`:

- House: `house-revalidated-committee-2/`; final replay
  `checks/house-offline-replay-3/summary.json`.
- Senate: `senate-20261021T234205Z-52dfcac8/`; final replay
  `checks/senate-offline-replay-2/summary.json`.
- Original failures, reviewer outputs, test logs, provenance controls and protected
  hashes remain in `checks/`; `controller-final-report.md` and
  `checks/final-candidate-fingerprint.json` identify this local result.

The code repairs still need integration. Full six-stratum certification remains
NOT COMPLETE: prior required bill-source failures and exhausted retries cannot
be overwritten, the scanned-disclosure formatting hold remains withheld, a prior
missing baseline cannot be reconstructed, and independent final certification
is outstanding. A properly frozen fresh candidate/protocol must preserve those
records before any new certification execution. This phase ran no member
onboarding, detector/confirmatory analysis, OCR, publication or deployment, and
made no commit, push, merge or production DB change.

## Integration verification — 2026-10-22

The fresh package-wide offline suite exposed one stale test on the existing base:
`db/source-completeness.test.ts` used a short, undated legacy vote ID and mocked
GovTrack JSON after active bill resolution had moved to the official resolver.
Its `verified-empty` expectation failed at identity validation; two rejection
cases passed without reaching their intended mock. The test now seeds a canonical,
dated legacy identity, injects official resolver outcomes, proves the resolver was
called, and separately checks failed, authoritative-non-bill and unsupported
outcomes without treating a missing bill as verified empty. All row snapshots
remain unchanged and no direct fetch is permitted. No loader implementation changed.

Fresh command details and results are in the compact package's
`integration-verification.json`. The original failing run is retained locally;
its digest and the updated test's bounded scope are recorded there. The two
confirmatory-runner test files are explicitly excluded; no confirmatory analysis
was run. Source-acquisition completeness remains the original captured snapshot,
not a new October22 live-window acquisition.
