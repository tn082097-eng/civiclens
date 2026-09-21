# SetAside — open federal contracts set aside for small business

A free, daily-rebuilt index of every open US federal contract opportunity that
carries a small-business set-aside, sorted by how soon it closes.

**Status:** built and verified against live data; not yet deployed.
See `../OPPORTUNITY-ANALYSIS.md` for why this and not something else.

---

## Why it exists

SAM.gov is free, mandatory for federal contracts over $25,000, and hard to
search. The next rung up costs real money — HigherGov around $150–500/mo,
GovWin IQ $12,000+/yr — while guidance aimed at small contractors puts their
realistic software budget at $0–99/mo. Businesses currently close that gap by
paying freelancers to run searches by hand.

This sits in that gap: the ~4,200 notices a small business can actually bid on,
filtered out of the ~81,500 in the official extract, free to search.

## How it works

```
SAM.gov public extract (CSV, no key, no quota)
  → ingest.ts     filter + normalise → opportunities.json
  → build-site.ts pre-rendered HTML + slim search index
  → GitHub Pages
```

Runs entirely in GitHub Actions on a schedule. No server, no database, no
credentials, $0 to operate.

| File | Role |
|---|---|
| `csv.ts` | Streaming RFC 4180 parser. Hand-written because the `Description` column contains embedded commas, doubled quotes and raw newlines that a line-splitter corrupts silently. |
| `ingest.ts` | Fetches the extract, filters to actionable open set-asides, emits JSON + stats. |
| `taxonomy.ts` | State, NAICS sector and set-aside programme labels. Labels only — nothing is inferred. |
| `build-site.ts` | Emits the static site, sitemap and search index. |

## Filtering rules

A notice is published only if **all** hold:

- `Active = Yes`
- `ResponseDeadLine` is in the future
- `Type` is one a bidder can act on — Solicitation, Combined Synopsis/Solicitation,
  Presolicitation, Sources Sought, Special Notice
- it carries a real set-aside (not `NONE` / `No Set aside used`)

Measured on the live extract, 2026-09-21:

| Stage | Count |
|---|---|
| rows read | 81,512 |
| malformed | **0** |
| actionable type | 66,765 |
| deadline still open | 13,370 |
| **published** | **4,208** |

Top set-asides: Small Business Total 3,415 · SDVOSB 353 · WOSB 181 · 8(a) 84 ·
HUBZone 72. Top sectors: Manufacturing 2,088 · Construction 765 · Admin/Support
334 · Professional Services 315. DoD alone is 2,947 of the total.

## Failure behaviour

Follows the house rule from `AGENTS.md` — fail loudly, never publish a guess.

- A missing column in the extract **aborts** the run rather than publishing a
  half-mapped feed.
- Zero published opportunities **exits non-zero** rather than reporting success.
- A notice with no place of performance is labelled "Location not specified",
  never assigned a state.
- An empty facet page says it is empty instead of rendering blank.

## Running it

Not runnable in the dev container — it has no outbound network beyond npm and
GitHub. It runs on a runner.

```bash
# tests work anywhere
npx tsx --test ventures/govcon/*.test.ts

# these need network, i.e. CI
npx tsx ventures/govcon/ingest.ts --out ventures/govcon/data
npx tsx ventures/govcon/build-site.ts --data ventures/govcon/data \
  --out ventures/govcon/site --origin https://<host>
```

## Relationship to CivicLens

None, by design. This shares the repository and nothing else: no pipeline code,
no DuckDB, no published CivicLens artifact. Procurement records make no claim
about any named individual, so ADR 0001 and ADR 0003 are not implicated. It must
not reuse CivicLens's Pages deployment, which ADR 0002 keeps deliberately
dormant and manual — deployment belongs in a separate repository.

## Data and attribution

Source is the SAM.gov Contract Opportunities public data extract, published by
GSA for reuse. US government works are not subject to domestic copyright. The
site states plainly that it is unaffiliated with SAM.gov, the SBA and any
federal agency, and that the official notice governs.
