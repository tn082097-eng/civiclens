# Stratum 3 result - Cleo Fields

**Outcome: PASS.** Cleo Fields (`cleo-fields`, `F000110`, House) completed the
high-volume text-layer PTR trial at `e7c7bcd`.

The 21 exact DocIDs came from the frozen Clerk indexes. PDFs were downloaded
from the official PTR endpoint and converted with `pdftotext -layout`. Before
the extractor ran, every PDF was renamed out of reach, mechanically preventing
the OCR fallback; all were restored afterward. No OCR ran.

| Filing | Visible rows | Parsed / loaded |
|---|---:|---:|
| 20027855 | 1 | 1 |
| 20030472 | 44 | 44 |
| 20030803 | 58 | 58 |
| 20031017 | 38 | 38 |
| 20032106 | 21 | 21 |
| 20033326 | 8 | 8 |
| 20033424 | 11 | 11 |
| 20033493 | 4 | 4 |
| 20033559 | 2 | 2 |
| 20033616 | 15 | 15 |
| 20033732 | 5 | 5 |
| 20033858 | 6 | 6 |
| 20034018 | 6 | 6 |
| 20034179 | 2 | 2 |
| 20034295 | 1 | 1 |
| 20034357 | 1 | 1 |
| 20034591 | 1 | 1 |
| 20034800 | 4 | 4 |
| 20034894 | 3 | 3 |
| 20035023 | 1 | 1 |
| 20035345 | 1 | 1 |
| **Total** | **233** | **233** |

Every filing's first and last row was compared with the source text. The manual
exception pass also checked all 13 non-purchase rows, six `[OT]` Figma rows with
location and description, the wrapped Treasury bill `[GS]` row with no ticker,
and multiline asset and amount bands. Dates, notification dates, transaction
types, amounts, tickers, asset types, and asset names matched. Scratch loading
reported 0 unmatched and 0 withheld filings; the loaded set has 0 invalid
required fields and 0 duplicate `(filing_id, tx_index)` keys.

The selected-member render was byte-identical twice, SHA-256
`ea0dbad17a4892c8531562c22a206bd542f84c19f6683cd1a17bb16b34afe44b`.
Baseline, 296/296 tests, TypeScript, and all seven artifact schemas passed. The
source database remained byte-identical. OpenSecrets was `not-collected`; no
production write, push, deployment, or confirmatory timing run occurred.
