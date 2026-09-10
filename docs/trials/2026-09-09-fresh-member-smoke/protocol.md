# Fresh-member smoke before six-stratum certification

**Status:** authorized for local execution on 2026-09-09. Production database
writes, push, publication, deployment, OCR, and confirmatory timing runs remain
unauthorized.

This protocol amends, but does not rewrite, the frozen 2026-09-08 Track B
record. The earlier Jerry Moran, Paul Tonko, Jonathan Jackson, and Kevin Cramer
runs are development evidence because their outcomes exposed or influenced code
changes. Alan Armstrong and Brad Sherman were previously selected, and several
other members were probed while constructing that selection. None may be called
an untouched certification test.

## Order and claims

1. Run one never-before-tested House member through the ordinary onboarding
   path in an isolated worktree and scratch database.
2. Treat that result as a smoke test only. A pass establishes one successful
   end-to-end case; it does not establish population-wide reliability.
3. After the smoke closes, select six different untouched members for the six
   fixed certification strata. The smoke member is excluded from that set.
4. A rerun of any exposed member is a regression check only and cannot be
   counted as fresh certification evidence.

## Frozen smoke selection

- Frozen candidate facts: the 2026-09-08 normalized pool, SHA-256
  `e8c82586e2a6ae496f6a9c4ec420e035bdb6f61d614ff7951b7e73179d0afe4f`.
- Frozen source database: SHA-256
  `a766c8917a0e6b42ddc488758eb0b1a66abb37d24c873a74b4cc9d6fd7e4a38b`;
  no adjacent WAL was present when rechecked on 2026-09-09.
- Seed: `civiclens-track-b-smoke-2026-09-09-v1`.
- Literal ranking input: concatenate the UTF-8 strings
  `smoke-common-house` and the candidate's bioguide with no separator.
- Rank order: lowercase HMAC-SHA256 digest, then bioguide as final tiebreaker.
- Base predicate: current House member; excluded from the frozen source roster;
  at least one Clerk type-P filing in the frozen 2023-2026 indexes; at least one
  FEC candidate ID in the frozen current-legislators source.
- Prior-exposure exclusion: every original six-stratum selection, every
  recorded predicate disqualification, and every member whose filing or saved
  EFDS result was used for classification.
- Structural check: examine the earliest year and lowest DocID filing using
  `pdftotext -layout`. If it lacks a usable native transaction-table text layer,
  record the disqualification and take the next ranked candidate. OCR is never
  permitted.

The first-ranked candidate, Guy Reschenthaler (`R000610`), passed the structural
check on Clerk DocID `20026547`: the native text contains the transaction table
and three visible rows. No backfill was used.

The selection cutoff remains **2026-09-08T21:10:00Z**, inherited from the
hashed candidate facts and Clerk indexes. The official probe PDF was retrieved
on 2026-09-09 only to classify the already-indexed DocID; its bytes and derived
native text are frozen by hash. Later index entries cannot alter this selection.

## Smoke acceptance checks

- pre- and post-run baseline verification;
- exact identity, chamber, slug, and member-scoped command boundaries;
- House PFD/PTR source filing count and every extracted row count reconciled to
  the frozen Clerk indexes and visible source tables;
- every extracted disclosure row inspected against its visible source table;
- FEC IE status recorded honestly; OpenSecrets remains `not-collected`;
- timing-safe routine detectors only;
- full tests, TypeScript, and expected corpus validation;
- two selected-page renders are byte-identical after removing only the generated
  timestamp;
- the fixed reference-member render may differ only in its generated timestamp
  and deterministic peer/shared-donor rows that explicitly identify the new
  member; every other byte must match;
- no pre-existing row may be deleted or updated in a member-owned table; new
  rows must either carry the selected member's canonical identity or be shared
  bill/source rows directly referenced by that member's new rows. All
  non-target member-keyed set differences must be zero.

Any implementation defect may be fixed generically with a source-derived
failing test, but the exposed member then remains development evidence. It may
be rerun only to verify the fix, not relabeled as a fresh smoke pass. A new
untouched smoke member would be selected from the same frozen ranking if a fresh
pass is still desired.
