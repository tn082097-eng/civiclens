# Beyer / Peters have no tickers because they trade municipal bonds, not stocks

*2026-07-28 — diagnostic only, no code change.*

## Question

`don-beyer` (53 PFD transactions) and `scott-peters` (170) both sit at
`insufficient-data` with **zero theme-mappable trades**, because 0 of their rows
carry a ticker. Since `pipeline/score-theme-gaps.ts:131` inner-joins
`ticker_sectors ts ON ts.ticker = UPPER(p.ticker)`, a null ticker makes the trade
invisible to the band denominator.

That looked like an extraction defect in `skills/pfd-fetcher/extract.ts` —
`TICKER_RE = /\(([A-Z][A-Z0-9.]*)\)/` (line 262) only recovers a parenthesized
symbol, so a layout it failed to match would silently drop tickers.

## Finding: not a defect. The filings genuinely have no ticker.

Extraction is lossless for both members — the cached JSON transaction counts
match the DB exactly (Beyer 53, Peters 170), so nothing was dropped between
`extract.ts` and `pfd_transactions`.

Every one of their transactions is a **non-equity instrument**, dominated by
`GS` (government/municipal securities):

| member | GS | OT | OI | OL | total |
|---|---|---|---|---|---|
| `don-beyer` | 51 | – | 2 | – | 53 |
| `scott-peters` | 134 | 25 | 7 | 4 | 170 |

Representative assets: *California St GO BDS 4.25%*, *New York NY City
Transitional Fin Auth*, *Farmington NM Pollutn Var*, *CA ST DEPT WTR UTIL*,
*East Bay MUD Sys CA*, *San Francisco CA Sewer Util*.

**Municipal bonds do not have ticker symbols.** There is nothing to extract.

## Corroboration: the parser is fine

Asset-type distribution across all cached filings, with ticker-recovery rate:

| assetType | total tx | with ticker |
|---|---|---|
| `ST` (stock) | 4287 | **4287 (100%)** |
| `OP` (options) | 105 | 105 (100%) |
| `OT` (other) | 104 | 61 |
| `GS` (govt securities) | 329 | **2 (0.6%)** |
| `OI` | 9 | 0 |
| `OL` | 5 | 0 |
| `AB` | 6 | 1 |
| `ET` | 3 | 3 |

`TICKER_RE` recovers **100% of stock tickers**. The near-zero rate on `GS` is a
property of the instrument class, not of the regex.

## Consequence

`don-beyer` and `scott-peters` are **true `insufficient-data` members**, not
data gaps. No parser fix, PFD re-harvest, or ticker-crosswalk expansion can move
them — the trade→theme→vote nexus this project measures is defined over
issuer-linked equities, and these two members disclose almost none.

Do not "fix" them, and do not treat their band as a defect in a future audit.

## If this is ever revisited

Mapping municipal bonds to themes would require a **different mechanism** than
`ticker → CIK → SIC → theme`: issuer-name matching against a muni-issuer
registry (state/agency/purpose), where the "sector" is the bond's stated purpose
(water utility, sewer, transit, pollution control). That is a new hypothesis
with a new data source, not an extension of the ticker crosswalk — and under the
preregistration rules it would need its own registration before any confirmatory
scoring.

## Method

```bash
# extraction completeness + asset-type mix, straight from the cached JSON
node -e "…"   # walks data/caches/pfd-cache/<year>/*.json, groups by assetType
```

Verified against `pfd_transactions` row counts for both members.
