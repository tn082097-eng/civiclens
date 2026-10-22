# W1 source audit: official vote acquisition, window 2022-10-21..2026-10-21

Scope: read-only preflight of `tools/congress-collector/{acquire_window,adapter,house_discovery,senate_adapter,senate_documents}.py`, `skills/researcher/official-member-votes.ts` (loadWindowRun, validateCompleteManifest, validateDiscovery), `skills/researcher/official-votes.ts` (validateAcquisitionManifest, verifyResponseBodies), `lib/vote-source.ts` (subtractCalendarMonths, coverageWindow, source URL builders), and the scope note. No network, no DB, no test suites, no code edits. Line references are to the files as they exist in candidate e3eb789.

Not audited: `skills/researcher/official-vote-runtime.ts` (the caller of loadWindowRun at lines 126-178), `docs/official-vote-source-contract-2026-10-08.md` (not read; the wire contract was checked against the code instead), and the bridge/collector stage.

## Summary verdict

**BLOCKERS FOUND** (one latent, conditional blocker, plus no silent-complete paths found for the window run).

- BLOCKING-1 (F1) is a real Python/TS parser mismatch on the Senate menu. It is conditional: it only bites if a menu byte pattern appears that Python accepts and TS rejects (whitespace inside `vote_number`/`vote_date`, mixed-case month, attributes on `<congress>`/`<vote>`). The only frozen menu in the repo (`fixtures/votes/official-samples/senate-menu-119-1.xml`, 659 votes) does not contain such patterns, and no other Senate menus are in the repo. If it triggers, the failure is loud (loader rejects with `invalid_inventory`), not a false "complete".
- Nothing found lets a capped, sampled, or synthetic window run reach `status: complete` through the lead's command. The House and Senate window paths have no `max_rolls` cap, no sampling, and no fixture path (provided `--fixture-map` is not passed).
- The House manifest-to-TS contract (`validateCompleteManifest`, `validateAcquisitionManifest`, `verifyResponseBodies`, `validateDiscovery` House branch) is consistent with the Python writers on the happy path, verified field by field below.

## Findings

| id | severity | file:line | finding | consequence |
|---|---|---|---|---|
| F1 | BLOCKING (latent, conditional) | `skills/researcher/official-member-votes.ts:87-88` vs `tools/congress-collector/senate_adapter.py:132-145` | TS Senate menu checks are literal regexes: `<congress>([^<]*)</congress>` (exact tag, no attributes, must appear exactly once in the whole text), `<vote_number>(\d+)</vote_number>` (no whitespace), `<vote_date>(\d{1,2})-([A-Z][a-z]{2})</vote_date>` (case-sensitive, no whitespace), `<votes>...</votes>` and `<vote>...</vote>` literal tags. Python `parse_menu` uses ElementTree with `field()` (strips text, direct children only, attributes allowed) and `strptime('%d-%b-%Y')` (case-insensitive month). Python accepts a superset of what TS accepts. | A Senate menu that Python accepts (e.g. `<vote_date> 3-Dec </vote_date>`, `<vote_date>03-DEC</vote_date>`, a `<session>` element nested inside a vote) makes `validateDiscovery` throw `invalid_inventory` even though the Python run reported `complete`. Loud, not silent. Frozen evidence: only `fixtures/votes/official-samples/senate-menu-119-1.xml` (659 votes, all `DD-Mon` exact) exists in the repo; other Senate sessions (117-2, 118-1, 118-2, 119-2) are not inspected. Not determined whether live menus for those sessions contain such forms. |
| F2 | RISK | `skills/researcher/official-member-votes.ts:83` (`decodeEntities`, 5 entities) vs `tools/congress-collector/adapter.py:182` (`html.unescape`) | House listing status text is decoded with different entity sets. Frozen statuses sampled (`Passed`, `Failed`, `Agreed to`) contain no entities. | A status containing any other entity (e.g. `&nbsp;`, `&#x27;`) makes `validateDiscovery` line 95 (`listing metadata differs`) reject a complete run. Not observed. |
| F3 | RISK | `tools/congress-collector/adapter.py:467`, `tools/congress-collector/house_discovery.py:17`, `tools/congress-collector/senate_adapter.py` via `fetch_response` | Acquisition fetchers use `build_opener(NoRedirect())` with the default `ProxyHandler`, so `http_proxy`/`https_proxy` environment variables are honored. `runtime.py:92` uses `ProxyHandler({})`, but the acquisition path does not. | A proxy in the environment would carry official-source requests. `final_url` and status would still look correct, so a substitution would not be detected by the run. Mitigation: run with a clean environment (`env -i` with only PATH/HOME/TMPDIR) and confirm no proxy variables. |
| F4 | RISK | Lead command (cwd `/tmp/<fresh>`) vs `tools/congress-collector/acquire_window.py:8-9` | The lead's instructions set cwd to a fresh /tmp directory and also give relative `tools/...` and `artifacts/...` paths. Relative paths resolve against /tmp. | Either "No such file" or a run written to `/tmp/<fresh>/artifacts/...` instead of the worktree. Use absolute paths for the script and `--output`. |
| F5 | RISK | `tools/congress-collector/acquire_window.py:28` (mkdir before try), `:50` (except only OSError/ValueError/KeyError/TypeError) | `window-run.json` is written only for exceptions in that tuple. `FileExistsError` from the output mkdir (line 28) is raised before the try, so no `window-run.json` is written. Any other exception (KeyboardInterrupt, RecursionError, an uncaught AttributeError) leaves `acquisition/manifest.json` at `status: running` and no `window-run.json`. | Loader fails at `jsonFile(runDir,'window-run.json')` (ENOENT, mapped to `invalid_run`). Visible, but the evidence is weaker than "failed receipt always written". Exit code is 1 for these via the Python exit path, or traceback exit 1 for uncaught. |
| F6 | RISK | `tools/congress-collector/house_discovery.py:17-19`, `:85-87`; `tools/congress-collector/adapter.py:417-418`; `tools/congress-collector/senate_adapter.py:227` | Transport failures that happen before any HTTP response (DNS, connect refused, connect/socket timeout raised as URLError) are not caught in `fetch_response`. For listing pages, no receipt or body is written, only `DiscoveryError`. For detail XML, the record is `source_failure` with `reason` and `attempted_at`, but no `response` object, no URL/final_url, no body. | Scope requirement "preserve all failed attempts" is met only in the manifest reason, not as a response receipt. Run still fails/incomplete, so it is visible. |
| F7 | RISK | `tools/congress-collector/adapter.py:415-416`, `tools/congress-collector/house_discovery.py:65`, `senate_adapter.py:226` | No delay, backoff, Retry-After handling, or concurrency cap. About 2,250 House requests and roughly 2,000+ Senate requests are issued back to back. | Politeness concern to the Clerk/Senate servers. HTTP 429/503 becomes `source_failure` and an incomplete run (visible); there is no automatic retry, so a rate-limit event ends the run. Consider a fixed inter-request delay if the lead accepts the time cost. Not changed by this audit. |
| F8 | RISK | `tools/congress-collector/adapter.py:476-491`, `house_discovery.py:21-32` | `body_complete` is true when no `IncompleteRead` occurs and, if present, the Content-Length matches. An EOF-delimited response with no Content-Length that is truncated is treated as complete. | A truncated but still parseable listing or XML body would be accepted. Detail XML truncation usually fails XML parse (malformed, visible); listing truncation usually fails the counter/row checks. Low likelihood. |
| F9 | RISK | `tools/congress-collector/adapter.py:470` (`timeout=30`), `house_discovery.py:17` | 30 s is a per-socket-operation timeout, not a total deadline. The 5 MiB cap is applied after the read completes (`read(MAX+1)`). | A slow-drip response could hold a request for a long time. No wall-clock bound. Low likelihood. |
| F10 | RISK | `tools/congress-collector/senate_adapter.py:143-144` | Senate completeness is checked only as "numbers are contiguous from 1 to count". The menu has no independent total. A menu truncated at the tail (highest-numbered votes missing) is internally consistent. | The most recent Senate rolls could be silently absent while the run reports complete. House is protected by the listing's `of N Results` counter (`adapter.py:144-151`); Senate has no equivalent. Not determined whether live menus ever truncate; the lead should check the 2026 session menu count against an independent source if one is available. |
| F11 | RISK (snapshot) | `tools/congress-collector/house_discovery.py:74` | Session total is checked for change only within the same year's page crawl. Rolls added after a year's crawl (or after the Senate menu fetch) are not seen. The Oct-21 window's end date equals asOf, so the 2026 session is the live one. | Expected by design ("listing snapshot at retrieval"). Run `started_at`/`finished_at` and `fetched_at` are the only capture times. A roll that appears after capture is not in the run and not flagged. |
| F12 | INFO | `tools/congress-collector/acquire_window.py:60-66`; `skills/researcher/official-member-votes.ts:100-108` | `--fixture-map` produces `status: complete` with `reason: "fixture_mode: true ..."`. The TS loader does not read `reason`. | Not reachable with the lead's command. Verify `window-run.json` has `"reason": null`. |
| F13 | INFO | `tools/congress-collector/acquire_window.py:33-38`; `official-member-votes.ts:101-103, 170` | `--rolls-json` mode can write `status: complete` with `mode: rolls`, `window: null`. `loadWindowRun` accepts it; `normalizeMemberVotes` rejects it (`window_mismatch`). | Not used. Member-level consumers are protected. |
| F14 | INFO | `lib/vote-source.ts:38-43`; `skills/researcher/official-votes.ts:138-144` | `FROZEN_EVIDENCE_WINDOW`/`FROZEN_POLICY` are still 2026-09-26. They are not used by `loadWindowRun` (verified by grep: loader passes `run.window`). | Any future caller passing FROZEN_POLICY would reject this run's manifest. |
| F15 | INFO | `tools/congress-collector/house_discovery.py:69`, `:158` | `discovery-receipts.json` is an intermediate file. It is written before each check and is not the final receipt set (the last receipt is written without `range`/`total`). The authoritative receipt set is `discovery/inventory.json`. The TS loader does not read `discovery-receipts.json`. | Do not use it as evidence of completeness. |
| F16 | INFO | `tools/congress-collector/adapter.py:153-165`; `artifacts` frozen page check | House continuation parsing skips malformed `data-action` values (e.g. `...Session=2nd')`) by design. Checked against frozen `2022-page001.html` (clean `Page=2` present), and `2026-page032.html` (0 `aria-label="Next"`, last page). | Consistent with frozen pages. A markup change would fail loudly (`missing valid next-page continuation`). |

## Q1. Window

- `adapter.subtract_months('2026-10-21', 48)` returns `2022-10-21` (ran `python3 -I -B -c` with the adapter module only). `window_policy(('2022-10-21','2026-10-21'))` returns `{'as_of': '2026-10-21', 'months': 48}`.
- TS `subtractCalendarMonths` (`lib/vote-source.ts:186-208`) uses the same closed-form arithmetic (`year*12 + (month-1) - months`, day clamp to month end). By hand: 2026*12+9-48 = 24273 -> year 2022, month 10, day 21 -> `2022-10-21`. Not executed (no node run); the arithmetic is identical to the Python code, and the Python results for clamping (`2024-02-29` minus 12 gives `2023-02-28`) match the TS clamp logic.
- `acquire_window.py:41-42`: window is `(subtract_months(as_of,48), as_of)` and `run['months']=48` only when the window equals that span. `:56` rejects `--months != 48`.
- Manifest: `adapter.py:394` sets `window` and `window_policy` (`{as_of, months: 48}`); `senate_adapter.py:221` does the same for Senate. `official-member-votes.ts:33` requires `m.window == run.window` and `window_policy.as_of == run.as_of` and `months == 48`; `:102` requires `run.window == [coverageWindow(run.as_of).start, run.as_of]` and `months === 48`. `official-votes.ts:227-276` (`validateAcquisitionManifestChecked` window and window_policy block) requires `window_policy.as_of == window[1]` and, with `months: 48`, that `subtractCalendarMonths(window[1], 48) == window[0]`. All consistent.
- Inclusive bounds: Python `window[0] <= date <= window[1]` (`adapter.py:58`, `senate_adapter.py:184`); TS `inWindow` (`lib/vote-source.ts:246-263`) is inclusive by string compare. Consistent.

## Q2. Caps and sampling

- House: `execute` calls `adapter.acquire(inv, output, fetch)` with no `max_rolls` (`acquire_window.py:47`). `acquire` default `max_rolls=None` (`adapter.py:365`); `safety_cap_applied` starts False and only changes under a cap (`adapter.py:398-409`). Manifest records `max_rolls: null`, `safety_cap_applied: false` (`adapter.py:397-398`). CLI `--max-rolls` exists only in `adapter.main` (`adapter.py:503`), not in acquire_window.
- Senate: `sa.acquire_senate` -> `acquire_records` (`senate_adapter.py:212-249`) sets `max_rolls: None`, `safety_cap_applied: False` (`:221`) and has no cap branch.
- Discovery: House enumerates every page 1..ceil(total/10) per year (`house_discovery.py:64`), `summary.pages` is checked against the count (`adapter.py:223`, `official-member-votes.ts:72`). Senate reads every menu (`senate_adapter.py:154`).
- Silent drop checks: House `validate_inventory` requires claimed inventory rows to equal the parsed rows (`adapter.py:259-267`), requires roll count per session to equal `published_total` and unique (`adapter.py:250-251`), and `window_total` per session and overall (`:252-254`, `:279-280`). Senate requires `parsed == packet['inventory']` (`senate_adapter.py:185`). No path drops a parsed roll silently. Out-of-window rows are retained as `excluded_outside_window` and checked by the TS validator (`official-votes.ts:600-608`).
- Residual: F10 (Senate tail truncation undetectable).

## Q3. Failure visibility and retention

| case | listing/menu discovery | detail XML |
|---|---|---|
| HTTP 4xx/5xx | Body and receipt saved (`house_discovery.py:66-69`) before `checked_response` raises (`:70`). `status != 200` -> DiscoveryError. Failure visible. | Body and receipt saved (`adapter.py:421-426`). 404/410 -> `incomplete_fetch`; other non-200 -> `source_failure`. Visible. |
| timeout / DNS / connect error (URLError, socket.timeout before response) | No receipt. Raised out of `fetch_response`; `discover_house` converts to DiscoveryError (`:85-87`). (F6) | No response object. `source_failure` with reason (`adapter.py:417-418`). (F6) |
| read timeout / partial body (IncompleteRead, OSError during read) | Body (possibly empty) and receipt saved with `body_complete: false`, `read_error` (`house_discovery.py:21-27`). `checked_response` rejects. | Saved with `body_complete: false`; `incomplete_fetch` (`adapter.py:433-434`). |
| redirect (3xx) | NoRedirect (`adapter.py:457-459`); urllib raises HTTPError for 3xx, which is saved as the response with its status; not 200, so rejected. Final URL = requested URL. | 3xx status -> `source_failure` (`adapter.py:427-432`); final_url mismatch also `source_failure`. |
| unpublished detail (`roll-call-vote-not-available.htm`) | n/a | `incomplete_fetch` (`adapter.py:439-440`). Only checked when status is 200 and body complete; a 404 with that page is `incomplete_fetch` by status. |
| vacated marker (`This vote was vacated`) | n/a | `unsupported_record` (`adapter.py:437-438`). Not complete; visible. Exclusion authority is not implemented. |
| malformed XML / wrong identity / missing voter payload | n/a | `malformed_source` via `ET.ParseError`/`ValueError` (`adapter.py:443-445`). Visible. |
| byte cap (>5 MiB) | Rejected via `checked_response` length check (`house_discovery.py:51`). | `malformed_source` if complete; `incomplete_fetch` if truncated (`adapter.py:433-436`). |

- Failed receipts saved before raising: yes for every case where a response object exists (listing: `house_discovery.py:69` writes `discovery-receipts.json` before `checked_response` at `:70`; detail: body written at `adapter.py:421` and receipt at `:422-426` before outcome checks). Not for transport-level failures (F6).
- `window-run.json` written always? For any exception in the `execute` try tuple (`acquire_window.py:50-52`), yes, with `status: failed` and `reason`. Not for exceptions outside the tuple, nor for the mkdir FileExistsError at line 28 (F5).
- Automatic retry: none. Searched all acquisition code paths; `adapter.acquire` and `acquire_records` make exactly one attempt per roll.
- Exit codes: `acquire_window.main` returns 0 only when `status == 'complete'` (`:67`), 1 otherwise (`:67`, `:69`). Argparse errors exit 2. Uncaught exceptions exit 1 with traceback.

## Q4. Network bounds

- Allowlist checks:
  - House listing: `house_discovery.fetch_page.allow` (`house_discovery.py:39-47`) calls `adapter.listing_query`, which calls `source_url` (`adapter.py:113-118`): scheme https, netloc exactly `clerk.house.gov`, path `/Votes/MemberVotes`, no fragment; query keys exactly `{CongressNum, Session, Page}`, each once, congress/session consistent with year, Page positive integer.
  - House XML: `adapter.fetch_xml` (`:462-466`): `source_url` (scheme https, host `clerk.house.gov`, path check), then path must match `/evs/\d{4}/roll\d{3,}\.xml`, and no query string.
  - Senate menu: `senate_adapter.fetch_senate.allow` (`:112-113`): full regex `https://www\.senate\.gov/legislative/LIS/roll_call_lists/vote_menu_[1-9]\d*_[12]\.xml`.
  - Senate XML: same function, second alternative `roll_call_votes/vote{c}{s}/vote_{c}_{s}_{roll}.xml` with `\d{5,}`; canonical-URL check at `:114-116` (`source_url(...) == value`).
- Timeout: 30 s per socket operation (`adapter.py:470`; `house_discovery.py:17`; senate uses the same `fetch_response`).
- Byte cap: 5 MiB (`adapter.py:23`) via `read(MAX+1)`; over-cap body saved as prefix, marked incomplete (`adapter.py:483-484`).
- Redirects: refused via `NoRedirect` (`adapter.py:457-459`); 3xx handled as non-200.
- User-Agent: `CivicLens-source-acquisition/1.0` (`adapter.py:468`, `house_discovery.py:17`). Senate uses the same fetcher.
- Proxy: not disabled (F3). No cookie handler, no auth.
- Rate limiting or sleep: none (F7).

Estimated HTTP requests (no retries, so these are exact attempt counts if no failures):

- House listing pages: one per page per session 2022..2026. Frozen packet from 2026-10-04 (window 2022-09-26..2026-09-26): 249 pages, 2,466 published rolls. The new run re-fetches all pages, so expect about 249 to 253 (exact value = `discovery/inventory.json` receipts count; not determined before the run).
- House XML detail: one per in-window roll. Frozen Sept-26 window had 2,012 in-window rolls; the Oct-21 window will differ by the rolls at the two edges. Expect about 2,000 (exact = `window_total` in the inventory; not determined before the run).
- House total: about 2,250 to 2,260 requests, serial.
- Senate menus: 5 (2022, 2023, 2024, 2025, 2026).
- Senate detail XML: one per in-window roll. Not determined: the only frozen menu in the repo is 119-1 (2025), which lists 659 votes. Count = sum of `window_total` across the 5 menus.

## Q5. Current-day snapshot

- A roll dated 2026-10-21 that is listed but whose XML is not published yet: the detail response is either 404/410 (`adapter.py:429-430`, `incomplete_fetch`) or a 200 page containing `roll-call-vote-not-available.htm` (`:439-440`, `incomplete_fetch`). Either way the manifest is `incomplete`, `execute` sets run `incomplete` (`acquire_window.py:48`), CLI exits 1, and `loadWindowRun` throws `incomplete_run` (`official-member-votes.ts:101`). Visible, not silent. The run cannot be retried into the same dir (`exist_ok=False`), so a new output dir is needed.
- A session total that changes mid-crawl: `house_discovery.py:74` raises `session total changed mid-crawl`; run is `failed`. Visible. Shifts that keep the total equal are caught by the duplicate/missing roll check (`adapter.py:250-251`).
- Rolls appended after a session's crawl: not detected (F11). This is the snapshot semantics the scope accepts.
- A Senate roll added to the menu after fetch: not detected; a menu-listed roll whose XML is not yet published becomes `incomplete_fetch` (`senate_adapter.py:232-237`), visible.
- Net: the current-day case fails visibly, not as a silent complete. The one silent-complete gap on this axis is Senate tail truncation (F10).

## Q6. Python to TS contract compatibility

House, field by field (all consistent on the happy path):

- Run: `contract`, `contract_version`, `chamber`, `mode`, `as_of`, `window`, `months`, `status`, `manifest_path`, `manifest_sha256`, `discovery.{inventory_path, inventory_sha256, index_pages_verified}` are written by `acquire_window.py:30-52` and read by `official-member-votes.ts:100-104`, `:64`.
- Manifest top-level keys: all 22 required keys present in `adapter.py:392-401` (checked against `MANIFEST_KEYS` at `official-votes.ts:~100`).
- Manifest records: `adapter.py:383-391` and `:420-426` produce `key, chamber, congress, session, year, roll, date, status, url, page, index_receipt, source_url, in_window, attempted, attempted_at, outcome, reason, response, metadata`. All 19 required TS fields present. `response` keys (`url, final_url, http_status, content_type, path, sha256, bytes, body_complete, read_error, attempted_at, received_at`) match `official-votes.ts` checks at `:~600-620` and `official-member-votes.ts:47`.
- `metadata` (`adapter.py:347-352`): `key, chamber, congress, session, roll, date, legis_num, question, vote_type, result, vote_desc, amendment_num, amendment_author, recorded_vote_count, position_tokens`. TS `metadataTypeProblems` (`official-votes.ts:~180-215`) requires the same types; `legis_num` is `''` when absent (`:349`), a string, OK.
- Discovery packet: `adapter.py`/`house_discovery.py:81` writes `window, summary, receipts, inventory, window_total, claim`. TS `validateDiscovery` (`official-member-votes.ts:65-67`) requires `window` equal, `summary[].year` equal to expected years, `receipts.length === index_pages_verified`. Consistent.
- Listing receipts: `house_discovery.py:67-75` writes `url, status, path, sha256, bytes, final_url, content_type, body_complete, read_error, fetched_at, range, total`. TS `:75-76` requires `status === 200`, `sha256`, `fetched_at` parseable, `bytes`, `body_complete !== false`, `read_error` null/undefined, `final_url === url`. All present for successful pages.
- House listing regex: TS `official-member-votes.ts:79-80` (`^https://clerk\.house\.gov/Votes/MemberVotes\?CongressNum=(\d+)&Session=(1st|2nd)&Page=([1-9]\d*)$`, counter regex) matches `house_discovery.py:36` URL format and `adapter.py:144` counter regex byte-for-byte. Row regex `Roll Call Number:\s*<a href="\/Votes\/(\d{4})(\d+)[^"]*"[^>]*>(\d+)<\/a>` (TS :83) equals `adapter.py:168`. Date regex (TS `([A-Z][a-z]{2}) (\d{1,2}), (\d{4}),` vs Python `([A-Z][a-z]{2} \d{1,2}, \d{4}),`) equal. Status regex equal except F2.
- Verified against the frozen 2022-page001.html and 2026-page032.html: `Roll Call Number: <a href="/Votes/2026314?Page=2"` form matches; `pagination_info` counters `1 - 10 of 549`, `311 - 314 of 314` match.
- Listing `index_receipt` equality (TS `:95`): `receipt` object is the same dict written to the packet, so JSON round trip is equal.
- `verifyResponseBodies` (`official-votes.ts:936-979`) reads `responses/<name>` under `runDir/acquisition`; Python writes `responses/<year>-h<roll:05d>.body` relative to that dir (`adapter.py:420`). Path rules (no `..`, no leading `/`, no backslash) hold.

Senate, field by field:

- Run and manifest keys: same writer as House (`senate_adapter.py:221`, `window_policy`, `max_rolls: None`, `safety_cap_applied: False`). Consistent with `official-member-votes.ts:32-33`.
- Discovery receipts (`senate_adapter.py:157`): `url, status, final_url, content_type, path, sha256, bytes, body_complete, read_error, fetched_at`. TS `validateDiscovery` `:75-76` requires `status === 200`, `sha256`, `bytes`, `final_url === url`. All present. Filter by `r.url === vote_menu_{c}_{s}.xml` (TS `:71`) matches `menu_url` (`senate_adapter.py:106`).
- Menu summary: `senate_adapter.py:159` writes `{year, published_total, pages: 1, window_total}`. TS `:72` requires `pages === 1` and `published_total > 0`. Consistent.
- Menu regex (F1): see BLOCKING-1. Consistent on the one frozen menu (`senate-menu-119-1.xml`: `<congress>119</congress>`, `<session>1</session>`, `<congress_year>2025</congress_year>`, 659 `<vote>` with `<vote_number>00659</vote_number>` and `<vote_date>18-Dec</vote_date>`); not consistent for whitespace/case/attribute variants that Python accepts.
- Senate record `key`/`url`/`page`/`status`/`index_receipt`: `senate_adapter.py:184` and `:219` (`source_url`), `:217-220`. TS `canonical` (`official-member-votes.ts:23`) uses `parseRollKey` (`lib/vote-source.ts:77-113`), `key` format `{c}-{year}/s{roll}` matches. `r.url === r.source_url` and `r.page === 1` (TS `:95`) hold.
- Senate XML metadata (`senate_adapter.py:210`): `key, chamber, congress, session, roll, date, question, vote_title, result, document_type, document_number, document_congress, amendment_number, amendment_to_document_number, documents, recorded_vote_count, position_tokens`. TS `:50` requires the 8 string fields, all present as strings (`field()` or `''` default). `recorded_vote_count` equals the sum of `position_tokens` (both count distinct LIS ids, `senate_adapter.py:202-206`). Consistent.
- Senate `response` keys: `senate_adapter.py:230` matches TS `:47`.

Consumer-side: `loadWindowRun` calls `validateCompleteManifest` for both chambers, `validateDiscovery` for window mode, and `validateAcquisitionManifest` plus `verifyResponseBodies` for House only (`official-member-votes.ts:55-59`). Senate has no shared-validator call; its checks are the TS-only ones above. This is not a mismatch, but it means Senate `outcome` values (e.g. `ambiguity`, `validate_senate_xml` returns `SenateError.outcome = 'ambiguity'`) are not in the TS `ACQUISITION_OUTCOMES` list (`official-votes.ts:31-39`). A Senate ambiguity makes the run incomplete (`senate_adapter.py:244`) and the loader rejects on `r.outcome !== 'acquired'` (`official-member-votes.ts:44`), so this does not produce a false complete.

## Q7. Output directory safety

- `acquire_window.py:25-28`: `absolute()`, refuses symlink on the output path or any parent (`is_symlink`), then `mkdir(parents=True, exist_ok=False)`. A pre-existing output dir raises FileExistsError (not caught by the in-try handler, see F5). No output reuse.
- Discovery: `house_discovery.py:57-59` and `senate_adapter.py:150-152` repeat the symlink check and `exist_ok=False` for `output/discovery`.
- Acquisition: `adapter.py:375-381` refuses an output inside the discovery directory and symlinks; `senate_adapter.py:248` refuses output inside the discovery directory. `(output/'responses').mkdir()` (`adapter.py:382`) without `parents`.
- Writes: `window-run.json`, `discovery/*`, `acquisition/*` only, all under `--output`. `write_manifest` writes `manifest.tmp` then `replace` (`adapter.py:355-358`), so manifest updates are atomic within the output dir. No writes outside output found.
- Caveat: unlike `adapter.main` (`adapter.py:515-517`), `acquire_window.py` does not restrict `--output` to `artifacts/official-house-acquisition/`. Any path that does not exist yet is accepted. Not a leak, but the lead must choose the path (F4).
- Symlink check is a check-then-create; not race-proof. Low concern for this run.

## Q8. Anything else that could present a capped, sampled, malformed, or synthetic run as complete

- F12: `--fixture-map` complete runs carry `reason` but are accepted by the loader. Not reachable with the lead's command.
- F13: `--rolls-json` complete runs with window null; not reachable by member consumers.
- F10: Senate tail truncation is undetectable by the Senate checks.
- F11: snapshot semantics; roll added after capture is not in the run.
- The House/Senate `status` rule (`execute`, `acquire_window.py:48`) requires `required_rolls > 0` and `acquisition_complete`. An all-excluded run is incomplete (`official-votes.ts:~740` "no required rolls"; `official-member-votes.ts:30`). Not a false complete.
- No code path converts `incomplete_fetch`, `unsupported_record`, `malformed_source`, `source_failure`, or `ambiguity` into a complete record. Verified in `adapter.py:427-447`, `senate_adapter.py:231-242`, and the TS outcome requirement at `official-member-votes.ts:44`.

## What the lead should verify after acquisition

1. Command and environment: both runs used absolute paths for the script and `--output`; environment had no `*_proxy` variables (`env | grep -i proxy` empty inside the run env); cwd/HOME/TMPDIR were the fresh /tmp dir, not the worktree.
2. `window-run.json` for each chamber: `status: "complete"`, `mode: "window"`, `as_of: "2026-10-21"`, `window: ["2022-10-21","2026-10-21"]`, `months: 48`, `reason: null`, `manifest_sha256` present; exit code 0.
3. `acquisition/manifest.json`: `status: "acquisition_complete"`, `max_rolls: null`, `safety_cap_applied: false`, `normalized_votes_validated`/`member_coverage_validated`/`bill_resolution_validated` all false, `collector_revision: null`, `window_policy: {"as_of":"2026-10-21","months":48}`, `counts` has no `incomplete_fetch`, `source_failure`, `malformed_source`, `unsupported_record`, `ambiguity`, or `pending`; `attempted_rolls == required_rolls` plus out-of-window rows not attempted.
4. Count sanity: House `discovery/*.html` count equals the sum of per-session `ceil(published_total/10)`; `inventory.json` `window_total` equals House `required_rolls`; House `responses/` file count equals `required_rolls`. Senate `discovery/*-menu.xml` count is 5; Senate `responses/` count equals `required_rolls`.
5. Hash spot checks: sha256 of 5 random `acquisition/responses/*` files match the manifest `response.sha256`; sha256 of `discovery/inventory.json` equals `window-run.json` `discovery.inventory_sha256`.
6. Vacated / unpublished check: `grep -l "This vote was vacated\|roll-call-vote-not-available" acquisition/responses/*` should match nothing among `acquired` records (they would be non-acquired outcomes, which must be zero).
7. Senate menu format (F1): `grep -c "<vote_date> \|<vote_number> \|<vote_date>[^<]*[a-z][A-Z]" discovery/*-menu.xml` should be 0, and each menu's `<congress>`/`<session>`/`<congress_year>` should appear exactly once. If not, expect the loader to reject; fix the TS regexes to the Python `field()` semantics rather than the Python code.
8. Senate tail (F10): compare each Senate session's max `vote_number` to an independent count (e.g. the menu's own `vote` count, or the Senate published total if accessible) before treating the Senate run as complete.
9. Current-day rolls: list in-window rolls dated 2026-10-21 (or the last 3 days) in the manifest and record their `fetched_at`/`attempted_at`; treat any later-published roll as outside this snapshot.
10. Loader: run `loadWindowRun` on each run dir before any normalization; it must return without `OfficialVoteFailure`. Do not use `FROZEN_POLICY` (F14).
11. No writes outside the run dirs: `git -C <worktree> status --short` shows only the new run dirs and `workers/`; no change to `artifacts/` existing evidence (hash the existing published artifacts before and after).
