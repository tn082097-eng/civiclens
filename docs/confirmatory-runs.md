# Confirmatory-run registry

Machine-readable ledger of preregistered confirmatory analyses (ADR 0003).
**One confirmatory run per detector.** The guard
(`scripts/confirmatory-guard.ts`, `npm run guard:confirmatory -- <id>`) reads
this file to refuse a second confirmatory computation on a consumed,
non-invalidated detector.

Each detector is one table row. Columns are stable; the guard parses them.

- `detector_id` — stable slug, matches the spec and the run command.
- `spec` — the preregistration doc.
- `status` — one of: `registered` (spec written, run NOT yet consumed),
  `consumed-pass`, `consumed-fail`, `invalidated` (a documented invalidation is
  on record; a single replacement/repair run is permitted).
- `run_commit` — git commit recording the result (blank until consumed).
- `outcome` — short result summary (blank until consumed).
- `invalidation` — link to the dated amendment/ADR that invalidated the run, if
  any (blank otherwise). Only a non-blank value reopens a consumed detector.

Update this file as part of a confirmatory run's own record-keeping — the same
step that appends the result to the spec. A run that is not recorded here is not
protected by the guard.

| detector_id | spec | status | run_commit | outcome | invalidation |
|---|---|---|---|---|---|
| district-contracts-theme | docs/2026-07-15-district-contracts-detector.md | consumed-fail | (pre-registry) | theme spine p=0.48, negative control clean; archived, no v2 without new mechanism | |
| district-contracts-recipient | docs/2026-07-15-district-contracts-detector.md | consumed-fail | (pre-registry) | recipient-trade spine p=0.74, negative control clean; archived | |
| recipient-trade | docs/2026-07-17-recipient-trade-detector.md | consumed-fail | a47ca81 | GATE FAIL: S1 p=0.7445, S2 p=0.3760, negative control 0/20; detector not registered, thread closed | |
| trade-vote-alignment | docs/2026-07-20-timing-detectors-scoring.md | registered | | (awaiting negative-control gate + confirmatory run) | |
| spousal-trade-timing | docs/2026-07-20-timing-detectors-scoring.md | registered | | (awaiting negative-control gate + confirmatory run) | |
