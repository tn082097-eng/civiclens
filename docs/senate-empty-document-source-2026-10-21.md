# Senate empty-document source proof — 2026-10-21

This record freezes a real procedural-vote response from the completed Senate
acquisition. The first full offline replay failed downstream and remains preserved.
The controller subsequently verified the generic TypeScript repair with the
complete captured window offline. This is not certification.

## Exact captured source

- Canonical key: `118-2024/s140`, congress 118, session 2, date `2024-04-17`.
- Official request and effective URL:
  `https://www.senate.gov/legislative/LIS/roll_call_votes/vote1182/vote_118_2_00140.xml`.
- HTTP 200, content type `text/xml`, complete body, no read error.
- Attempted: `2026-10-21T23:44:28.987159+00:00`.
- Received: `2026-10-21T23:44:29.119654+00:00`.
- Body: 27,960 bytes; SHA-256
  `2ea755a07b4d9115619b17f4bd6d0e1af76032f6441dcde95b4c91aff6f99439`.
- Original acquisition run: `artifacts/full-window-validation-2026-10-21/senate-20261021T234205Z-52dfcac8/`.
- Original retained body: `acquisition/responses/2024-s00140.body` within that run.
- Original acquisition manifest SHA-256:
  `e05e0c84cad53a25af2ce56a6070addf6b78f74877ff527b471b56208d4e6acc`.
- Frozen XML: `fixtures/votes/official-samples/senate-procedural-2024-roll140.xml`.
- Frozen receipt: `fixtures/votes/official-samples/senate-procedural-2024-roll140.receipt.json`;
  SHA-256 `afae9a047fd533c65515e342155a8193998f7590bd31b17402a6d5b42c1d5f30`.

The XML fixture is an exact byte copy of the retained HTTP body, checked against
its original receipt length and SHA-256. The receipt sidecar contains the
complete original acquisition record unchanged, including response and index
receipts, plus its source run path and acquisition-manifest digest. Extracting
that record does not create a new HTTP receipt or alter its timestamps.
No network request was made to obtain this fixture.

The official XML has no `document` elements and no `amendment` elements. Its
question is `On the Motion to Adjourn`; its title is
`Motion to Adjourn the Court of Impeachment Sine Die`. The vote has 100 recorded
members, with 51 `Yea` and 49 `Nay`. This source supplies no document/bill identity.
The question/title are retained context, not permission to infer a bill.

## Acquisition passed; the first offline replay failed

The original acquisition manifest records `acquisition_complete` for the frozen
48-month window `2022-10-21` through `2026-10-21`: 1,675 required rolls acquired,
all with complete HTTP 200 response receipts, and 352 published rolls excluded
outside the window. Acquisition-only normalization, member-coverage and
bill-resolution flags remain false. No acquisition revalidation derivative is
needed for this repair because the original acquisition already passed.
Preserve the original manifest, response bodies and receipts unchanged.

The first full offline replay is retained at
`artifacts/full-window-validation-2026-10-21/checks/senate-offline-replay-1/`.
Its `summary.json` records `verdict: fail`, zero bridge failures and twelve
analysis failures. Its `census.json` identifies exactly `118-2024/s129` through
`118-2024/s140`, each with `collector/cross_check_mismatch` and message
`official votes collector/cross_check_mismatch: bundle first document mismatch`.

The captured bridge results for all twelve affected rolls have `ok: true`,
`raw.documents: []`, and this explicit six-field `raw.document` projection:

```json
{
  "document_congress": "",
  "document_type": "",
  "document_number": "",
  "document_name": "",
  "amendment_number": "",
  "amendment_to_document_number": ""
}
```

The first replay's target states for `S000033` and `W000817` both record failed
normalization with the same mismatch, `votesCount: 0`, and persistence
`status: not_run` (`totalVotesRows` and `perMember` are null). The census's 1,663
present rolls per target do not turn those failed target states into success.
Keep this first failed replay as evidence; do not rewrite or relabel it as a pass.

## Generic compatibility and controller verification

The controller diagnosed `classifyRoll` as requiring a nonempty `documents`
array whenever that array is present, incorrectly rejecting the supported
no-source-document shape. The generic fix accepts `documents: []`
only when `raw.document` has exactly the six named fields above, each explicitly
the empty string. Missing fields, non-string values, whitespace-only strings,
nonempty fields or contradictory document identity must not use this exception.
Nonempty document bundles retain their existing first-document consistency and
ambiguity checks. This is not a member-, roll- or date-specific exception.

Accepting this empty representation establishes structural consistency only.
With no source document identity, the classifier remains `unsupported_record`
with a null bill. Do not infer a bill or turn this procedural title into an
authoritative bill/non-bill classification merely to pass the replay.

The controller implemented the fix in `skills/researcher/official-member-votes.ts`
and added regression controls in its test. The original RED failure is retained;
all 19 member-vote tests passed after repair. The expanded frozen-fixture
interoperability control also includes this exact XML and the historic House XML.
The final vote-path TypeScript suite passed 359/359, and typecheck passed.

The completed full offline replay is
`artifacts/full-window-validation-2026-10-21/checks/senate-offline-replay-2/summary.json`:

- 1,675 required rolls, zero bridge failures and zero analysis failures.
- `S000033` and `W000817`: 1,675 votes planned, applied and persisted each;
  3,350 rows in the new isolated validation DB.
- The first member's row snapshot is unchanged after loading the second.
- 708 `resolved_bill`, 954 `authoritative_non_bill`, 12 `unsupported_record`
  and one `ambiguity` (`118-2024/s128`, official/pinned bill-identity disagreement).
  Unresolved/ambiguous rows retain a null bill and are not claimed as bill matches.
- The original acquired source manifest and failed first replay remain unchanged;
  no new HTTP acquisition or derived acquisition manifest was needed.

Final replay SHA-256:
`54d3599a29ab7f84b03f04f2a64ebbe90bc391ec981fa78c361ec4650d707da6`.

An independent Claude Opus review of this distinct repair is recorded separately;
its verdict and controller disposition are in the final validation report. These
checks cover the frozen window and two target senators, not all-member behavior,
the six-stratum gate or release readiness.
