# House Clerk — Personal Financial Disclosures

Frozen reference for `skills/pfd-fetcher/`. The House Clerk publishes Members'
STOCK Act filings as a per-year ZIP containing an XML index plus per-document
PDFs. Annual reports and Periodic Transaction Reports (PTRs) are the two
substantive types we ingest.

This is the **only** branch with a clean, no-auth, machine-readable index.
Senate eFD requires session handling; OGE 278 is PDFs in a paginated portal;
judicial AO-10 is the worst of both. House first because the data is here
and the format is stable.

## Endpoints

```
# Annual ZIP — XML index of every filing for that year
GET https://disclosures-clerk.house.gov/public_disc/financial-pdfs/<year>FD.zip
    → unzip → <year>FD.xml

# Annual / candidate / new-member / termination PDF
GET https://disclosures-clerk.house.gov/public_disc/financial-pdfs/<year>/<DocID>.pdf

# Periodic Transaction Report PDF
GET https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/<year>/<DocID>.pdf
```

The PDF subdirectory is determined by `FilingType`:
- `P` → `ptr-pdfs/`
- everything else → `financial-pdfs/`

No auth, no rate-limit headers. Be polite — the server is slow under load.

## Index XML shape

```xml
<FinancialDisclosure>
  <Member>
    <Prefix>Hon.</Prefix>
    <Last>Pelosi</Last>
    <First>Nancy</First>
    <Suffix />
    <FilingType>P</FilingType>          <!-- see codes below -->
    <StateDst>CA11</StateDst>
    <Year>2024</Year>
    <FilingDate>2/23/2024</FilingDate>
    <DocID>20024542</DocID>             <!-- → ptr-pdfs/2024/20024542.pdf -->
  </Member>
  ...
</FinancialDisclosure>
```

Sample frozen as `house-clerk-index-sample.xml` (one Member element).

### Filing-type codes

Observed in the 2024 index (2 233 records total):

| Code | Count | Meaning                              | Substantive? |
|------|-------|--------------------------------------|--------------|
| C    | 657   | Candidate report (pre-election)      | no — drop    |
| X    | 454   | Extension request                    | no — drop    |
| **P**| 451   | **Periodic Transaction Report**      | **yes**      |
| O    | 372   | Annual disclosure (full-year)        | yes (deferred) |
| A    | 82    | Amended annual                       | yes (deferred) |
| D    | 70    | New member, due-date filing          | yes (deferred) |
| W    | 66    | Withdrawn / waiver                   | edge case    |
| H    | 66    | Hearing-extension                    | edge case    |
| T    | 7     | Termination report                   | yes (deferred) |
| B    | 4     | Annual amendment-bundle              | yes (deferred) |
| G    | 3     | Gift travel report                   | edge case    |
| E    | 1     | Exempt                               | drop         |

`fetch.ts` already drops `C/E/G/X`. Extractor (this session) handles **P only**.
Annual variants (`O/A/D/T/B`) are a separate parser — much messier table layout.

## PTR text format (`pdftotext -layout`)

Sample frozen as `house-clerk-ptr-sample.txt` (Pelosi 2024 filing 20025368).

### Header

```
                                                       Filing ID #20025368

F          I
Name:                 Hon. Nancy Pelosi
Status:               Member
State/District: CA11
```

`F I` is "Filer Information"; the section labels arrive with their letters
column-broken by `pdftotext`. Treat as positional anchors, not strings.

### Transaction rows

Each transaction is a multi-line block:

```
           SP          Broadcom Inc. - Common Stock               P                 06/24/2024 06/24/2024            $1,000,001 -
                       (AVGO) [OP]                                                                                   $5,000,000
                       F      S      : New
                       D           : Purchased 20 call options with a strike price of $800 and an expiration date of 6/20/25.
```

Field anatomy (column positions are approximate — varies by PDF generator
build):

- **Owner** (col ~11): `SP`=spouse, `JT`=joint, `DC`=dependent child, blank=self.
- **Asset name** (col ~22): may wrap to a second line; ticker in parens
  `(TICKER)` and asset-type code in brackets `[ST|OP|AB|...]` typically
  appear on the wrap line.
- **Transaction type** (col ~58): `P` purchase, `S` sale, `S (partial)`
  partial sale, `E` exchange.
- **Transaction Date** (col ~78): `MM/DD/YYYY`.
- **Notification Date** (col ~89): `MM/DD/YYYY`. Almost always equal to
  transaction date for stock; filers report on actual trade date.
- **Amount band** (col ~110): `$LOW -` on row 1, `$HIGH` on row 2.
- **Cap. Gains > $200**: yes/no flag, often blank for purchases.

Trailing sub-rows on each transaction:

- `F S : <status>` — Filing status (`New`, `Amended`).
- `D : <description>` — Free-form description (option strikes, share counts).
- `S O : <name>` — Sub-holding owner / account label (e.g. "Marjorie IRA"). Common
  on retirement-account holdings; absent on most direct-account trades.
- `L : <CC>` — Location (two-letter, usually `US`). Often paired with `S O`.

### Asset-type bracket codes

Subset observed in the cache (full reference: <https://fd.house.gov/reference/asset-type-codes.aspx>):

| Code | Meaning                                  |
|------|------------------------------------------|
| ST   | Stock (common)                           |
| OP   | Options                                  |
| AB   | Other security / LLC interest / fund     |
| BA   | Bank account                             |
| CT   | Cryptocurrency                           |
| GS   | Government security                      |
| MF   | Mutual fund                              |
| EF   | Exchange-traded fund                     |
| FU   | Futures contract                         |

### Amount bands

Predefined ranges from the STOCK Act schedule. The PDF prints just the band
label, never the exact value. Most common observed:

```
$1,001 - $15,000
$15,001 - $50,000
$50,001 - $100,000
$100,001 - $250,000
$250,001 - $500,000
$500,001 - $1,000,000
$1,000,001 - $5,000,000
$5,000,001 - $25,000,000
$25,000,001 - $50,000,000
> $50,000,000
```

Preserve as a string. **Never** invent a midpoint — that's editorializing.

### Trailer

```
Digitally Signed: Hon. Nancy Pelosi , 02/23/2024
```

The filing date here is the signature date, not the transaction date. Use
`<FilingDate>` from the index XML if you need the canonical filing date —
the digital-signature date can be later (for amendments).

## What the extractor produces

`skills/pfd-fetcher/extract.ts` reads each cached `*.txt` for a `P` filing
and writes a sibling `*.json`:

```json
{
  "filingId": "20025368",
  "source": "house-clerk-ptr",
  "filer": {
    "name": "Hon. Nancy Pelosi",
    "status": "Member",
    "stateDistrict": "CA11"
  },
  "signedAt": "2024-07-02",
  "transactions": [
    {
      "holder": "spouse",
      "asset": "Broadcom Inc. - Common Stock",
      "ticker": "AVGO",
      "assetType": "OP",
      "type": "purchase",
      "date": "2024-06-24",
      "notificationDate": "2024-06-24",
      "amountBand": "$1,000,001 - $5,000,000",
      "filingStatus": "New",
      "description": "Purchased 20 call options with a strike price of $800 and an expiration date of 6/20/25.",
      "subholding": null,
      "location": null
    }
  ]
}
```

`subholding` and `location` populate when the filer marks a sub-account
(typical for IRA-held positions) — null on direct-account trades.

## Pitfalls observed in the wild

1. **Asset name wraps**: long names like "Broadcom Inc. - Common Stock"
   push the `(AVGO)` and `[OP]` to the next line. Parser must reassemble.
2. **Amount band wraps**: always two lines (low on row 1, high on row 2).
3. **Self-owned trades have a blank owner column** — cannot regex-match a
   leading two-letter code. Use position, or treat blank as `self`.
4. **`S (partial)` looks like `S`** until you read further right. Match the
   longer alternative first in the regex.
5. **LLC/private-fund holdings** (`[AB]`) often have no ticker — parens may
   be absent. Don't require a ticker; treat as optional.
6. **Some filings have zero transactions** (filer's spouse only had income;
   cleared the trade test below threshold). Empty arrays are valid output.
7. **`pdftotext` whitespace counts vary** between system versions. Don't
   pin to absolute column numbers — use whitespace tokens with tolerant
   regex, and validate the parse with the count of `Filing ID #` × the
   count of date-stamped rows.
8. **Page breaks repeat the table header**. On multi-page PDFs `pdftotext`
   inlines the column header (`ID Owner Asset Transaction Date …`) on every
   page. The extractor explicitly drops those lines so they don't leak into
   asset names or descriptions.
9. **Amount band on one line vs two**. Smaller bands (`$1,001 - $15,000`)
   render on a single line; larger bands wrap (`$X -\n$Y`). The primary-line
   regex makes the high-amount optional and falls back to the next line.
10. **Self-owned trades have a blank owner column**. The owner field in the
    primary regex is optional; absence → `holder: "self"`.

## Provenance

- Sample frozen 2026-04-25 from cached `pelosi-nancy-20025368.txt`
  (originally fetched 2026-04-19).
- Extractor logic verified against 5 cached Pelosi PTRs in `pfd-cache/2024/`.
- House Clerk publishes no public version contract. Treat as best-effort.
