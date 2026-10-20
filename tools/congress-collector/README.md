# House acquisition adapter

This is the first isolated acquisition package from the September 26 reliability
plan, following the October 4 House discovery result. Python 3.10+ standard
library only; no collector or dependency installation. Existing CivicLens
loaders remain unchanged.

The adapter checks a SHA256-pinned discovery packet against every raw listing
page, declared count, continuation, displayed identity and inclusive date
window. It then makes one attempt per in-window roll. Every published row,
including out-of-window exclusions and capped/unattempted records, remains in
the run manifest. Blank listing statuses are retained.

Captured response bytes are saved unchanged with URL, HTTP status, content type,
timestamp, byte count and SHA256. `body_complete` and `read_error` distinguish
full responses from a retained partial read or byte-cap prefix. HTTP errors,
timeout, unpublished details, malformed XML,
wrong congress/session/chamber/roll/date, missing voter payload and unexpected
redirects prevent acquisition completion. Vacated markers are retained as
`unsupported_record` pending authoritative exclusion handling. A marker alone
does not grant a complete run.

`acquired` means raw source material was downloaded and identity-checked only (acquisition_semantics: `downloaded_and_identity_checked_only`). The manifest contract (`contract: civiclens.official-vote-acquisition`, `contract_version: 1`) declares the wire fields and validation semantics. The three `*_validated` flags (`normalized_votes_validated`, `member_coverage_validated`, `bill_resolution_validated`) are always false — this package does not perform those gates. It does not mean the complete voter payload, membership, position normalization or bill classification passed. `acquisition_complete` is separate from pipeline/certification success and cannot establish verified-empty membership. The pinned `unitedstates/congress` adaptation remains the selected downstream parsing approach; it is not installed or invoked by this package.

## Check saved inventory (no HTTP or run-directory writes)

From the new worktree:

```bash
python3 tools/congress-collector/adapter.py \
  --inventory /home/captainanime/NoService/Projects/CivicLens/Sources/votes/2026-10-04-house-discovery/inventory.json \
  --inventory-sha256 2c250360ab3fa72b68b1f134d9ba1cee0f25999920f5b4cbde9498abe33401e4 \
  --check-inventory
```

The pinned packet contains 249 saved index pages, 2,466 published rolls and
2,012 in-window rolls for September 26, 2022 through September 26, 2026 inclusive.
Raw inventory/page hashes are rechecked at the acquisition boundary. Missing
sessions/pages, unaccounted rows and altered source bytes stop before HTTP.

## Execute acquisition (a separately bounded source run)

After source acquisition is authorized, replace `--check-inventory` with
`--execute --output artifacts/official-house-acquisition/<new-run-id>`.
Output must be a new directory under this worktree's acquisition artifact root.
No output reuse, automatic retry, credentials, GovTrack fallback or DB access.
`--max-rolls N` is an explicit safety cap; every remaining required roll gets
`incomplete_fetch`, and the CLI exits 1. HTTP is sequential with a 30-second
request timeout, refuses redirects and limits response size to 5 MiB.

The manifest is updated atomically after every roll. A process interruption
leaves a `running` manifest with pending records; it is never a completion claim.
Exit 0 is only full acquisition or a successful inventory-only check. Each CLI
mode produces JSON describing which of those was performed.

## Manifest contract

The manifest (manifest.json) wire format is specified in `docs/official-vote-source-contract-2026-10-08.md` §6. Top-level fields include the contract identity (`contract: "civiclens.official-vote-acquisition"`, `contract_version: 1`), acquisition semantics (`acquisition_semantics: "downloaded_and_identity_checked_only"`), and validation flags (all false). Record fields include identity fields (chamber, congress, session, year, roll, date, key), acquisition fields (in_window, attempted, attempted_at, outcome, reason), and response fields (url, final_url, http_status, content_type, path, sha256, bytes, body_complete, read_error, attempted_at, received_at). Metadata fields (legis_num, question, vote_type, result, vote_desc, amendment_num, amendment_author, recorded_vote_count, position_tokens) are present only when outcome is `acquired`. Report fields include `window_policy` (with months 48 only for a true 48-calendar-month window), `attempted_rolls`, `max_rolls`, and `safety_cap_applied`. The legacy `version` key is removed; the 2026-10-07 offline-accounting manifest predates this contract and is preserved unchanged by design; the validator rejects it as legacy. The TypeScript validator is `skills/researcher/official-votes.ts` (validateAcquisitionManifest, verifyResponseBodies) with verdicts complete/incomplete/invalid at scope acquisition_only.

## Tests

```bash
python3 -m unittest discover -s tools/congress-collector -p 'test_*.py' -v
```

Tests use frozen official page/XML bytes plus explicitly synthetic small
inventories and failure responses. No external HTTP. Evidence for this package
is in `artifacts/house-acquisition-2026-10-07/`; allowed baseline suite excludes
the two confirmatory/timing runner test files under the existing plan.

Interop helper (SYNTHETIC, offline): `tools/congress-collector/make_interop_manifest.py` builds one-roll SYNTHETIC listing packets and calls `adapter.acquire` with injected fetch. Scenarios: `complete` (status 200 → `acquisition_complete`), `capped` (max_rolls=0 → `incomplete`), `http500`, `vacated`. Used by TypeScript interop tests in `skills/researcher/official-votes.test.ts`.

Open work: The shared contract (docs/official-vote-source-contract-2026-10-08.md, lib/vote-source.ts, skills/researcher/official-votes.ts) is now in place. Remaining: full detail acquisition, Senate coverage, pinned collector/runtime lock, dated identity mapping, voter/totals validation, typed bill resolution, consumer integration, and a new frozen candidate with authorized certification.
