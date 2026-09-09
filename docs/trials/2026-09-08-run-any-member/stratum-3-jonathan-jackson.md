# Stratum 3 result — Jonathan L. Jackson

## Frozen identity and environment

- Stratum: House member with at least ten 2025 PTRs and a usable native text
  transaction table in the deterministic probe filing.
- Member: Jonathan L. Jackson (`jonathan-l-jackson`, `J000309`, Illinois, House).
- Final trial revision: `e7b6e75`.
- Disposable checkout: `civiclens-track-b-trials/s3-jonathan-jackson-replay`.
- Source database SHA-256: `a766c8917a0e6b42ddc488758eb0b1a66abb37d24c873a74b4cc9d6fd7e4a38b`.
- Trial started from an exact copy of that database, the frozen current-legislators
  YAML, and the four frozen House indexes. Every disclosure PDF was downloaded
  afresh from the official Clerk endpoint.
- PDFs were temporarily made unavailable to the extractor while the text files
  were parsed, mechanically preventing its OCR fallback. They were restored
  immediately afterward. No OCR ran.
- No production write, district load, OpenSecrets load, confirmatory runner,
  push, publication, or deployment occurred.

## Defect and replay

The first source inspection found that filing `20022795` put the abbreviated
location `L : Chicago, IL, US` into the asset name. A source-derived regression
test failed with that exact text. The generic parser fix now captures the full
abbreviated location while keeping same-line subholding and country-only forms
separate. Opus's bounded review identified over-broad regex risks; the final
pattern is case-sensitive like the original and bounded by known labels/end of
line. Commit `e7b6e75` contains the fix and its tests.

The discarded attempt was not reused. This record describes a complete replay
from another byte-identical source database and empty disclosure cache.

## Step statuses

| Step | Status | Evidence |
|---|---|---|
| Pre-state baseline | `ok` | 80.3% vote-to-bill linkage; all core tables present |
| Append and pipeline | `ok` | Final reviewer approved task `task-1788915704279-fe4d9258` |
| Sponsored legislation | `ok` | 15 fetched; 14 structurally valid rows upserted; 14 policy areas |
| Cosponsored legislation | `ok` | 1,102 fetched and inserted; zero duplicates/skips |
| Member bill linkage | `ok` | 1,246 regex links plus 614 GovTrack resolutions; 28 summaries fetched |
| House PTR fetch/extract/load | `ok` | 36 indexed filings; 195 source rows; 195 parsed and loaded; zero withheld |
| FEC independent expenditures, 2024 | `unavailable` | Supported pipeline left candidate ID null; member-scoped loader failed closed before fetch/write |
| OpenSecrets | `not-collected` | Optional source deliberately omitted by protocol |
| Timing-safe detectors | `ok` | One permitted detector ran; zero hits is valid; parked timing pair excluded |
| Theme gaps | `ok` | 111 theme-mappable trades; 670 receipts; ranked artifact written |
| Artifact corpus | `ok` | Seven required agent artifacts present and schema-valid, 1/1 each |
| Post-state baseline | `ok` | 80.6% vote-to-bill linkage; all core tables present |
| Full tests and TypeScript | `ok` | 286/286 tests; `tsc --noEmit` clean |
| Selected-member render | `ok` | Two renders were byte-identical |
| Reference-member render | `ok` | Only expected shared-donor peer row added to Josh Gottheimer's page |
| Database delta | `ok` | No non-target additions, removals, or rewrites in member-scoped tables |

## Disclosure reconciliation

The four frozen Clerk indexes contain 36 type-P filings: 8 in 2023, 10 in
2024, 10 in 2025, and 8 in 2026. Source-table rows were counted directly from
the official PDFs' native text layer using the two-date row structure,
independently of parser JSON. The first and last source rows of every filing
were compared with the normalized asset, owner, ticker, asset type, transaction
type, dates, amount, subholding, location, and description. All counts matched.

| Year | Filing ID: source/parsed/loaded rows |
|---|---|
| 2023 | `20022795`: 10/10/10; `20023077`: 6/6/6; `20023262`: 6/6/6; `20023443`: 3/3/3; `20023636`: 4/4/4; `20023804`: 3/3/3; `20023965`: 5/5/5; `20024078`: 4/4/4 |
| 2024 | `20024253`: 5/5/5; `20024450`: 6/6/6; `20024606`: 1/1/1; `20024811`: 5/5/5; `20025000`: 4/4/4; `20025635`: 7/7/7; `20025792`: 2/2/2; `20025938`: 4/4/4; `20026125`: 2/2/2; `20026313`: 5/5/5 |
| 2025 | `20026545`: 4/4/4; `20029065`: 4/4/4; `20030283`: 7/7/7; `20030452`: 3/3/3; `20030599`: 2/2/2; `20030860`: 33/33/33; `20031023`: 3/3/3; `20032232`: 4/4/4; `20033409`: 4/4/4; `20033566`: 5/5/5 |
| 2026 | `20033739`: 6/6/6; `20033929`: 10/10/10; `20034113`: 14/14/14; `20034301`: 4/4/4; `20034519`: 5/5/5; `20034688`: 1/1/1; `20034908`: 3/3/3; `20035370`: 1/1/1 |

Total: 195 source rows / 195 parsed rows / 195 loaded rows; zero count
mismatches, zero schema-invalid rows, zero duplicate `(filing_id, tx_index)`
keys, and zero assets containing filing-status, location, description, or
subholding labels.

Representative checks included:

- `20022795` first: 3 I Roadwork, Inc.; sale; 2023-04-28 / 2023-05-10;
  $1,001-$15,000; location Chicago, IL, US; description Roadwork Company.
- `20026313` last: Regeneron Pharmaceuticals, Inc. common stock (`REGN`);
  partial sale; 2024-11-01 / 2024-12-03; $1,001-$15,000.
- `20030860` first/last: Amazon (`AMZN`) purchase and Williams Companies
  (`WMB`) partial sale; all 33 source rows present.
- `20035370`: ViaSat (`VSAT`) partial sale; 2026-08-28 / 2026-09-02;
  $1,001-$15,000.

## Scoped database and render result

The candidate database contains one new member, 1,898 votes, 1,120 bills, 99
donors, 195 transactions across 36 filings, and one pipeline-run record. For
`members`, `votes`, `bills`, `donors`, `pfd_transactions`, and `pattern_hits`,
set differences outside `jonathan-l-jackson` were zero in both directions.

The fixed Josh Gottheimer reference render changed only by adding Jonathan L.
Jackson to the shared-donor peers table (three shared donors, $90.9K), plus the
generated timestamp. No unrelated reference content drifted.

Selected-member render SHA-256, both runs:
`89a03c9a2b11e88a4b8a96ebbb4dbb8b0ce9a71caf110d6a7e30a540dbfc1421`.

## FEC limitation

The frozen legislators YAML lists `H2IL01349`, but the supported sync-time live
OpenFEC name search returned no match and therefore persisted no candidate ID.
The member-scoped FEC-IE loader then failed closed with no fetch and no write.
No override or manual database edit was made. Gate B3 must decide whether this
`unavailable` result is acceptable or exposes a separate identity-resolution
gap; it is not represented as verified empty.

## Runtime artifact hashes

- Researcher: `00b4aca11d899d598bc0a2b289c3166f9193840bc61408281d4259df723f3eaa`
- Data checker: `09bbebfe853c959bf3336f886d2fb1e3bfcd52dad944f3e462b3c580ee5e3088`
- Predictor: `f5613af6c00916d88cfdfdc39edc652ed6739aa331a63feb5b4f1f2e4590445d`
- Trade analyst: `abfadc3bd56de33c1f64d696bbd3b408de3c1353924b12a43ba2087d8b6a5c86`
- Summarizer: `414c48a1419423246a49bec5f35e1e3864edf8c1155e3a9fa8766ad93047bd8b`
- Code checker: `7be85a453a98eac7e13458702615260f6b27d26ce45861b649f5f519d71b26f7`
- Final review: `f9cd5e0b01be80aa060f38c91ccfb393aa9ca928172ccfce3c984766ddc7c538`
- Final trial database: `9d8a9dda9c76daa8a075ff83520903b5761e04851fb6535b903718ce1ba90a9d`

## Disposition

The high-volume House text-PTR path closes `ok`. The separate FEC identity
status remains `unavailable` for Gate B3 review. The stratum is subject to the
required final-code replay after all six strata and generic fixes are complete.
