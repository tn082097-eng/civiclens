# Stratum 2 result — Paul Tonko

## Frozen identity and environment

- Stratum: House member with zero type-P filings in every frozen Clerk index.
- Member: Paul Tonko (`paul-tonko`, `T000469`, New York, House).
- Trial revision: `54e47a6`.
- Disposable checkout: `civiclens-track-b-trials/s2-paul-tonko-replay`.
- Source database SHA-256: `a766c8917a0e6b42ddc488758eb0b1a66abb37d24c873a74b4cc9d6fd7e4a38b`.
- Trial started from an exact copy of that database, the frozen current-legislators
  YAML, and the four frozen House indexes. The disclosure year directories were
  otherwise empty.
- No production write, OCR, district load, OpenSecrets load, confirmatory runner,
  push, render publication, or deployment occurred.
- The external vault regenerator was unavailable only inside the disposable
  checkout and was restored immediately after the pipeline command. No vault
  file was written.

## Step statuses

| Step | Status | Evidence |
|---|---|---|
| Pre-state baseline | `ok` | 80.3% vote-to-bill linkage; all core tables present |
| Append and pipeline | `ok` | Final reviewer approved task `task-1788914255706-ec6a9c9f` |
| Sponsored legislation | `ok` | 220 fetched; 196 structurally valid rows upserted; 196 policy areas |
| Cosponsored legislation | `ok` | 4,697 fetched; 4,696 inserted; one duplicate/skipped |
| Member bill linkage | `ok` | 1,269 regex links plus 685 GovTrack resolutions; 28 summaries fetched |
| House PTR load, 2023–2026 | `verified-empty` | Each year independently proved zero from the frozen Clerk indexes; DB unchanged |
| FEC independent expenditures, 2024 | `ok` | One member-cycle queried; one with IE; zero errors |
| OpenSecrets | `not-collected` | Optional source deliberately omitted by protocol |
| Timing-safe detectors | `ok` | One permitted detector ran; zero hits is valid; parked timing pair excluded |
| Theme gaps | `verified-empty` | Zero disclosed trades and zero receipts; explicit insufficient-data artifact written |
| Artifact corpus | `ok` | Seven required agent artifacts present and schema-valid, 1/1 each |
| Post-state baseline | `ok` | 80.6% vote-to-bill linkage; all core tables present |
| Full tests and TypeScript | `ok` | 284/284 tests; `tsc --noEmit` clean |
| Selected-member render | `ok` | Two renders were byte-identical |
| Reference-member render | `ok` | Only expected top-peer insertion/displacement on Josh Gottheimer's page |
| Database delta | `ok` | No non-target additions, removals, or rewrites in member-scoped tables |

## Disclosure reconciliation

The frozen Clerk indexes were checked independently of the loader. Paul Tonko's
records were:

| Index | Non-P records | Type-P records |
|---|---|---:|
| `2023FD.xml` | O `10060062`; X `30021256` | 0 |
| `2024FD.xml` | O `10066425`; X `30022750` | 0 |
| `2025FD.xml` | O `10077091`; X `30027444` | 0 |
| `2026FD.xml` | none | 0 |

The member-scoped loader reported `verified-empty` separately for 2023, 2024,
2025, and 2026. The full `pfd_transactions` table remained at 5,277 rows with
the same SHA-256 content digest before and after the trial. Paul Tonko has zero
transaction rows and zero duplicate filing/index keys. This closure is based on
the authoritative source indexes, not on an empty cache or parser output.

## Scoped database result

The candidate database contains one new member, 2,000 votes, 4,909 bills, 99
donors, zero transactions, and one pipeline-run record. For `members`, `votes`,
`bills`, `donors`, `pfd_transactions`, and `pattern_hits`, set differences
outside `paul-tonko` were zero in both directions.

The fixed Josh Gottheimer reference render changed only in the bounded top-peer
table: Paul Tonko entered with 1,028 shared bills and displaced the previous
last visible peer, Pramila Jayapal. The generated timestamp also changed. No
other reference content drifted.

Selected-member render SHA-256, both runs:
`46aa20d451561254e107e8c851d53819e1676151a67680939d4ecc389db9b7ce`.

## Runtime artifact hashes

- Researcher: `5548a59a8e6bdec6f98ce54f459b26b404a80576ed2b2ca2d7b43c2c624a3e5f`
- Data checker: `bf84439f0713902b41c25e4c959f5d49825781f1066d3fc5324ab99f9aca1981`
- Predictor: `0b711879f2b11c5f44444a5e095a9aa67af4849c4a1d5ce1ab6e8be95ae94b40`
- Trade analyst: `2a1be71450ed82c2d8768910c2347944d5731e20057862c74f9f0faab06dc672`
- Summarizer: `afe4f1ea68b6271293d2f52dfbed407d9f886a3dc688d77d573458ff35cf7409`
- Code checker: `f98c0cda6fdd68fad89d62ceef4574ec074fd57ac222dace616270c12ecf26c5`
- Final review: `4789ba445f1198013bba140c81d81229b46c331c162aa20b3a35bb40eccd5723`
- Final trial database: `a8ff5d1934cb60ac95f7cf7668dfd3c9a000e2b6e1263d83aff7865cbbe7364a`

## Disposition

Stratum 2 closes `verified-empty`, backed by all four frozen authoritative
indexes, subject to the required final-code replay after all strata and generic
fixes are complete.
