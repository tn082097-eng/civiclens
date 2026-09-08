# Track B frozen selection protocol

## Cutoff and sources

- Cutoff: **2026-09-08T21:10:00Z**. Later filings or roster changes are outside
  this trial and do not alter its selected people.
- Source code base: `c8552c1b2fd69ad65c94ab1d06c62678759e7f1c`.
- Source DuckDB: read-only hash recorded in `inputs.sha256`; no adjacent WAL was
  present.
- Current legislators: `unitedstates/congress-legislators` commit
  `8a3c7e6987f890b32e56058f7ddbdf380860b4a3`, retrieved 2026-09-08T20:58:09Z.
- House indexes: Clerk annual ZIP/XML files for 2023–2026, retrieved
  2026-09-08T20:58:09Z from
  `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/<year>FD.zip`.
- Senate classifications: saved raw EFDS search responses from
  `https://efdsearch.senate.gov/search/report/data/`, report type 11 and filer
  type 1, covering 2023–2026. Retrieval times are embedded in each response.
- House text classifications: the deterministic probe PDF from the official
  Clerk PTR endpoint plus `pdftotext -layout` output. `pdftotext` classified
  native text only. **No OCR ran.**

Raw immutable inputs remain at
`/home/captainanime/Developer/civiclens-track-b-inputs/`; their hashes and
logical names are tracked in `inputs.sha256`. The normalized full eligible pool
is tracked in `candidate-facts.json`.

## Eligible pool

Start with the 539 entries in the frozen current-legislators YAML. Exclude every
current bioguide present in the source database or resolved from the
frozen `names.txt`. This produced 489 eligible candidates and 50 exclusions:
406 House members and 83 senators. Every exclusion and unresolved roster name
is retained in `candidate-facts.json`.

House PTR identity uses first name, last name, and state/district together.
Only Clerk filing type `P` is counted. DocIDs come from the Clerk indexes, never
from PDF body text.

## Ranking and assignment

Seed: `civiclens-track-b-2026-09-08-v1`.

Within each static stratum pool, rank by the lowercase hex digest of
`HMAC-SHA256(seed, stratum_id || bioguide)` and use bioguide as the final
tiebreaker. Assign in order `1, 2, 6, 3, 4, 5`, removing selected people
globally. Dynamic EFDS/text evidence is checked in rank order; each rejected
higher-ranked candidate remains in the manifest.

For stratum 3, the probe is the lowest DocID among the candidate's 2025 PTRs.
For stratum 6, it is the earliest indexed year and then lowest DocID across the
frozen range. A probe is usable text only when `pdftotext -layout` exposes the
transaction-table structure and rows; byte count alone is not an extraction
acceptance test.

## Frozen selections

| Stratum | Member | Bioguide | Recorded rank | Evidence |
|---|---|---|---:|---|
| 1 — Senate with PTRs | Jerry Moran | M000934 | 1 | EFDS: 7 PTRs |
| 2 — House with zero PTRs | Paul Tonko | T000469 | 1 | Clerk indexes: 0 type-P |
| 6 — scanned House PTR | Brad Sherman | S000344 | 3 | DocID 8220768: no native text |
| 3 — high-volume text House PTR | Jonathan L. Jackson | J000309 | 2 | 10 PTRs in 2025; DocID 20026545 has table text |
| 4 — Senate with zero PTRs | Kevin Cramer | C001096 | 4 | EFDS: 0 PTRs |
| 5 — no FEC candidate id | Alan Armstrong | A000383 | 1 | frozen YAML: empty `id.fec` |

Disqualifications are recorded in `selection-manifest.json`: Glenn Grothman and
Ed Case had usable text, Harold Rogers did not, and John Kennedy, David
McCormick, and Mark Warner had one or more Senate PTRs.

No discretionary replacement is permitted after this freeze. Runtime,
network, parser, or code failures stay attached to the selected person.
