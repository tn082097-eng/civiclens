# Stratum 1 result — Jerry Moran

## Frozen identity and environment

- Stratum: senator with at least one PTR in the frozen EFDS response.
- Member: Jerry Moran (`jerry-moran`, `M000934`, Kansas, Senate).
- Trial revision: `cfc0b41`.
- Disposable checkout: `civiclens-track-b-trials/s1-jerry-moran`.
- Source database SHA-256: `a766c8917a0e6b42ddc488758eb0b1a66abb37d24c873a74b4cc9d6fd7e4a38b`.
- Trial started from an exact copy of that database and the frozen current-legislators YAML. The cache root contained no disclosure data before the run.
- No production write, OCR, district load, OpenSecrets load, confirmatory runner, push, render publication, or deployment occurred.
- The external vault regenerator was made unavailable only inside the disposable checkout and restored immediately after the pipeline command. No vault file was written.

## Step statuses

| Step | Status | Evidence |
|---|---|---|
| Pre-state baseline | `ok` | 80.3% vote-to-bill linkage; all core tables present |
| Append and pipeline | `ok` | Final reviewer approved task `task-1788902754004-ba2849fd` |
| Sponsored legislation | `ok` | 788 fetched; 484 structurally valid rows upserted; 484 policy areas |
| Cosponsored legislation | `ok` | 3,850 fetched; 3,498 inserted; 352 duplicate/skipped |
| Member bill linkage | `ok` | 598 regex links plus 123 GovTrack resolutions; 9 summaries fetched |
| Senate PTR fetch/load | `ok` | Seven indexed filings; 64 source rows; 64 loaded; zero unmatched |
| FEC independent expenditures, 2024 | `verified-empty` | One member-cycle queried; zero aggregates; zero errors |
| OpenSecrets | `not-collected` | Optional source deliberately omitted by protocol |
| Timing-safe detectors | `ok` | One permitted detector ran; zero hits is a valid result; parked timing pair excluded |
| Theme gaps | `ok` | 34 theme-mappable trades; 15 receipts; artifact written |
| Artifact corpus | `ok` | Seven required agent artifacts present and schema-valid, 1/1 each |
| Post-state baseline | `ok` | 79.7% vote-to-bill linkage; all core tables present |
| Full tests and TypeScript | `ok` | 277/277 tests; `tsc --noEmit` clean |
| Selected-member render | `ok` | Two renders had identical normalized and raw bytes |
| Reference-member render | `ok` | Only expected Jerry Moran peer row added to Josh Gottheimer page |
| Database delta | `ok` | No non-target additions, removals, or rewrites in member-scoped tables |

## Disclosure reconciliation

The live EFDS search reproduced the seven frozen filing IDs. A fresh authenticated
source-page fetch counted date-bearing transaction-table rows independently of
the cached parser output. Every filing count matched. For each filing, the first
and last source rows were compared with the normalized JSON for transaction date,
owner, ticker, asset, asset type, transaction type, and amount.

| Filing ID | Source rows | Loaded rows | First row | Last row |
|---|---:|---:|---|---|
| `b08cdf32-a5e7-4767-97b1-20c8750638ca` | 45 | 45 | 2023-12-14, VZ, Verizon Communications Inc. Common Stock, sale, $1,001-$15,000 | 2023-12-14, GOOG, Alphabet Cl C, sale, $1,001-$15,000 |
| `bef47efb-e0e5-47b1-ac7b-80dae682a8c7` | 4 | 4 | 2024-07-29, BRK.B, Berkshire Hathaway Cl B, partial sale, $1,001-$15,000 | same asset/type, $15,001-$50,000 |
| `e37322e3-0829-4e3c-9faf-7a4a1a957e09` | 1 | 1 | 2024-12-16, BRK.B, Berkshire Hathaway Cl B, purchase, $1,001-$15,000 | same row |
| `56ecce5e-12a2-43db-916c-52cd3ba3a375` | 4 | 4 | 2025-05-08, GOOG, Alphabet Cl C, purchase, $1,001-$15,000 | same asset/type/band |
| `b83b6502-520b-4403-9777-60f6c2d93bc1` | 3 | 3 | 2025-09-23, GOOG, Alphabet Cl C, partial sale, $1,001-$15,000 | same asset/type/band |
| `7caf1b69-3678-4420-8812-a1476a1a6158` | 5 | 5 | 2026-05-27, BRK.B, Berkshire Hathaway Inc. New Common Stock, purchase, $1,001-$15,000 | same asset/type/band |
| `cff197e2-b90b-4b53-b97d-eecf226a1980` | 2 | 2 | 2026-06-23, GOOG, Alphabet Inc. - Class C Capital Stock, purchase, $1,001-$15,000 | 2026-06-23, BRK.B, Berkshire Hathaway Inc. New Common Stock, purchase, $15,001-$50,000 |

Total: 64 source rows / 64 extracted rows / 64 loaded rows. The loaded member
has seven filings, zero invalid transaction rows, and zero duplicate
`(filing_id, tx_index)` keys.

## Scoped database result

The candidate database contains one new member, 1,700 votes, 4,008 bills, 100
donors, 64 transactions, and one pipeline-run record. Shared dimensions changed
only where the target's authoritative sponsor/bill/committee data required it.
For `members`, `votes`, `bills`, `donors`, `pfd_transactions`, and
`pattern_hits`, set differences outside `jerry-moran` were all zero in both
directions.

The fixed Josh Gottheimer reference render differed only by one peer-table row:
Jerry Moran, one shared donor, $31.9K. This is an expected corpus-membership
effect, not an unrelated mutation.

Normalized selected-member render SHA-256, both runs:
`f9b8cd37605d71a0a14d467bf19de30377916ae38e4945614aee5c3f70728896`.

## Runtime artifact hashes

- Researcher: `c8a505c6d7ebd5501ee2fe35feaa1de788d545e706b45b8df8d271af515f3ea3`
- Data checker: `1006455440490d348bbe3d01127b9940476bc86e126b0ad9b1174ab335e1ae71`
- Predictor: `596db0811d926f8ee7f4d1717c48a53aa54e0ec83a69df7e842bd823b6ea83d0`
- Trade analyst: `cbe28a90711eaf5c36df4ffa3c9183a73164139d848742745ddf33c9e6a440d2`
- Summarizer: `41aceea5061f408a5b952b3b1dde0e234324ecf38a4d315c8ed0f5e313b92b8b`
- Code checker: `cbd7c18ceada063a4b3c53226152c2465cbf805613288775df8aa2241e833d42`
- Final review: `d79ae0117094f25a7350a2e408754b635392852f16820af4e144e7d1471301d6`
- Final trial database: `1ac1c5e19420d9d2229a18c67b4b20b996cccdad1ce79f5e057dfde4f1405ff0`

## Disposition

Stratum 1 closes `ok`, subject to the required final-code replay after all
strata and any generic fixes are complete.
