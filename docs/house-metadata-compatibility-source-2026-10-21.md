# House metadata compatibility source proof — 2026-10-21

The controller locally integrated this source-backed Python repair after the
original HTTP capture finished. At validation time the repair was an uncommitted change to the active candidate;
it is not the original capture implementation. Later commit/PR packaging does not
change the recorded source-capture candidate. A receipt-preserving
offline derivative and a strict House replay now exist. Their results and the
corrected derivation proof are distinguished below. None is certification.

## Captured official source

- Roll: `118-2023/h700`, action date `2023-12-06`, congress 118, session `1st`.
- Official URL and effective URL: `https://clerk.house.gov/evs/2023/roll700.xml`.
- HTTP 200, `application/xml; charset=UTF-8`, complete body, no read error.
- Attempt: `2026-10-21T23:31:05.688605+00:00`.
- Received: `2026-10-21T23:31:05.827418+00:00`.
- Body: 95,657 bytes, SHA-256
  `c53ffef161351875dfa2e8ba69c17b718fb35f0fd2d8606168b8e9ba1589eea9`.
- Packet: `artifacts/full-window-validation-2026-10-21/checks/house-format-repair-packet/`.
- Packet receipt: `source-receipt.json`, SHA-256
  `cee6acc6d0081272a0de407e053df16954151eb8ab2cc0997f9634aa4227bf6c`.
- Packet XML: `official-house-2023-roll700.xml`.
- Retained response:
  `artifacts/full-window-validation-2026-10-21/house-20261021T232934Z-79090ba9/acquisition/responses/2023-h00700.body`.
- The packet XML and retained body were compared byte for byte and their length
  and SHA-256 checked against the packet receipt. That comparison required no
  additional live fetch.
- Original capture candidate identified by the source packet and controller
  preflight: `e3eb78956c36f1a4a275a8907d2f01f10f2ce6ba`. This identifies the
  original implementation, not the locally repaired candidate. The original
  acquisition manifest has `collector_revision: null`; that field does not
  establish the candidate revision. No new repair commit is asserted here.

The real XML contains one `vote-metadata/committee` with literal text
`U.S. House of Representatives` and no `vote-metadata/chamber`. It has 439
recorded votes, with raw positions `Aye: 202`, `No: 213`, `Not Voting: 24`.
The original receipt reports `malformed_source`, reason
`missing/duplicate/structured chamber`, and null metadata. Preserve it unchanged.

## Local repair and original capture

The shared helper accepts the three explicit plain/exact label combinations
specified in the shared contract. It rejects padded text and attributes under
the literal/plain rule. It never edits or relabels source XML and has no
member-specific, roll-specific or historical-date exception. The controller
integrated the helper and the acquisition/raw-extraction call sites into active
Python source locally before the validation run and subsequent commit/PR packaging.

The original run is
`artifacts/full-window-validation-2026-10-21/house-20261021T232934Z-79090ba9/`.
Its capture finished `incomplete` under the original validator. All 1,989 required
responses were HTTP 200 with complete bodies: 1,366 were `acquired`, 623 were
`malformed_source`, and another 477 published rolls were `excluded_outside_window`.
The 623 failures reported `missing/duplicate/structured chamber`; their later
acceptance by the strict shared helper supports the historic missing-`chamber`,
explicit-House-`committee` diagnosis. The original failed outcomes remain facts
about that execution and must not be rewritten as an original capture pass.

`artifacts/full-window-validation-2026-10-21/checks/original-capture-frozen.json`
records the immutable originals:

- Original `window-run.json` SHA-256:
  `c33b64dfecb778670f2d5845c50abbfda7b0012fa8fda1f066d93674cfa47b0a`.
- Original `acquisition/manifest.json` SHA-256:
  `755f1f8923fadffdf05e78ece7a60a1b85b02c1e7101f28210294ed17c1665c6`.

The original receipts, response bodies, capture timestamps and incomplete
manifests remain preserved. This preservation does not imply active Python
source was unchanged: the local repair changed it after capture.

## Existing offline derivative and strict replay

`artifacts/full-window-validation-2026-10-21/house-revalidated-committee-1/`
contains an existing offline derivative, including `revalidation.json` and
`acquisition/manifest.json`. Its revalidation record reports no new HTTP requests
and preservation of original receipts and timestamps. It records the derived
manifest SHA-256 as
`6d6d4d44359597c0f54c3aa061d5c3e3099cb3c59cc32355a5aa2efbba1aa99f`.
This is offline revalidation of retained HTTP evidence with repaired logic,
not a new HTTP acquisition or a change to the original failed manifest.

The existing strict replay summary at
`artifacts/full-window-validation-2026-10-21/checks/house-offline-replay-1/summary.json`
records `verdict: pass` for the full 48-month House roll window
`2022-10-21` through `2026-10-21`, bounded to targets `H001047` and `A000370`:

- 1,989 required rolls, zero bridge failures and zero analysis failures.
- 1,989 planned, applied, recorded and persisted rows per target; 3,978 rows in
  the isolated validation DB in total.
- Roll-resolution outcomes: 1,944 `resolved_bill`, 20 `authoritative_non_bill`
  and 25 `unsupported_record`. Unsupported records remain explicit outcomes.
- Four `outOfServiceListings`, retained as evidence-only listings.

These are results recorded by the existing replay, not a new execution by this
documentation sidecar. The replay used the isolated pinned parser; its summary
records a loopback-only namespace and disabled inference/download helpers.
Initial stdlib-only workbench limitations describe the preparation stage and
must not be presented as the final active state.

## Corrected derivation proof and evidence limits

The one independent Claude Opus review returned `REQUEST_CHANGES` on the first
derivative's documentation and provenance. Those historical records are retained.
The controller addressed all three findings and saved its disposition in
`checks/controller-review-disposition.json`; no second reviewer approval is claimed.

The replacement `house-revalidated-committee-2` now records original manifest/run
hashes inside both derived documents, separate revalidation timestamps and original
capture intervals, plus each revalidated row's original outcome, reason and metadata.
The 1,366 previously acquired rows have no metadata changes. `revalidation.json`
hashes the actual provenance utility as well as collector Python files. Its
`original_candidate` is null because the original manifest did not record a revision;
controller preflight separately records the original base commit.

The strict replacement replay `checks/house-offline-replay-2/summary.json` passed.
It verifies derivation links, current logic hashes and original capture hashes and
includes the proof's SHA-256 among its `runFiles`. A deliberately altered proof was
rejected before DB creation. All 16 provenance controls pass; their missing-field
RED evidence is retained. The replacement full replay reproduces the counts above.

Final SHA-256 records (paths relative to the validation artifact directory):

- `house-revalidated-committee-2/window-run.json`: `992a63d56361280a8f180b12675b645002dffc8f8d8706eac79c721dd9a98c1f`.
- `house-revalidated-committee-2/acquisition/manifest.json`: `c35d0885155c08156f1da9f7bcc9535567de3b832626b260a2a4ab115db7f78a`.
- `house-revalidated-committee-2/revalidation.json`: `f317eed520eacb434158ec205fca9675e88ef8b2f83f36442f52e5bf1eeb6d8e`.
- `checks/house-offline-replay-2/summary.json`: `a2446d86b3fca92c35f95cb9834554b8002af53d0e8827c7e6805e078ea76de3`.

The real historic XML was exercised unchanged; additional label, identity, voter
and totals mutations are explicitly SYNTHETIC test inputs. Those tests do not
become acquisition evidence. The strict replay covers the complete roll window
for two targets, not House-wide member coverage. Acquisition manifest flags
`member_coverage_validated` and `bill_resolution_validated` remain false. Neither
the local repair, the derivative nor the two-target replay establishes
certification, the six-stratum gate, publication or deployment readiness.

Final-candidate cross-check: after the separate Senate-only TypeScript consistency
repair, `checks/house-offline-replay-3/summary.json` reproduced the full House pass,
all counts above and reference-member invariance. This is the final House result
used by the combined validation report; replay2 remains the provenance-fix check.
SHA-256: `88b4d11ab6ffe8663fdd1c7975826b2b8b3d19067794318e7598840c562088e2`.
