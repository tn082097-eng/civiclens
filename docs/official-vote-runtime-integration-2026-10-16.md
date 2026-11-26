# Official-vote runtime integration — frozen interface (2026-10-16)

Leader-authored (Claude Code, `claude-opus-5-5`). This file replaces the
GovTrack vote and vote→bill API consumers with official House Clerk / Senate
LIS XML. The XML is parsed by the pinned `unitedstates/congress` collector
(`8184bcb13160da2389dea4c902de67817db681fc`) and classified by
`lib/vote-source.ts`. It extends `docs/official-vote-source-contract-2026-10-08.md`;
that contract still governs canonical identity, windows, positions and
classification. Shared TypeScript wire types are in `lib/official-vote-types.ts`.
Workers must not redefine them. If code and this file disagree, report it. Do
not invent a third shape.

Worktree: `/home/captainanime/Developer/civiclens-reliability-votes`. Branch:
`codex/reliability-official-votes`. Run directory (ignored):
`artifacts/govtrack-replacement-2026-10-16-0907/`.

## 0. Global rules (every worker)

- **No GovTrack.** No active code may request `govtrack.us`. There is no
  GovTrack fallback, and no automatic retry that turns a failure into success.
- **Failures throw.** Any source, runtime, identity, count, date or coverage
  failure throws `OfficialVoteFailure` (Python: non-zero exit plus a JSON
  `status: failed`/`incomplete`). It never becomes `votes = []`, a skipped
  row, or a verified-empty claim.
- **Tests are isolated.** Tests use only frozen fixtures, synthetic inputs
  (named and commented SYNTHETIC) and temp DuckDB (`db/__testkit__/temp-db.ts`).
  Tests never use the network, `data/civiclens.duckdb`, `PIPE_DIR` task dirs,
  OCR, detectors or renders.
- **Downloaded code runs offline.** The pinned collector and any downloaded
  wheel run only inside `unshare -rn` with `python -I -B`, an isolated TMPDIR
  and HOME, and a fresh empty cwd.
- **Out of bounds.** No global installs and no `npm install`. No git
  commit/merge/branch/stash/reset/clean. Never touch the main, launch or
  track-b checkouts.
- **Commands.** Python is `python3` 3.12, stdlib only, outside the locked
  runtime. TypeScript is `node_modules/.bin/tsx --test <files>` and
  `node_modules/.bin/tsc --noEmit -p .`. Never run bare `npm test`.
- **Logs.** Each worker writes RED/GREEN logs and a report under
  `artifacts/govtrack-replacement-2026-10-16-0907/workers/<worker>/`. Logs are
  never overwritten; use the suffix `-attempt2`.

## 1. Collector runtime and bridge (owner: collector-runtime)

### 1a. Vendored pinned source

Copy the following byte-for-byte from the verified archive
`artifacts/official-votes-contract-2026-10-08/collector-runtime-gate-a-1/gate-a/src/congress-8184bcb13160da2389dea4c902de67817db681fc/`
into `tools/congress-collector/vendor/unitedstates-congress-8184bcb/`:

- `LICENSE`
- `congress/__init__.py`
- `congress/tasks/__init__.py`
- `congress/tasks/utils.py`
- `congress/tasks/vote_info.py`

Write `VENDOR.json` alongside them with these fields: `repository`, `commit`,
`archive_url` and `archive_sha256` (from `gate-a/archive-receipt.json`), and
`files: {relpath: {bytes, sha256}}`. Each file hash must equal its entry in
`gate-a/archive-inventory.json`. Never `pip install` the congress package or run
its `setup.py`/`run.py`. Do not re-download the archive.

### 1b. Locked runtime

**Lock scope.** The lock covers the import closure of `congress.tasks.vote_info`
at the pin: `lxml`, `pytz`, `scrapelib`, plus scrapelib's own runtime
dependencies. The other 10 declared requirements are needed only by collector
tasks/CLI that are never imported. This is a leader ruling. If it is wrong, the
cost is an ImportError at bridge start, which fails closed and is visible in
tests.

**`tools/congress-collector/requirements.lock`.** pip hash format, exact `==`
versions, binary wheels only, one `--hash=sha256:` per wheel actually
downloaded (cp312 manylinux x86_64 or `py3-none-any`). A header comment records
the index URL and resolution date.

**Resolution (network, one-time, recorded).** Run from a fresh venv created
under the run dir. Clear the environment: `env -i PATH=/usr/bin:/bin
HOME=<scratch> PIP_CONFIG_FILE=/dev/null PIP_NO_INPUT=1`. Pass
`--index-url https://pypi.org/simple`, `--only-binary=:all:`,
`--no-cache-dir` and `--keyring-provider disabled`. Use the pip
`--report`/`download` output to record each wheel's URL, filename, sha256 and
bytes in `workers/collector-runtime/resolution-receipts.json`. No sdist, no
build and no Python download. A missing wheel is a recorded failure, never a
fallback.

**`tools/congress-collector/runtime.py`** (stdlib) has three subcommands:

- `resolve --scratch <dir>` is the network step above. Its output is the
  wheelhouse plus receipts.
- `install --wheelhouse <dir> [--runtime-dir <dir>]` runs under `unshare -rn`.
  It creates `venv` with `python3 -I -m venv`, then runs `pip install
  --no-index --find-links <wheelhouse> --require-hashes --only-binary=:all:
  --no-deps -r requirements.lock`. It writes `runtime.json`:
  `{lock_sha256, python, packages{name:version}, vendor_manifest_sha256,
  created_at}`.
- `check [--runtime-dir]` prints that JSON, or exits 1 when the runtime is
  missing or stale. Stale means the `lock_sha256` or `vendor_manifest_sha256`
  differs from the current files.

**Runtime location.** The default runtime dir is
`tools/congress-collector/.runtime/` (gitignored). The
`CIVICLENS_COLLECTOR_RUNTIME` env var overrides it.

### 1c. `tools/congress-collector/bridge.py`

The bridge is executed only as:

```
unshare -rn <runtime>/venv/bin/python -I -B tools/congress-collector/bridge.py
```

It runs with cwd set to a fresh empty temp dir, with env `{PATH:/usr/bin:/bin,
HOME:<tmp>, TMPDIR:<tmp>, LANG:C.UTF-8}`, and reads the request JSON from stdin:
`{"rolls": BridgeRollInput[]}`.

**Bridge-level checks.** Any failure exits 2 with stderr JSON
`{"status":"failed","reason":...}` and no stdout JSON.

1. The interfaces in `/proc/self/net/dev` must be a subset of `{lo}`.
2. Every vendored file hash must match `VENDOR.json`.
3. Put the vendor root on `sys.path` explicitly, then import
   `congress.tasks.vote_info`.
4. Replace `utils.lookup_legislator`, `utils.require_congress_legislators_repo`
   and `utils.download` with functions that raise
   `CollectorInferenceDisabled`. Record these names in `inference_disabled`.
   The `govtrack` option is never set.
5. The request must be valid: every key matches its identity fields, and
   `path` is absolute and exists.

**Per-roll processing.** Results keep input order and come out as
`BridgeRollOk | BridgeRollFail` (`lib/official-vote-types.ts`):

- Body sha256 differs from the input → `malformed_source`.
- `b'This vote was vacated'` → `unsupported_record`.
- `b'roll-call-vote-not-available.htm'` → `incomplete_fetch`.
- Reject `<!ENTITY`/internal DTD subsets → `malformed_source`.
- **Raw extraction.** Use stdlib `xml.etree.ElementTree` exactly as the
  `HouseRaw`/`SenateRaw` field comments describe.
  - House date: `action-date` such as `3-Jan-2025`.
  - Senate date: `vote_date` such as `January 15, 2025,  05:57 PM`; collapse
    whitespace before parsing.
  - House totals: `totals-by-vote` → `by_vote`; else `totals-by-candidate` →
    `by_candidate`; neither, or both → `malformed_source`.
  - Senate `<count>` empty elements → 0.
  - Voters: one entry per `recorded-vote` (House) or `members/member`
    (Senate). An empty voter id → `malformed_source`. A duplicate voter id →
    `ambiguity`.
- **Identity.** Raw congress, session, roll and date must equal the input,
  else `malformed_source` with the mismatching field names.
- **Collector.** `dom = lxml.etree.fromstring(body)`. Build the vote dict as
  `vote_info.fetch_vote` does: `vote_id = f"{h|s}{roll}-{congress}.{year}"`,
  `chamber` `'h'`/`'s'`, `congress`, `session = str(year)`, `number`,
  `source_url`. Call `parse_house_vote(dom, vote)` or
  `parse_senate_vote(dom, vote)` with stdout redirected to stderr (upstream
  `print`s), drop `updated_at`, and serialize through
  `json.dumps(..., default=utils.format_datetime)`. Any exception →
  `malformed_source` with the reason `collector parse failed: <type>: <msg>`.
- Bridge exit is 0 whenever the top-level JSON (`BridgeRun`) was written.

### 1d. `lib/collector-bridge.ts`

```ts
export class CollectorBridgeError extends Error { code: 'runtime_missing'|'runtime_stale'|'netns_unavailable'|'bridge_failed'|'malformed_output' }
export function resolveCollectorRuntime(opts?: { runtimeDir?: string }): { runtimeDir: string; python: string; runtime: { lock_sha256: string; python: string; packages: Record<string,string>; vendor_manifest_sha256: string } } // throws CollectorBridgeError
export async function runCollectorBridge(rolls: BridgeRollInput[], opts?: { runtimeDir?: string; timeoutMs?: number }): Promise<BridgeRun>
```

- Spawn exactly as in §1c, using `mkdtemp` for cwd/HOME/TMPDIR, and remove the
  temp dir afterwards.
- Validate the output:
  - contract and version;
  - `results.length` equals the input length, with keys in the same order;
  - `network.interfaces` is a subset of `['lo']`;
  - `collector.commit === '8184bcb13160da2389dea4c902de67817db681fc'`;
  - `runtime.lock_sha256` equals the current lock file hash;
  - each ok result's raw identity equals its input.
- Any violation throws `CollectorBridgeError('malformed_output')`. A non-zero
  exit throws `bridge_failed` with the stderr reason. An empty input array is
  an error, never an empty success.

### 1e. Frozen collector outputs

Run the real bridge once on the 7 official XML fixtures and save the result as
`fixtures/votes/collector-output/bridge-run-official-samples.json`, with
`README.md` recording the input hashes, command and runtime JSON. The 7
fixtures are:

- House: `house-acquisition/house-2025-roll001.xml`,
  `official-samples/house-speaker-2025-roll002.xml`,
  `official-samples/house-bill-2025-roll006.xml`;
- Senate: `official-samples/senate-119-1-roll00001.xml`,
  `senate-amendment-119-1-roll00003.xml`, `senate-bill-119-1-roll00570.xml`,
  `senate-nomination-119-1-roll00655.xml`.

Input `path`s are recorded repo-relative in the frozen copy. Expected dates:

| Roll | Date |
|---|---|
| House 2025 roll 1 | 2025-01-03 |
| House 2025 roll 2 | 2025-01-03 |
| House 2025 roll 6 | 2025-01-07 |
| Senate 119/1 roll 1 | 2025-01-09 |
| Senate 119/1 roll 3 | 2025-01-15 |
| Senate 119/1 roll 570 | 2025-10-09 |
| Senate 119/1 roll 655 | 2025-12-18 |

This file is FO-derived output of the pinned code. It is not synthetic, and it
must never be hand-edited.

## 2. Acquisition and discovery (owner: official-vote-ingest, Python)

All modules are stdlib-only, in `tools/congress-collector/`. Reuse `adapter.py`
(`parse_listing`, `validate_inventory`, `acquire`, `validate_xml`,
`fetch_xml`, `Response`, `subtract_months`) by import. Do not edit
`adapter.py` unless a defect blocks the work; if you must, report it.

Every fetcher makes one attempt and refuses redirects. It uses a 30 s timeout
and a 5 MiB cap. It records `{url, final_url, status, content_type, sha256,
bytes, body_complete, read_error, fetched_at}`. URLs are allow-listed by exact
pattern. Fetch functions are injectable for tests.

- **`house_discovery.py`**
  - `discover_house(window, out_dir, fetch_page) -> (inventory_path, sha256)`.
  - For each year in `window[0][:4]..window[1][:4]`, fetch page 1 of
    `https://clerk.house.gov/Votes/MemberVotes?CongressNum={c}&Session={1st|2nd}&Page=N`.
    Read the total, then fetch pages 2..ceil(total/10).
  - Save raw bytes as `{year}-page{NNN}.html`. Write `inventory.json` in exactly
    the 2026-10-04 packet shape: keys `window`, `summary` (year,
    published_total, pages, window_total, …), `receipts` (url, status, path,
    sha256, range, total, fetched_at), `inventory` and `window_total`. The
    reference packet is
    `/home/captainanime/NoService/Projects/CivicLens/Sources/votes/2026-10-04-house-discovery/inventory.json`
    (read-only).
  - Then run `adapter.validate_inventory(inventory_path, sha256)` as proof.
  - Any HTTP or parse failure, or a total that changes mid-crawl, raises
    `DiscoveryError`. A partial inventory is never written as success.
- **`senate_adapter.py`**
  - Menu discovery:
    - fetch `https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_{c}_{s}.xml`;
    - the `congress`/`session` elements must match;
    - vote numbers must be exactly `{1..N}`, unique, with N ≥ 1;
    - each date is `vote_date` `DD-Mon` plus `congress_year`.
  - The Senate inventory packet JSON holds menu receipts and rows
    `{year, roll, date, congress, session}`. Its sha256 is the
    `inventory_sha256`.
  - `acquire_senate(...)` mirrors `adapter.acquire` exactly, with these
    differences:
    - `chamber: 'senate'`, `source_url = senateSourceUrl`, `url = source_url`,
      `page = 1`, `index_receipt` = the menu receipt;
    - responses are saved as `responses/{year}-s{roll:05d}.body`;
    - `validate_senate_xml` checks root `roll_call_vote` and that `congress`,
      `session`, `vote_number` and the `vote_date` date equal the record.
  - Senate acquired metadata:
    `{key, chamber:'senate', congress, session, roll, date, question, vote_title, result, document_type, document_number, document_congress, amendment_number, amendment_to_document_number, recorded_vote_count, position_tokens}`.
  - Top-level manifest keys are the same as contract §6, with
    `chamber: "senate"`.
- **`acquire_window.py`** (CLI). Output is always a NEW directory. It writes
  `window-run.json` in the `WindowRun` shape (`lib/official-vote-types.ts`).
  - `--chamber house|senate --as-of YYYY-MM-DD --months 48 --output <new-dir>`
    (window mode): window = `[subtract_months(as_of, 48), as_of]`, then
    discovery into `discovery/`, then acquisition into `acquisition/`.
  - `--chamber house|senate --rolls-json <file> --output <new-dir>` (rolls
    mode): the file is `[{key, date}]`. Every key must parse as a canonical
    key of that chamber. No discovery runs. It builds the records directly
    (identity from the key, date = expected date) and fetches each detail with
    the same identity check. A date mismatch → `malformed_source`. It writes a
    manifest in the same record shape with `window: null` in `window-run.json`.
  - Exit 0 only when `status: complete` (every record acquired). Otherwise exit
    1 and keep everything. stdout is one JSON line: `{"run_dir":..., "status":...}`.
  - Optional test-only hook: `--fixture-map <json>` maps URL → local file
    (status 200, complete). The output manifest then records
    `"fixture_mode": true` in `window-run.json` `reason` so it can never pass
    as live evidence.
- **Tests.**
  - `test_house_discovery.py`: a SYNTHETIC complete session (2 pages) plus a
    changed-total failure plus HTTP failure. Also parse the real frozen
    `fixtures/votes/house-acquisition/2025-page037.html` via `parse_listing`.
  - `test_senate_adapter.py`: the real frozen `senate-menu-119-1.xml` (659
    contiguous votes) and the real Senate detail fixtures through
    `validate_senate_xml`, plus SYNTHETIC gap/duplicate/wrong-session menus,
    a 404, a redirect and a date mismatch.
  - `test_acquire_window.py`: rolls mode with the fixture map over the 7 real
    XMLs completes; one wrong expected date → incomplete, exit 1.

## 3. Identity snapshot (owner: official-vote-ingest)

- **Inputs.** The pinned congress-legislators commit
  `d5af3d2d2490f8c6532c9490b1f47a76cacca699`:
  - `legislators-current.yaml`, sha256 `bd32e62b…3a49`, 1,081,187 bytes;
  - `legislators-historical.yaml`, sha256 `9641615f…8c91`, 8,997,407 bytes.

  Both are in `artifacts/govtrack-replacement-2026-10-16-0907/source-packet/`.
  Never read `legislators-historical.yaml.partial`.
- **`tools/congress-collector/derive_identity.ts`** (tsx + `js-yaml`).
  - Args: `--current <path> --historical <path> --out <path>`. Verify both
    input sha256 and byte counts before parsing.
  - **Floor:** `2019-01-03`. Include every person with at least one `rep` or
    `sen` term whose `end >= floor`. Keep only those terms. The floor and the
    exclusion rule are written into the output.
  - A duplicate bioguide, a duplicate LIS id, a term missing type/start/end, or
    `start > end` makes derivation fail.
  - Output `fixtures/votes/identity/legislators-d5af3d2-voting-terms.json` is
    deterministic, with sorted keys and people sorted by bioguide:
    `{contract:'civiclens.official-vote-identity', version:1, source:{repository, commit, license:'CC0-1.0', inputs:[{name,url,bytes,sha256}]}, floor, exclusion:'...', people:[{bioguide, lis|null, terms:[{chamber:'house'|'senate', start, end, state, district|null}]}]}`.
    Also write `fixtures/votes/identity/README.md` with the command and the
    output sha256.
- **`lib/official-identity.ts`**

  ```ts
  export const IDENTITY_SNAPSHOT_PATH: string;        // the fixture path above (resolved from repo root)
  export const IDENTITY_SNAPSHOT_SHA256: string;      // literal hash of the committed output
  export interface IdentityIndex { commit: string; snapshotSha256: string; floor: string;
    personForVoter(chamber: Chamber, voterId: string, date: string): string;   // House voterId = bioguide, Senate = LIS; returns bioguide; throws OfficialVoteFailure('identity', ...)
    inService(bioguide: string, chamber: Chamber, date: string): boolean;       // some term of that chamber with start <= date <= end; throws if date < floor
  }
  export function loadIdentityIndex(path?: string, expectedSha256?: string): IdentityIndex; // verifies sha256 first
  ```

  `personForVoter` throws for any of these: date before floor, unknown id, or
  no term in that chamber covering the date (codes `date_before_floor`,
  `unmapped_voter`, `voter_not_in_service`). The lookup itself stays strict;
  the approved listing rule in §4 is applied only by the normalizer.

- **Amendment (pin refresh 2026-11-24).** The pin is now commit
  `2b1fe728159fe5f5e145277794106e800719eb50`. The output is
  `fixtures/votes/identity/legislators-2b1fe72-voting-terms.json` with contract
  `version:2` and a new top-level `as_of` (`2026-11-24`). `IdentityIndex` also
  exposes `asOf`. Both lookups throw `date_after_snapshot` for a date after
  `as_of`. Inputs, receipts and the two-person diff are in `SOURCES.md`
  (identity snapshot, current). Everything else in this section is unchanged.

## 4. Normalization (owner: official-vote-ingest, TS)

`skills/researcher/official-member-votes.ts` is pure: no I/O except reading
files named in its inputs. It imports `lib/vote-source.ts`,
`lib/official-vote-types.ts`, `lib/official-identity.ts` and
`skills/researcher/official-votes.ts` (`validateAcquisitionManifest`,
`verifyResponseBodies`).

```ts
export function loadWindowRun(runDir: string): { run: WindowRun; manifest: AcquisitionManifestLike; bridgeInputs: BridgeRollInput[] };
export function analyzeRoll(input: BridgeRollInput, result: BridgeRollOk | BridgeRollFail, identity: IdentityIndex): RollAnalysis;
export function classifyRoll(raw: HouseRaw | SenateRaw, collector: Record<string, unknown>): OfficialVoteResolution;
export function normalizeMemberVotes(args: { runDir: string; run: WindowRun; bridge: BridgeRun; bridgeInputs: BridgeRollInput[]; identity: IdentityIndex; bioguideId: string; chamber: Chamber; asOf: string }): OfficialMemberVotes;
```

`AcquisitionManifestLike` and `RollAnalysis` are exported by this module.

**`loadWindowRun` throws `OfficialVoteFailure`** in these cases:

- the run's contract, version, chamber or mode is wrong;
- `status !== 'complete'`;
- the manifest sha256 ≠ `manifest_sha256`;
- the manifest status ≠ `acquisition_complete`;
- any in-window record is not `acquired`;
- zero required rolls (code `zero_required_rolls`);
- for House window mode, `validateAcquisitionManifest(manifest, {window:{start,end}, coverageMonths:48})`
  does not return `complete`;
- for Senate, the equivalent field checks of contract §7 adapted to
  `senateSourceUrl`/`chamber: 'senate'` fail;
- any response body fails `verifyResponseBodies`. Write a Senate-capable
  equivalent locally if the House-only one rejects senate.

`bridgeInputs` are the acquired records mapped to `BridgeRollInput`, with
absolute `path` = `join(runDir, 'acquisition', response.path)`.

**`analyzeRoll`**

- A bridge failure throws, with stage `collector` and code = the bridge
  outcome.
- **Cross-check.** The collector `votes` (an option → voter-list object;
  ignore the string voter `"VP"`) must give the same voter-id set as
  `raw.voters`. Each voter's collector option must equal its `raw_position`.
  The single permitted rewrite is Senate raw `Present, Giving Live Pair` →
  collector `Present`.
- **Declared totals.**
  - House `by_vote`: buckets `Yea|Aye→yea`, `Nay|No→nay`, `Present`,
    `Not Voting`. No other token is allowed.
  - House `by_candidate`: per-candidate counts equal; the sum equals the
    number of voters.
  - Senate: `yeas` = #Yea, `nays` = #Nay, `present` = #Present + #Present,
    Giving Live Pair, `absent` = #Not Voting, plus `Guilty`→yeas and
    `Not Guilty`→nays. Any other token is a mismatch.
  - A mismatch throws with stage `collector` and code `cross_check_mismatch`.
- **Identity (maintainer-approved amendment, 2026-10-20).** Map every raw
  voter through `identity.personForVoter` on the roll date. A failure throws
  except a known identity whose lookup throws `voter_not_in_service` and whose
  raw position is exactly `Not Voting`. Retain that row as an
  `outOfServiceListings` entry `{rollKey, chamber, voterId, rawPosition, date}`;
  do not attribute a vote or add it to the member-to-position map. Unknown
  identities, dates before the floor and every other out-of-service position
  still fail. Collector/raw voter-set comparisons and declared totals still
  cover every row, including these listings. Duplicate raw IDs and duplicate
  resolved people still fail. This rule has no member- or roll-specific case.
  `RollAnalysis` exposes the listings and `normalizeMemberVotes` aggregates
  them into coverage. New coverage always includes the array (empty when none);
  the schema accepts its absence only for older artifacts. Validate canonical
  roll/chamber/date, chamber-specific voter ID, exact `Not Voting`, window
  membership and unique (rollKey, voterId) pairs. Keep original XML and hashes.
  A listing is source evidence of non-participation, not service or an
  attributed absence vote.
- **Position context.**
  - `election` iff all three hold: House, `raw.question === 'Election of the
    Speaker'`, and `raw.totals.kind === 'by_candidate'` and
    `raw.legis_num === ''`.
  - Otherwise `standard`.
  - `normalizePosition(raw_position, ctx)`; a not-ok result throws with stage
    `normalization` and code `unsupported_position`.

**`classifyRoll`**

- House uses `classifyHouseRoll({congress, legis_num, vote_type, question, amendment_num})`.
- Senate uses `classifySenateRoll({congress, documentCongress: document_congress, documentType, documentNumber, documentName, amendmentNumber, amendmentToDocumentNumber})`.
- Then cross-check against the collector `bill`:
  - resolved_bill: the collector `bill` must exist and equal
    `{congress, type, number}`, else
    `{outcome:'ambiguity', reason:'official classifier and pinned collector disagree on bill identity: …'}`;
  - authoritative_non_bill with a collector `bill` present → ambiguity;
  - other outcomes are kept unchanged.
- Map to `OfficialVoteResolution`:
  - `billId` = `${congress}-${type}-${number}`;
  - `subtype` only for non_bill;
  - `amendment` only for resolved_bill;
  - `reason` only for unresolved outcomes.

**`normalizeMemberVotes`**

- Every bridge result must be analyzable; a strict failure on any roll fails the
  member.
- For each roll:
  - if the member is `inService` on that date, a voter row becomes a vote
    record; no row → `notRecorded` (key listed), never absent;
  - a member who appears in a roll while not in service → `identity` /
    `appears_out_of_service`, except an approved `Not Voting` listing above:
    it contributes no member vote, no in-service roll and no notRecorded key,
    while remaining present in `outOfServiceListings`.
- If `inServiceRolls > 0 && recorded === 0` → `identity` /
  `member_never_recorded`.
- Record fields follow `OfficialVoteRecord`:
  - source `clerk.house.gov` / `senate.gov`; `sourceUrl` = the record
    source_url; `sourceSha256` = the response sha256; `confidence: 1`;
  - `question` = `raw.question`;
  - House `billTitle` = `legis_num && vote_desc ? `${legis_num}: ${vote_desc}`
    : (vote_desc || question)`; Senate `billTitle` = `vote_title || question`.
- Sort by date desc, then roll desc.
- Build the coverage per `VoteCoverage`.

**Tests** (`skills/researcher/official-member-votes.test.ts`) use SYNTHETIC
bridge/raw objects plus the real identity snapshot and the frozen
`fixtures/votes/collector-output/bridge-run-official-samples.json` once
collector-runtime has written it; until then, use synthetic data only. Cover:

- each cross-check failure;
- an unmapped LIS id;
- before floor;
- duplicate person;
- Speaker `other`;
- Senate pair rewrite;
- not_recorded;
- appears out of service;
- member never recorded;
- zero required rolls;
- an incomplete run;
- a collector/classifier bill disagreement.

## 5. Consumers and persistence (owner: consumer-persistence)

Import only from `lib/official-vote-types.ts`, `lib/vote-source.ts` and
`skills/researcher/official-vote-runtime.ts` (the stub, which the leader
integrates later). Inject dependencies so tests never hit the stub or the
network.

- **`lib/schemas.ts` / `lib/types.ts`**
  - `VoteSchema.vote` adds `'other'`.
  - Add these optional official fields: `rawPosition`, `sourceSha256`,
    `rollKey`, `chamber`, `congress`, `session`, `roll`, `question`,
    `resolution` (the shape of `OfficialVoteResolution`).
  - Refinement: if any official field is present, all must be present and
    consistent:
    - `parseRollKey(rollKey)` equals chamber/congress/session/roll;
    - `sourceUrl` equals houseSourceUrl/senateSourceUrl;
    - `source` matches the chamber;
    - resolution invariants per §4;
    - `billId` matches `^\d+-(hr|s|hjres|sjres|hconres|sconres|hres|sres)-[1-9]\d*$`
      and its congress equals the roll congress.
  - `vote: 'other'` is allowed only on official rows.
  - `PoliticianDataSchema` adds an optional `voteCoverage` (the `VoteCoverage`
    shape).
  - Legacy GovTrack rows (no official fields) stay valid. `VoteData` in
    `lib/types.ts` mirrors this.
- **`skills/researcher/fetch.ts`**
  - Delete `fetchGovTrackVotes` and the GovTrack `normalizeVote`.
  - Step 5 calls an exported
    `collectOfficialVotes(bioguideId, chamber, asOf, fetcher = fetchOfficialMemberVotes)`
    with `source: {mode:'live'}`. It returns
    `{votes: OfficialVoteRecord[], coverage}` and propagates
    `OfficialVoteFailure` unchanged.
  - Chamber must be `house` or `senate`; anything else throws
    `OfficialVoteFailure('identity','unsupported_chamber')`.
  - `asOf` = today's UTC date.
  - `LiveFetchResult` gains `voteCoverage`; its votes type becomes the
    persisted vote row type.
  - The header comment and the warnings describe official Clerk/LIS +
    pinned collector.
- **`agents/researcher.ts`.** Persist `voteCoverage` into the data. On
  `OfficialVoteFailure`, mark failed with `stage/code` (already fail-closed
  via catch).
- **`db/load-from-tasks.ts`**
  - Export `planVoteBatch(memberId, votes, coverage?)` (pure; throws
    `VoteBatchError` listing every problem) and
    `applyVoteBatch(conn, memberId, plan)` (transactional).
  - `loadOne(pick, opts?: {conn?})` calls `planVoteBatch` right after the
    artifact is parsed, BEFORE any write for that member.
  - **Official batch** (every row has `rollKey`):
    - row valid per the schema refinement; no duplicate rollKey;
    - `vote_id = rollKey`, `position = vote`, `bill_id =` `resolution.billId`
      when resolved_bill else NULL, `question`, `source_url`;
    - empty official batch is allowed only with
      `voteCoverage.outcome==='ok'`.
  - **Legacy batch** (no row has `rollKey`): existing GovTrack URL behaviour
    (`voteIdFromUrl`, skip id-less rows, link restore via `_vote_link`). A
    legacy row whose `sourceUrl` host is `clerk.house.gov`/`senate.gov` is an
    error: official identity is never inferred from a URL.
  - **Mixed batch** → error. An empty legacy batch → vote tables untouched
    (preserve, like donors).
  - **`applyVoteBatch`:** `BEGIN TRANSACTION` → DELETE target member votes →
    INSERT all → (legacy only: restore links) → `COMMIT`. On any error,
    `ROLLBACK` and rethrow. Official batches never restore `_vote_link`.
- **`db/load-bill-summaries.ts`**
  - Delete `GOVTRACK_TYPE_MAP`, `parseGovtrackUrl` and `fetchGovtrackBillId`.
  - Pass 1 regex applies ONLY to legacy rows (`source_url LIKE
    'https://www.govtrack.us/%'`).
  - Pass 2 becomes the official pass,
    `backfillBillIds(scope, {officialPass?, apiPass?, apiLimit?, conn?, resolveRolls?})`;
    `apiPass` is a deprecated alias of `officialPass`:
    - select scoped legacy rows with NULL bill_id;
    - group by `vote_id`, which must `parseRollKey`, else count invalid and
      fail;
    - all rows of a key must share one date, else fail;
    - call `resolveRolls(requests, {source:{mode:'live'}})` once (default
      `resolveOfficialRolls`; `apiLimit` caps distinct rolls; the capped
      remainder is reported in the result as `notAttempted`);
    - every result must be `ok` before any UPDATE, else throw
      `OfficialVoteFailure` with all failures;
    - then, in one transaction, `UPDATE votes SET bill_id` for resolved_bill
      only;
    - non-bill/unresolved outcomes are counted and stay NULL;
    - return `{filled, skipped, officialResolved, nonBill, unresolved, notAttempted, total}`
      (`apiResolved` kept as an alias of `officialResolved` for callers).
  - Logs and the usage text say "official Clerk/LIS roll resolution (pinned
    collector)".
  - Congress.gov summaries are unchanged.
- **`agents/pipeline.ts`.** Help text: `--official-pass` (with `--api-pass`
  accepted as an alias) and `--api-limit`. Pass it through.
- **`skills/researcher/{CONTRACT,SKILL}.md`** and `SOURCES.md` (a dated
  section only) describe the official path.
- **Tests.**
  - `db/load-from-tasks.votes.test.ts` (new) uses the real `loadOne` with a
    temp task dir and temp DuckDB connection. Cover:
    - an official batch loads by rollKey;
    - one invalid row → no DELETE, rows byte-equal;
    - an injected insert failure after DELETE → ROLLBACK, rows equal;
    - another member untouched;
    - a non-bill official row does not inherit an old GovTrack `bill_id` for
      the same key;
    - an unresolved row has bill_id NULL;
    - a mixed batch rejected;
    - a legacy official-URL row without rollKey rejected;
    - an empty legacy batch preserves rows;
    - an empty official batch with ok coverage clears rows.
  - Extend `db/load-bill-summaries.test.ts` with an injected resolver:
    - the official pass updates only resolved_bill;
    - a resolver failure → throw, with no UPDATE;
    - official rows are never touched by the regex pass;
    - a non-parseable legacy key fails.
  - `skills/researcher/fetch.official.test.ts` (new) covers:
    - `collectOfficialVotes` propagates a rejection (never `[]`);
    - it maps records;
    - an unsupported chamber;
    - a source scan asserting no `govtrack.us/api` in `skills/`, `db/`,
      `agents/`, `lib/` non-test `.ts` files.
  - Schema tests go in `lib/schemas.official-votes.test.ts` (new).

## 6. Leader integration (not delegated)

### Source-format ruling — 2026-10-16, before final review

The real Senate roll 119/1/655 is a bundle of 97 distinct PN documents with
matching document_congress 119 and 97 identical empty amendment projections.
It is not one nomination and the documents are not identical. `SenateRaw`
therefore has optional `documents: SenateRaw['document'][]`, retaining every
projection; `document` remains the first projection for interface compatibility.
Acquisition metadata likewise retains `documents` alongside the existing first
scalar fields. Raw XML and its hash remain the complete source record.

For multiple distinct documents, accept only a bundle whose every document is
PN, whose document congress matches the roll, and whose amendment projections
are identical and contain no bill-parent/amendment identity. Classification is
authoritative_non_bill/nomination only after checking the entire bundle. Mixed,
unknown or bill-document bundles, conflicting congresses or differing amendment
metadata fail explicitly. Identical repeated projections can be collapsed only
after comparing every projection. Never silently use the first of differing
bill identities. This addition does not adopt the synthetic-only P-1 proposal.

- The leader replaces the bodies of the stubs in
  `skills/researcher/official-vote-runtime.ts`.
- **Live window path:** spawn `python3 -I -B tools/congress-collector/acquire_window.py`
  into `artifacts/official-vote-runs/<chamber>-<asOf>-<utc-stamp>/`, then
  `loadWindowRun`, `runCollectorBridge`, `loadIdentityIndex` and
  `normalizeMemberVotes`.
- **Legacy resolution:** rolls mode, then the bridge, then `classifyRoll`.
- The leader writes the end-to-end fixture tests and runs the final checks.
