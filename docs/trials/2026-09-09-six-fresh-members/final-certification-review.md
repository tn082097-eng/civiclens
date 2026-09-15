# Final six-fresh-member certification review

**Verdict: PENDING.** Chris Van Hollen passed a fresh replay at repair commit
`20f62c0`, but the formatting-hold rule changes the certification contract
after that replay. A new final implementation commit must be frozen and all six
strata replayed there. Eric Burlison is explicitly held for manual formatting;
his initial withholding cannot be counted as a pass.

## Stratum verdicts

| Stratum | Member | Final verdict | Decisive evidence |
|---|---|---|---|
| 1 - Senate with PTRs | Tina Smith | new final-code replay pending | initial run: 9 indexed filings, 20 transactions, complete local page |
| 2 - House with zero indexed PTRs | John W. Mannion | new final-code replay pending | initial run: four authoritative index years each recorded `verified-empty` |
| 3 - high-volume text House PTR | Cleo Fields | new final-code replay pending | initial run: all 21 filings and 233 visible rows reconciled without OCR |
| 4 - Senate with zero PTRs | Chris Van Hollen | historical pass at `20f62c0`; new final-code replay pending | source-backed zero PTR; required artifacts complete; 6,912 cosponsorships fetched completely |
| 5 - frozen source without FEC ID | Darline Graham | new final-code replay pending | initial run: normal fallback resolved the ID; zero PTR receipt and FEC result recorded |
| 6 - scanned House PTR | Eric Burlison | `needs_manual_formatting`; held, not passed | official PDF had no usable native text; OCR remained prohibited and the filing is explicitly withheld |

## Repair accounting

Three generic repairs were needed during the bounded trial:

- `bfce77f` made House filing matching use the filing-year district.
- `952530f` made successful zero-result Senate PTR searches durable and
  distinguishable from incomplete searches.
- `20f62c0` made exhausted required-agent failures and incomplete
  cosponsorship fetches fail nonzero, and prohibited a required artifact family
  from reporting an unexplained `0/0 PASS`.

Chris Van Hollen's first failure remains in the record. Attempt 2 used a newly
created scratch worktree and a fresh copy of the same frozen source database.
The source database retained SHA-256
`a766c8917a0e6b42ddc488758eb0b1a66abb37d24c873a74b4cc9d6fd7e4a38b`.
A row-level symmetric comparison found no changes to another member's rows.
All seven Chris artifact families were present and schema-valid; 313/313 tests
and TypeScript passed. Chris's attempt-2 page rendered twice identically after
removing the generated timestamp. This establishes determinism within attempt
2; its stamp-stripped hash is not compared with attempt 1's differently
recorded raw hash.

## Acceptance checks

- All six people were selected deterministically from frozen evidence and were
  untouched by prior development trials.
- Every ingestion step ended as `ok`, `verified-empty`, `not-collected`,
  `withheld`, or `failed`; no silent missing result was accepted. A `withheld`
  formatting outcome is accounted for but is not a pass.
- The only failed stratum used exactly one focused generic repair cycle and a
  fresh replay of the same frozen candidate.
- House text-layer PTRs were source-row reconciled. The scanned-PTR stratum ran
  no OCR and is held in the durable formatting queue.
- OpenSecrets remained optional and was consistently recorded
  `not-collected`.
- Routine pattern generation excluded the parked confirmatory timing pair. No
  confirmatory analysis was consumed.
- Every selected-member page rendered deterministically twice.
- No production database write, merge, push, publication, or deployment was
  part of Track B certification.

## Boundaries and residual limitations

This six-person trial is strong coverage evidence, not mathematical proof that
every member or future source layout will succeed. A scanned House PTR still
requires explicit withholding until a separately certified OCR or human-review
path exists. External APIs and the summarizer can still be unavailable; the
certified behavior is now to fail closed rather than silently publish an
incomplete run. A fixed control page is not generally byte-stable when global
peer tables change, so cross-member safety must use database isolation plus
semantic same-input render triage.

## Closeout boundary

Track B certification is not complete until a new final implementation commit
is frozen, all six strata replay there, Eric's formatting hold is cleared, and
this draft is reconciled against their evidence. Integrating the eventual
certified branch, pushing it, changing production data, adding a
member to the public roster, publishing, and deploying remain separate
decisions requiring their own review and authorization.
