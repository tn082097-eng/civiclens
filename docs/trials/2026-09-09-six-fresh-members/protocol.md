# Six-fresh-member Track B certification

**Status:** selection in progress. Local scratch execution only. Production
database writes, push, publication, deployment, OCR, and confirmatory timing
runs remain prohibited.

This is the six-stratum certification run requested after the separate Carol
D. Miller one-member smoke. Every selected person must be untouched: the
source roster, all people exposed by the 2026-09-08 development trial, Guy
Reschenthaler, and Carol D. Miller are excluded through the tracked
`excluded-names.txt`. A rerun of any excluded person is regression evidence,
not fresh certification evidence.

## Frozen source frame

- Cutoff: **2026-09-08T21:10:00Z**, unchanged from the original frozen Clerk,
  EFDS, legislator, roster, and source-database inputs.
- Candidate preparation code includes filing-year-aware historical House
  district matching (`bfce77f`), so redistricting cannot hide indexed PTRs or
  attach a filing based on a district held only in another year.
- Senate execution includes durable target/range-specific search receipts and
  pre-write unresolved checks (`952530f`).
- New seed: `civiclens-track-b-2026-09-09-v2`.
- Ranking remains lowercase
  `HMAC-SHA256(seed, stratum_id || bioguide)`, with no separator and bioguide as
  final tiebreaker.
- Assignment order remains `1, 2, 6, 3, 4, 5`, with selected people removed
  globally.

The six strata and all acceptance/stop rules remain those in the reviewed
2026-09-08 protocol. Dynamic Senate-count and House native-text probes are
performed in deterministic rank order. Every rejected higher-ranked candidate
is retained in the final selection manifest. House probes use only
`pdftotext -layout`; OCR is forbidden.

## Frozen selections

| Stratum | Member | Bioguide | Rank | Frozen evidence |
|---|---|---|---:|---|
| 1 — Senate with PTRs | Tina Smith | S001203 | 1 | EFDS: 9 PTRs |
| 2 — House with zero indexed PTRs | John W. Mannion | M001231 | 1 | Clerk indexes: 0 type-P filings |
| 6 — scanned House PTR | Eric Burlison | B001316 | 8 | DocID 8219414: no native text; no OCR |
| 3 — high-volume text House PTR | Cleo Fields | F000110 | 1 | 10 PTRs in 2025; DocID 20027855 has native table text |
| 4 — Senate with zero PTRs | Chris Van Hollen | V000128 | 3 | EFDS: 0 PTRs, successful search receipt |
| 5 — no FEC candidate ID | Darline Graham | G000608 | 1 | frozen YAML: empty `id.fec` |

The manifest records every higher-ranked rejection: seven text-layer House
filings before Eric Burlison, plus John Boozman's 62 and John Fetterman's 22
Senate PTRs before Chris Van Hollen. The source hashes are frozen in
`inputs.sha256` and `dynamic-source-files.sha256`.
