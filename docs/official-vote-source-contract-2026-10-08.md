# Shared official-vote source contract — package spec (2026-10-08)

Coordinator-authored. Derived from the September 26 reliability plan §2 and §7
and the October 7 House adapter. Every agent in this package receives this file.
It is the single source of truth for names, wire fields and outcomes. If code and
this spec disagree, the spec wins; report the disagreement, do not invent a third
shape.

Worktree: `/home/captainanime/Developer/civiclens-reliability-votes`
(branch `codex/reliability-official-votes`, base `cd49c2c0`). Python 3.12 stdlib
only. TypeScript via existing `node_modules/.bin/tsx` and `tsc` (ESM, NodeNext,
`.js` import suffixes, `node:test` + `node:assert/strict`). No new dependencies.

## 0. Scope and boundaries (all agents)

Scope: (a) the shared contract in `lib/vote-source.ts`; (b) acquisition-manifest
validation in `skills/researcher/official-votes.ts`; (c) aligning
`tools/congress-collector/adapter.py` so its manifest is exactly the wire format
below; (d) tests, frozen fixtures and docs for those.

Not in scope: live HTTP of any kind, installs, DB access, OCR, certification
replays, confirmatory computations, renders, public artifacts, commits, merges,
pushes, deployment, Senate acquisition, collector installation, member/LIS
identity mapping, consumer integration (fetch.ts, agents/, db/, render/), new
worktrees. Never touch `~/Developer/civiclens` (main), `civiclens-launch`,
`civiclens-track-b` or any `civiclens-track-b-trials/*` checkout. Never modify
or delete anything under `artifacts/` except your own new log files in
`artifacts/official-votes-contract-2026-10-08/`. Preserve
`artifacts/house-acquisition-2026-10-07/` and
`artifacts/official-house-acquisition/2026-10-07-offline-accounting/` as-is
(that old manifest predates this contract and is expected to be rejected as
legacy — never rewrite it).

Never present a synthetic fixture as official evidence. Official frozen bytes:
`fixtures/votes/house-acquisition/*` (listed with SHA256 in its manifest.json)
and saved samples in
`/home/captainanime/NoService/Projects/CivicLens/Specs/2026-09-26-reliability-evidence/sources/`
(receipts in `../source-receipts.json`). Anything else you construct is
SYNTHETIC and must be labeled so in a comment/name.

## 1. Canonical identity

- Chamber: `'house' | 'senate'`; key letter `h` / `s`.
- `sessionYear(congress, session) = 1787 + 2*congress + session - 1`
  (session ∈ {1,2}; congress positive integer). 119/1 → 2025, 118/2 → 2024.
- Canonical roll key: `{congress}-{sessionYear}/{h|s}{roll}`, e.g. `119-2025/h1`,
  `119-2025/s1`. Roll is a positive integer without leading zeros in the key.
  Never derived from URL, array index, title or date.
- House XML URL: `https://clerk.house.gov/evs/{year}/roll{roll:03d}.xml`
  (roll ≥ 1000 is unpadded, e.g. roll1234.xml).
- Senate XML URL: `https://www.senate.gov/legislative/LIS/roll_call_votes/vote{congress}{session}/vote_{congress}_{session}_{roll:05d}.xml`.
- Identity check: chamber, congress, session, roll and date of the observed
  official metadata must equal the enumerated record. Any mismatch is
  `malformed_source` at acquisition; conflicting identities between two official
  sources are `ambiguity`.

### House metadata label compatibility (validation repair 2026-10-21)

House chamber identity may be expressed by one plain `chamber` element, one
plain `committee` element, or one of each under the same `vote-metadata`.
Every present label must have literal text `U.S. House of Representatives`.
Both absent, repeated names (even identical), child elements, attributes, empty
or whitespace-only values, padded/case-changed values, or any conflicting/wrong
value fail closed as `malformed_source`. A valid label never overrides an
invalid other label. No label is inferred from the URL, voter list or roll key.
The shared `tools/congress-collector/house_metadata.py` check is used by
acquisition validation and bridge raw extraction. All other checks retain their
existing scope; acquisition-only validation does not certify voter identity,
normalized positions, totals, member coverage or bill resolution.

Captured historic proof and the original failed receipt are described in
[House metadata source proof](house-metadata-compatibility-source-2026-10-21.md).
This compatibility repair does not authorize modifying the original failed
manifest, retrying HTTP, or claiming complete coverage. Any retained-body
revalidation requires a separately derived artifact after complete original
HTTP receipt/body/hash verification.

## 2. Coverage window

- `subtractCalendarMonths(isoDate, months)`: UTC calendar arithmetic, clamp the
  day to the last day of the target month. NOT months*30 days.
  `2026-09-26 − 48 → 2022-09-26`; `2024-02-29 − 12 → 2023-02-28`;
  `2028-02-29 − 48 → 2024-02-29`; `2026-03-31 − 1 → 2026-02-28`;
  `2024-03-31 − 1 → 2024-02-29`.
- Window is inclusive on both ends: `[subtractCalendarMonths(asOf, 48), asOf]`.
- Frozen evidence window (must not change): asOf `2026-09-26`,
  start `2022-09-26`, end `2026-09-26`, 48 months.
- Strict ISO input `YYYY-MM-DD` that is a real calendar date; anything else throws.

## 3. Positions

Raw text is always preserved verbatim as `rawPosition`. Matching uses the
trimmed raw string, case-sensitive.

| raw (trimmed) | context | normalized |
|---|---|---|
| `Yea`, `Aye` | any | `yea` |
| `Nay`, `No` | any | `nay` |
| `Present` | any | `abstain` |
| `Not Voting` | any | `absent` |
| `Guilty`, `Not Guilty`, `Present, Giving Live Pair` | any | `other` |
| any other non-empty token | `election` | `other` (candidate name) |
| any other token, or empty | `standard` | unsupported (`unsupported_record`) |
| empty | `election` | unsupported |

`other` must never become `nay` or `absent`. A member missing from an official
roll is NOT absent: `memberParticipation` returns `not_recorded`, never
`absent`. Duplicate rows for one member are ambiguity. This package has no
frozen official election XML, so the classifier never infers election context;
election context is only passed explicitly (tests use it synthetically).

## 4. Roll resolution union (persisted outcome, not nullable bill_id)

`resolved_bill | authoritative_non_bill | unsupported_record | ambiguity |
malformed_source | incomplete_fetch | source_failure`. Only the first two
resolve a live roll. Bill types (8): `hr s hjres sjres hconres sconres hres sres`.

House classifier input = adapter `metadata` (snake_case; §6):
- `legis_num` trimmed. Normalize for matching only: replace each `.` with a
  space, collapse whitespace, trim, uppercase (so `H.R. 2365`, `H. R. 2365`
  and `H R 2365` all match; amended 2026-10-08 after review T11). Bill patterns → type: `H R`→hr, `H RES`→hres, `H J RES`→hjres,
  `H CON RES`→hconres, `S`→s, `S RES`→sres, `S J RES`→sjres,
  `S CON RES`→sconres, followed by a single number `[1-9]\d*`. Congress of the
  bill = the roll's congress. `amendment_num` (if non-null/non-empty) is kept as
  the amendment string; the parent bill stays the bill.
- `QUORUM` with `vote_type` `QUORUM` → `authoritative_non_bill` subtype
  `quorum` (frozen official sample: 2025 roll 1). `QUORUM` with any other
  vote_type → `ambiguity`.
- `JOURNAL` → subtype `journal`; `ADJOURN` → subtype `adjourn`.
- Empty `legis_num` → `unsupported_record`, reason states missing document
  identity is not evidence of a non-bill vote.
- Any other value (incl. wording like "Motion", cloture text) → `unsupported_record`.
- Never inspect question wording to grant non-bill status.

Senate classifier input (plain object from Senate XML fields, camelCase):
`{ congress, documentCongress, documentType, documentNumber, documentName,
amendmentNumber, amendmentToDocumentNumber }` (strings may be empty).
- `documentType` map: `S.`→s, `H.R.`→hr, `S.J.Res.`→sjres, `H.J.Res.`→hjres,
  `S.Con.Res.`→sconres, `H.Con.Res.`→hconres, `S.Res.`→sres, `H.Res.`→hres;
  number must be `[1-9]\d*`. `documentCongress` ≠ vote congress → `ambiguity`.
- `PN` → non-bill `nomination`; `Treaty Doc.` → non-bill `treaty` (rule tokens
  pending a frozen official sample; tests for them are SYNTHETIC).
- Empty document but `amendmentToDocumentNumber` parses as a bill designation
  (`S. 5`, `H.R. 12`, etc.) → `resolved_bill` with amendment. If both document
  and amendment parent are present and disagree → `ambiguity`.
- Everything empty → `unsupported_record` (missing ≠ non-bill). Unknown type →
  `unsupported_record`. Malformed number → `malformed_source`.
- Frozen official sample: 119/1 Senate roll 1 has documentType `S.`, number
  `5`, documentCongress `119`, cloture question → `resolved_bill` s 5. Cloture
  wording does not make it non-bill.

## 5. TypeScript API — `lib/vote-source.ts` (owner: task 1)

Use these exact export names.

```ts
export class VoteSourceError extends Error {}
export const VOTE_ACQUISITION_CONTRACT = 'civiclens.official-vote-acquisition';
export const VOTE_ACQUISITION_CONTRACT_VERSION = 1;
export const COVERAGE_MONTHS = 48;
export const FROZEN_EVIDENCE_WINDOW: { asOf: '2026-09-26'; start: '2022-09-26'; end: '2026-09-26'; months: 48 };
export type Chamber = 'house' | 'senate';
export interface RollIdentity { chamber: Chamber; congress: number; session: 1 | 2; roll: number }
export function sessionYear(congress: number, session: number): number;             // throws VoteSourceError
export function rollKey(id: RollIdentity): string;                                    // throws on invalid
export function parseRollKey(key: string): RollIdentity & { year: number };          // strict; throws
export function houseSourceUrl(year: number, roll: number): string;
export function senateSourceUrl(congress: number, session: 1 | 2, roll: number): string;
export interface ObservedRoll { chamber: Chamber; congress: number; session: number; roll: number; date: string }
export function checkRollIdentity(expected: ObservedRoll, observed: ObservedRoll): { ok: true } | { ok: false; mismatches: string[] };
export function isIsoDate(value: unknown): value is string;
export function subtractCalendarMonths(isoDate: string, months: number): string;      // throws
export function coverageWindow(asOf: string, months?: number): { asOf: string; start: string; end: string; months: number };
export function inWindow(date: string, window: { start: string; end: string }): boolean; // inclusive; throws on bad dates

export type NormalizedPosition = 'yea' | 'nay' | 'abstain' | 'absent' | 'other';
export type PositionContext = 'standard' | 'election';
export type PositionResult =
  | { ok: true; position: NormalizedPosition; rawPosition: string }
  | { ok: false; outcome: 'unsupported_record'; rawPosition: string; reason: string };
export function normalizePosition(raw: string, context: PositionContext): PositionResult;
export type Participation =
  | { status: 'recorded'; position: NormalizedPosition; rawPosition: string }
  | { status: 'unsupported_position'; rawPosition: string; reason: string }
  | { status: 'ambiguity'; reason: string }
  | { status: 'not_recorded'; reason: string };
export function memberParticipation(rows: ReadonlyArray<{ memberId: string; rawPosition: string }>, memberId: string, context: PositionContext): Participation;

export const BILL_TYPES: readonly ['hr','s','hjres','sjres','hconres','sconres','hres','sres'];
export type BillType = typeof BILL_TYPES[number];
export interface BillRef { congress: number; type: BillType; number: number }
export type NonBillSubtype = 'quorum' | 'journal' | 'adjourn' | 'nomination' | 'treaty';
export const RESOLUTION_OUTCOMES: readonly ['resolved_bill','authoritative_non_bill','unsupported_record','ambiguity','malformed_source','incomplete_fetch','source_failure'];
export type ResolutionOutcome = typeof RESOLUTION_OUTCOMES[number];
export type RollResolution =
  | { outcome: 'resolved_bill'; bill: BillRef; amendment: string | null; raw: Record<string, string | null> }
  | { outcome: 'authoritative_non_bill'; subtype: NonBillSubtype; raw: Record<string, string | null> }
  | { outcome: 'unsupported_record' | 'ambiguity' | 'malformed_source' | 'incomplete_fetch' | 'source_failure'; reason: string; raw: Record<string, string | null> };
export function isResolved(r: RollResolution): boolean;   // true only for resolved_bill / authoritative_non_bill
export interface HouseRollMetadata { congress: number; legis_num: string; vote_type: string; question: string; amendment_num: string | null }
export function classifyHouseRoll(meta: HouseRollMetadata): RollResolution;
export interface SenateDocumentFields { congress: number; documentCongress: string; documentType: string; documentNumber: string; documentName: string; amendmentNumber: string; amendmentToDocumentNumber: string }
export function classifySenateRoll(fields: SenateDocumentFields): RollResolution;
```

`raw` always contains the input fields verbatim (stringified, null kept).

## 6. Adapter manifest wire format (Python writes; TS validates)

Top-level (snake_case, all keys always present):

```
contract: "civiclens.official-vote-acquisition"
contract_version: 1
chamber: "house"
status: "running" | "acquisition_complete" | "incomplete"
started_at: tz-aware ISO timestamp
finished_at: tz-aware ISO timestamp | null   (null only while running)
window: ["YYYY-MM-DD", "YYYY-MM-DD"]
window_policy: { as_of: window[1], months: 48 | null }   # 48 iff window[0] == subtract_months(window[1], 48)
inventory_sha256: 64 lowercase hex
index_pages_verified: int
published_rolls: int        # == len(records)
required_rolls: int         # == count of records with in_window true
attempted_rolls: int        # == count of records with attempted true
max_rolls: int | null
safety_cap_applied: bool    # true iff max_rolls is not null and >=1 required roll was left unattempted by the cap
counts: { outcome: int }    # exact recount of records[].outcome
acquisition_semantics: "downloaded_and_identity_checked_only"
normalized_votes_validated: false
member_coverage_validated: false
bill_resolution_validated: false
collector_revision: null
records: [...]
```

The legacy top-level `version` key is removed (replaced by contract/contract_version).

Record (all keys present):

```
key: "119-2025/h1"           # rollKey(house, congress, session, roll); year == sessionYear
chamber: "house"
congress: int, session: 1|2, year: int, roll: int
date: "YYYY-MM-DD"           # official listing date
status: str | null           # raw listing status, blank kept as null
url: listing detail URL      # unchanged from inventory
page: int
index_receipt: {...}         # unchanged from inventory
source_url: houseSourceUrl(year, roll)
in_window: bool              # window[0] <= date <= window[1]
attempted: bool              # an HTTP fetch was attempted for this record
attempted_at: ISO | null
outcome: "pending" | "acquired" | "excluded_outside_window" | "unsupported_record" | "malformed_source" | "incomplete_fetch" | "source_failure"
reason: str | null
response: null | { url, final_url, http_status, content_type, path, sha256, bytes, body_complete, read_error, attempted_at, received_at }
metadata: null | {
  key, chamber, congress, session, roll, date,
  legis_num, question, vote_type, result,      # raw text, stripped
  vote_desc,                                   # raw text ('' allowed)
  amendment_num, amendment_author,             # raw text or null when the element is absent
  recorded_vote_count: int,                    # number of <recorded-vote>
  position_tokens: { raw <vote> text: count }  # verbatim tokens incl. candidate names
}
```

Rules:
- `pending` only while status is `running`. Out-of-window → `excluded_outside_window`,
  `attempted` false, response/metadata null.
- Safety cap: unattempted in-window → `incomplete_fetch`, `attempted` false,
  reason begins `safety cap`.
- `acquired` ⇒ attempted, response present, http_status 200, body_complete true,
  final_url == url == source_url, metadata present with identity equal to the
  record. `acquired` means downloaded + identity-checked ONLY.
- Each `<recorded-vote>` must have exactly one `<vote>` child, else
  `malformed_source`. Missing `<vote-data>`/zero recorded votes stays
  `malformed_source` (existing behavior).
- Optional `amendment-num`/`amendment-author`: 0 elements → null, 1 → text,
  >1 or structured → malformed_source.
- Vacated marker stays `unsupported_record` (existing ruling).
- `status` is `acquisition_complete` iff every in-window record is `acquired`
  and every out-of-window record is `excluded_outside_window`; otherwise
  `incomplete` (or `running` mid-run).
- `--check-inventory` JSON additionally reports `window_policy`.
- (amended 2026-10-08 after review T15) `subtract_months` must be correct for
  every month including December targets/sources (e.g. `2020-12-06 − 12 →
  2019-12-06`, `2026-12-31 − 48 → 2022-12-31`, `2026-01-15 − 1 → 2025-12-15`)
  and agree with TS `subtractCalendarMonths`; negative or non-integer months
  raise `InventoryError`.
- (amended after review) The record identity check in `validate_inventory`
  must be non-tautological: congress/session derived from the listing year
  must equal the congress/session in that row's index-receipt listing URL.

## 7. TypeScript API — `skills/researcher/official-votes.ts` (owner: task 3)

```ts
export const ACQUISITION_OUTCOMES: readonly ['pending','acquired','excluded_outside_window','unsupported_record','malformed_source','incomplete_fetch','source_failure'];
export type AcquisitionOutcome = typeof ACQUISITION_OUTCOMES[number];
export interface AcquisitionResponse { url: string; final_url: string; http_status: number; content_type: string; path: string; sha256: string; bytes: number; body_complete: boolean; read_error: string | null; attempted_at: string; received_at: string }
export interface AcquisitionRecord { /* every §6 record field */ }
export interface AcquisitionManifest { /* every §6 top-level field */ }
export interface ValidationPolicy { window: { start: string; end: string }; coverageMonths: number | null }
export type ManifestVerdict =
  | { verdict: 'complete'; scope: 'acquisition_only'; manifest: AcquisitionManifest; required: number; acquired: number; excluded: number }
  | { verdict: 'incomplete'; scope: 'acquisition_only'; reasons: string[]; counts: Record<string, number> }
  | { verdict: 'invalid'; problems: string[] };
export function validateAcquisitionManifest(input: unknown, policy: ValidationPolicy): ManifestVerdict;
export function verifyResponseBodies(manifest: AcquisitionManifest, runDir: string, read?: (absPath: string) => Buffer): string[]; // [] = all bodies match
export const FROZEN_POLICY: ValidationPolicy; // FROZEN_EVIDENCE_WINDOW + coverageMonths 48
```

`invalid` (contract violated or internally inconsistent — never trust):
wrong/missing contract, version or chamber; acquisition_semantics wrong; any of
the three `*_validated` flags not literally false; window ≠ policy.window; when
`policy.coverageMonths` is a number: window_policy.months ≠ it or
`subtractCalendarMonths(window[1], n) ≠ window[0]`; records not an array; missing
record field; unknown outcome; duplicate key; key ≠ rollKey; year ≠ sessionYear;
source_url ≠ houseSourceUrl; in_window ≠ inWindow(date); published/required/
attempted counts or `counts` ≠ recount; `pending` outside running;
out-of-window record not excluded or attempted/with response; excluded record in
window; unattempted record with response; `acquired` lacking any §6 acquired
condition or `checkRollIdentity` failing against metadata; response path absolute
or containing `..`; sha256 not 64 lowercase hex; status `acquisition_complete`
while any required record isn't acquired; `safety_cap_applied` inconsistent;
finished_at null with a final status.

Type checks are part of `invalid` (amended 2026-10-08 after reviews T9/T13):
every §6 field must have its declared type — `status` one of the three values;
`inventory_sha256` 64 lowercase hex; `started_at` non-empty string;
`finished_at` string or null; `index_pages_verified`, `published_rolls`,
`required_rolls`, `attempted_rolls` non-negative safe integers; `max_rolls`
non-negative safe integer or null; `safety_cap_applied` boolean;
`window_policy` `{as_of: window[1], months: positive integer | null}`;
`counts` an object of positive integers. Record: `congress`, `roll`, `year`,
`page` positive safe integers; `session` 1 or 2; `date` real ISO date;
`in_window`, `attempted` booleans; `attempted_at` string or null (string iff
attempted); `reason` string or null; `status` string or null. Response:
`http_status` integer 100–599, `bytes` non-negative safe integer,
`body_complete` boolean, `url`/`final_url`/`content_type`/`path`/
`attempted_at`/`received_at` strings, `read_error` string or null. Acquired
metadata: `key` equals the record key, `chamber` is `house`,
`recorded_vote_count` positive integer, `position_tokens` object of positive
integers summing to `recorded_vote_count`, `legis_num`/`question`/`vote_type`/
`result`/`vote_desc` strings, `amendment_num`/`amendment_author` string or null.
Any helper that throws while checking a field records a problem — a thrown
helper is never silently ignored. Window arithmetic uses `subtractCalendarMonths`.

Also `invalid` (amended 2026-10-08 after final review T20): any §6 top-level key
missing; `collector_revision` not null; record `index_receipt` not an object; any
non-null `metadata` (whatever the outcome) failing the metadata field types; an
unattempted in-window record that is neither `pending` nor an `incomplete_fetch`
whose reason begins `safety cap`; a `safety cap` reason on anything other than an
unattempted in-window `incomplete_fetch`, or while `max_rolls` is null.
`rollKey` rejects a runtime chamber other than `house`/`senate`.

`incomplete` (structurally valid, but coverage not established): status
`running` or `incomplete`; any required record not acquired; safety cap applied;
zero required rolls (an empty source never establishes verified-empty). Reasons
list each non-acquired outcome with counts.

`complete`: none of the above. Scope stays `acquisition_only`; it never implies
normalized votes, membership, bill resolution or certification.

`verifyResponseBodies`: for each record with a response, resolve
`join(runDir, path)`, refuse escapes outside runDir, read bytes, compare length
to `bytes` and SHA256 to `sha256`. Return a problem string per mismatch/missing file.

## 8. Interoperability (offline)

`tools/congress-collector/make_interop_manifest.py` (owner: task 6) — SYNTHETIC
offline helper. CLI: `python3 make_interop_manifest.py <new-output-dir> <scenario>`.
Builds a one-roll SYNTHETIC listing packet for 2025 roll 1 dated 2025-01-03
(window `2025-01-03..2025-01-03`) in a temp dir, then calls `adapter.acquire`
with an injected fetch (no network). Scenarios:
- `complete`: fetch returns the frozen official `house-2025-roll001.xml` bytes,
  status 200 → manifest status `acquisition_complete`.
- `capped`: `max_rolls=0` → `incomplete`, `safety_cap_applied` true.
- `http500`: status 500 body `b'synthetic error'` → `source_failure`, incomplete.
- `vacated`: body `b'<html>This vote was vacated</html>'` → `unsupported_record`.
Writes the run into `<new-output-dir>/run` and prints that path as JSON
`{"run_dir": ...}` on stdout. Exit 0 whenever the manifest was written.

`skills/researcher/official-votes.test.ts` (owner: task 4) includes interop
tests that spawn `python3 tools/congress-collector/make_interop_manifest.py`
into an `os.tmpdir()` dir, read `run/manifest.json`, then assert:
`complete` → verdict complete with policy `{window: {start:'2025-01-03', end:'2025-01-03'}, coverageMonths: null}`
and `verifyResponseBodies` returns `[]`; the same manifest with `FROZEN_POLICY`
→ invalid; `capped`/`http500`/`vacated` → incomplete; complete manifest with one
body byte altered on disk → verifyResponseBodies non-empty; complete manifest
with `body_complete` flipped to false in memory → invalid. Also: the legacy
`artifacts/official-house-acquisition/2026-10-07-offline-accounting/manifest.json`
(read-only) → invalid (missing contract).

## 9. Test-first protocol

Test writers run their new tests against the not-yet-aligned code and save the
red output to `artifacts/official-votes-contract-2026-10-08/<task>-red.log`
before implementers start. Implementers save green output to `<task>-green.log`.
Commands:
- TS focused: `node_modules/.bin/tsx --test lib/vote-source.test.ts skills/researcher/official-votes.test.ts`
- Python: `python3 -m unittest discover -s tools/congress-collector -p 'test_*.py' -v`
- Typecheck: `node_modules/.bin/tsc --noEmit -p .`
- Allowed regression suite: `artifacts/official-votes-contract-2026-10-08/run-allowed-suite.sh`
  (excludes `pipeline/patterns/confirmatory-guard-inpath.test.ts` and
  `pipeline/patterns/timing-detectors-baseline.test.ts`). Baseline before this
  package: 338/338, 46 files.

## 10. Stopping condition

Your assigned files are written/reviewed, your commands ran and you inspected
the output, and you returned a concise report: files touched (writers), commands
+ observed pass/fail counts, open problems. Do not continue into acquisition,
integration or other agents' files. Never claim a pass you did not observe.
Overall CivicLens remains NOT COMPLETE / NOT CERTIFIED.

## 11. Runtime integration amendments (2026-10-16, GovTrack replacement)

Leader-authored, after the maintainer's 2026-10-16 instruction to replace the
GovTrack API with the pinned `unitedstates/congress` path. These amendments
apply to that runtime. Interfaces:
`docs/official-vote-runtime-integration-2026-10-16.md`. They are recorded here
before any code is built against them.

- **Scope update.** §0's exclusions on Senate acquisition, collector
  installation, member/LIS identity mapping and consumer integration are
  lifted for that package only. They are bounded by the integration file and
  the run authority. Nothing else in §0–§10 changes.
- **Speaker election context (decides D6 for positions only).** A House roll is
  in `election` position context iff all three conditions hold:
  1. the trimmed official `vote-question` is exactly `Election of the Speaker`;
  2. `vote-metadata/vote-totals` carries `totals-by-candidate`;
  3. `legis-num` is empty.

  Every other roll is `standard`. Bill resolution is unchanged: empty
  `legis-num` → `unsupported_record`. A Speaker election is NOT given an
  authoritative non-bill subtype, because the question wording is never
  evidence for non-bill status. Frozen official sample: 2025 roll 2. Its
  candidate tokens such as `Johnson (LA)` normalize to `other` and are never
  collapsed.
- **Senate amendment sample.** The official 119/1 roll 3 has `document_type`
  `S.Amdt.`, an empty number and `amendment_to_document_number` `S. 5`. The
  existing classifier returns `resolved_bill` s 5 with amendment `S. 5` (D5
  string unchanged). The pinned collector agrees (`bill` s 5). No partial-record
  (P-1) change is adopted. The D1–D4 proposals remain unadopted.
- **Raw versus collector.** Raw official XML is the provenance and classifier
  input: positions, document fields, declared totals and identity. Pinned
  collector JSON is a mandatory cross-check:
  - voter sets, per-voter options and bill identity must agree;
  - the only tolerated difference is the collector's documented Senate rewrite
    `Present, Giving Live Pair` → `Present`.

  Disagreement is a typed failure (`cross_check_mismatch`) or a resolution
  `ambiguity`, never a silent preference.
- **Identity.** Voter ids are mapped through a derived, hash-pinned snapshot of
  congress-legislators `d5af3d2d2490f8c6532c9490b1f47a76cacca699`. House ids
  are bioguide `name-id`; Senate ids are LIS `lis_member_id` → bioguide. The
  mapping is dated: a term in that chamber must cover the roll date. The
  snapshot floor is `2019-01-03`, and dates before it fail closed. The
  collector's name-based `lookup_legislator`, the congress-legislators
  auto-clone and `download` are disabled inside the bridge. The collector
  `govtrack` option is never used.
- **Strict roll analysis.** Every required roll in a member's chamber window
  must download, parse, cross-check, map identity and normalize, or the member
  fetch fails. Member participation then follows §3: a missing row while in
  service is `not_recorded`, and a row outside dated service is an identity
  failure.

### Senate empty document projection (consistency repair 2026-10-21)

When the raw bridge returns `documents: []`, its singular `document` must be
exactly the six existing document/amendment fields, each an explicit empty
string. This represents absent source identity; it is structurally consistent
and classifies as `unsupported_record` with a null bill. No question/title-based
bill inference or authoritative non-bill subtype is added. Nonempty arrays
retain their first-projection and existing bundle checks; contradictory or
partially populated empty-array projections fail closed. This corrects the
downstream empty-array consistency check without changing acquisition receipts.
See the [captured procedural source and preserved failure](senate-empty-document-source-2026-10-21.md).

### Identity pin refresh (amendment 2026-11-24)

The identity bullet above now refers to congress-legislators
`2b1fe728159fe5f5e145277794106e800719eb50`, not `d5af3d2`. The mapping stays
dated and keeps the `2019-01-03` floor. It also gains an `as_of` limit
(`2026-11-24`, the capture date). A roll or member date after `as_of` fails
closed with `date_after_snapshot` until the pin is refreshed. The refresh changes
only two senators' terms (H001104, M001244). Receipts and the diff are recorded
in `SOURCES.md`. No other identity rule changes: House ids stay bioguide, Senate
ids stay LIS → bioguide, and name-based lookup stays disabled.

### Identity `as_of` refresh (amendment 2026-11-26)

The commit stays the same. A re-capture on 2026-11-26 moved `as_of` to
`2026-11-26` (`legislators-2b1fe72-asof-2026-11-26-voting-terms.json`). This is
allowed only after the snapshot's in-service people match the official House
Clerk and Senate member lists for the new date (`lib/identity-roster-check.ts`).
People and terms are unchanged. Receipts and the cross-check are in `SOURCES.md`.
