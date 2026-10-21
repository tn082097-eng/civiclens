# Fresh-member smoke result - Carol D. Miller

## Outcome

**Technical onboarding smoke: PASS. Disclosure coverage: PARTIAL by explicit
source-backed rejection.**

Carol D. Miller (`carol-d-miller`, `M001205`, House, West Virginia) completed
the isolated onboarding, enrichment, timing-safe detector, validation, and
deterministic render path. The system found eight genuine Clerk PTR filings,
parsed all 41 visible transaction rows, loaded the 38 rows from seven valid
filings, and withheld the three rows from one filing whose official form has an
impossible date sequence. No value was guessed or repaired.

This proves one new member can run end to end while the loader abstains from
publishing a source-inconsistent filing. It does not prove universal pipeline
reliability and does not count toward the later untouched six-member set.

## Environment and boundaries

- Code revision: `df7becb`.
- Disposable checkout: `civiclens-track-b-trials/smoke-carol-miller`.
- Source database before run: SHA-256
  `a766c8917a0e6b42ddc488758eb0b1a66abb37d24c873a74b4cc9d6fd7e4a38b`.
- Scratch database after run: SHA-256
  `1401204a0929dcc810b82ed7a5c154c6a7ce764867405e08fc9d4a80b927ead0`.
- Production database remained at the source hash with no adjacent WAL.
- Frozen current-legislators YAML and 2023-2026 Clerk indexes were used.
- Official PTR PDFs were downloaded into the scratch cache. PDFs were renamed
  out of reach while extraction ran, mechanically preventing the OCR fallback.
  All PDFs were restored afterward. No OCR ran.
- OpenSecrets was not collected. No district loader, confirmatory timing path,
  production write, push, publication, or deployment ran.

## Step results

| Step | Result |
|---|---|
| Pre-state baseline | Pass: 80.3% global vote-to-bill linkage; all core tables present |
| Append and pipeline | Pass: task `task-1789006876260-c12f38e3`; final reviewer approved |
| Canonical identity | `carol-d-miller`; `M001205`; House; FEC `H8WV03097` |
| Sponsored legislation | 101 fetched; 100 upserted; 99 policy areas; 1 source row skipped |
| Cosponsored legislation | 984 fetched and inserted; zero duplicate/skipped rows |
| Member bill linkage | 1,269 regex links + 685 API links; 46 unresolved; 28 summaries fetched |
| House PTR path | 8 source filings; 41 source rows; 41 parsed; 38 loaded; 1 filing/3 rows rejected |
| FEC IE, 2026 | Pass: 1 member-cycle, 1 with IE; 3 aggregate and 22 filing rows added |
| OpenSecrets | `not-collected` |
| Timing-safe patterns | Pass: zero hits; parked timing pair did not run |
| Theme gaps | Pass: 18 mappable trades and 146 receipts |
| Post-state baseline | Pass: 80.6% global linkage; all core tables present |
| Full tests | 286/286 pass |
| TypeScript | `tsc --noEmit` pass |
| Artifact corpus | Seven agent artifacts, 1/1 valid for each schema |
| Selected render | Two byte-identical builds; SHA-256 `4d6a8960ff9d646d8e4af3bec5366439117aef92a8dea5ddd13bced2e2a5e900` |
| Reference render | Josh Gottheimer changed only in the generated timestamp |
| Database delta | Only insertions attributable to Carol or her referenced bills/sources; zero removals or non-target member-keyed changes |

An initial sponsored-loader invocation used the guessed slug `carol-miller` and
reported zero members, with no write. The canonical slug was then read from the
scratch database and all subsequent commands used `carol-d-miller`.

## PTR source reconciliation

All 14 PDF pages were rendered and inspected. Every visible transaction row was
compared with the parsed asset, ticker, asset type, owner, transaction type,
transaction date, notification date, amount, filing status, subholding,
location, and description.

| Filing | District | Source | Parsed | Loaded | Result |
|---|---|---:|---:|---:|---|
| `20022224` | WV03 | 3 | 3 | 0 | rejected: each official notification date is `01/04/2022`, before the December 2022 trades; signed `01/04/2023` |
| `20022751` | WV01 | 3 | 3 | 3 | verified |
| `20023947` | WV01 | 2 | 2 | 2 | verified |
| `20024109` | WV01 | 4 | 4 | 4 | verified |
| `20025203` | WV01 | 10 | 10 | 10 | verified |
| `20025855` | WV01 | 1 | 1 | 1 | verified |
| `20029135` | WV01 | 14 | 14 | 14 | verified |
| `20033779` | WV01 | 4 | 4 | 4 | verified amended filing |
| **Total** |  | **41** | **41** | **38** | 7 accepted; 1 rejected |

The loaded rows contain zero invalid required fields and zero duplicate
`(filing_id, tx_index)` keys.

## Database delta

The changed base tables were `members`, `votes`, `bills`, `bill_subjects`,
`bill_summaries`, `committees`, `donors`, `pfd_transactions`, `pipeline_runs`,
`super_pac_ie`, and `super_pac_ie_filings`. Every change was an insertion; no
pre-existing row was removed or rewritten.

The member-keyed delta check found zero non-target additions, removals, or
rewrites in `members`, `votes`, `bills`, `donors`, `pfd_transactions`, and
`pattern_hits`. The new committee, FEC, and pipeline rows all carry Carol's
member ID. All 99 new bill-subject rows and all 28 new bill summaries are
referenced by Carol's normalized bill or vote IDs.

## Direct blocker before selecting the new six

The frozen candidate-facts builder represented Carol as having seven PTRs. The
name-scoped Clerk fetch found the eighth, `20022224`, under her former district
`WV03`; the PDF identity and signature prove it is hers. Current-district
matching is therefore not a complete historical filing-identity rule.

This did not alter Carol's smoke eligibility or HMAC rank, and the live fetch
prevented data loss. It does block reusing the old candidate filing counts as a
complete frame for the new six. Before those six are selected, the candidate
normalization must associate historical district changes generically and the
resulting frozen pool must be regenerated. Previously exposed members remain
excluded.
