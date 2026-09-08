# Track B — Run-any-member certification

**Status:** authorized for local execution on 2026-09-08. No production database
write, push, publication, or deployment is authorized.

This is the frozen Track B plan reconciled by Claude and Codex and corrected
once after the Opus adversarial review. Track A is complete and live.

## Terminal condition

Six distinct current members, selected deterministically from six fixed strata,
must each end with either a verified deterministic local page or a
source-backed inherent-limitation closure. All final results must be replayed
against one final code revision. The production DuckDB remains unchanged.

The final package must include passing focused tests, full tests, TypeScript,
baseline verification, expected corpus validation, render determinism, database
delta checks, source evidence, and a tracked result for every step. No cleanup,
push, or publication is required for certification.

## Phase 0 — Gate B1 prerequisites

Use one clean central Track B worktree from `origin/main`.

1. Record the production database hash and confirm no WAL; use copies only.
2. Add generic slug resolution to `lib/ingest-scope.ts`: for `--member`, try an
   injectable members-table slug lookup before unchanged human-name resolution.
3. Test slug resolution, name fallback, unknown input, and bioguide resolution.
4. Update `AGENTS.md` and the external onboarding skill: canonical bioguide for
   loaders; slug for detectors/render; district loaders omitted from base
   onboarding; OpenSecrets optional and recorded `not-collected` when omitted.
5. Add a tested `scripts/trials/db-delta.ts` that compares two DuckDB files by
   deterministic per-table row counts and content hashes without modifying them.
6. Run focused tests, the full suite, and `npx tsc --noEmit`. Keep slug/contract
   and delta-helper changes as separate commits.

## Phase 1 — Gate B2 frozen selection

Create:

- `scripts/trials/select-track-b.ts` and its tests;
- `inputs.sha256`;
- `selection-manifest.json`;
- `protocol.md`.

Freeze retrieval times and SHA-256 hashes for:

- the current-legislators YAML and upstream commit;
- House type-P indexes for 2023–2026 through the recorded cutoff;
- every saved Senate EFDS response used for classification;
- every classification PDF downloaded;
- the source database;
- the seed, method, pool, exclusions, rankings, and disqualifications.

The eligible pool is current members excluding every bioguide already present
in the source database and every bioguide resolved from `names.txt`. An
ambiguous name excludes all matching bioguides.

For each stratum, rank eligible members by
`HMAC-SHA256(seed, stratum_id || bioguide)` with the digest then bioguide as the
total order. Assign in order `1, 2, 6, 3, 4, 5`, removing each selection
globally. Execution remains in numerical order with the scanned stratum last.

| Id | Frozen stratum |
|---|---|
| 1 | Senator whose saved EFDS results contain at least one PTR |
| 2 | House member with zero type-P filings in all frozen indexes |
| 3 | House member with at least ten 2025 type-P filings and a usable transaction-table text layer in the deterministic probe filing |
| 4 | Senator whose saved EFDS results contain zero PTRs |
| 5 | Current member with no FEC candidate id |
| 6 | House member with at least one type-P filing whose deterministic probe has no usable text layer |

For stratum 3, order a member's 2025 type-P filings by DocID and download only
the first as the deterministic probe. For stratum 6, order all type-P filings
by year then DocID and download only the first. `pdftotext` is used only to
classify the native text layer; OCR is never run. Full filing behavior is tested
during execution.

Backfill is permitted only for an authoritative pre-run predicate
disqualification, using the next ranked candidate with the reason recorded.
Runtime, network, parser, or code failures never cause reselection. A
no-candidate closure is permitted only when the stratum's eligible pool is
empty before any later-assigned stratum removes candidates, with the exhaustive
pool evidence recorded.

## Phase 2 — Six isolated trials

Run one member at a time. Each stratum gets an isolated worktree, a fresh copy
of the certified source database, and an empty cache root. Never accumulate
members across strata. Execute the scanned-PTR stratum last.

For every applicable step, record exactly one status: `ok`, `verified-empty`,
`not-collected`, `unavailable`, `withheld`, or `failed`.

1. `npm run verify:baseline` before changes.
2. Append the selected member and record slug, bioguide, and chamber.
3. Run only applicable member-scoped loaders; use House PFD or Senate PTR,
   never both. Do not run district or OpenSecrets loaders.
4. Run timing-safe `run-patterns.ts --member <slug>` and
   `score-theme-gaps.ts --member <slug>`. Never run confirmatory timing paths.
5. Reconcile fetched and loaded disclosure counts against primary-source
   indexes/responses; inspect representative source rows.
6. Run post-state baseline, full tests, and TypeScript.
7. Run `validate:corpus` against the expected fresh artifact set recorded in
   the manifest. Zero is valid only for a source family whose expected zero is
   corroborated by `verified-empty` or `withheld` evidence. An unrecorded or
   unexplained `0/0` fails.
8. Render the selected member twice and compare hashes after stripping only the
   generated timestamp.
9. Re-render a fixed reference member and triage any drift; run the database
   delta helper and reject unexplained cross-member mutation.
10. Commit the complete evidence record for the stratum.

Scanned PDFs are proved textless with `pdftotext`, are never sent through OCR,
and end in the literal `withheld` state unless separately authorized later.

## Defect rule and final replay

One focused generic fix cycle is allowed per stratum on the central branch.
The same candidate and frozen environment must be recreated. A second failure
for that stratum stops Track B; there is no reselection or scope expansion.

After the final generic fix, replay all six strata end to end from fresh scratch
database and cache copies against the same final commit. The certification
attests only to these final-code replays, never to a mixture of builds.

## Gates B3 and B4

Gate B3 reviews every non-`ok` terminal status (`verified-empty`,
`not-collected`, `unavailable`, `withheld`) against its recorded source
evidence. It occurs after all six final replays; the maintainer's disposition is
recorded in the certification summary.

Gate B4 accepts or rejects the complete certification package, including sample
sizes and limitations by stratum. A source-backed limitation may close a
stratum; implementation or network failure may not.

The user's 2026-09-08 authorization permits execution through the local B4
package without intermediate approval pauses. It does not authorize production
database mutation, push, publication, deployment, OCR, confirmatory analysis,
or work outside these six strata.
