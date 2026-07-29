# Senate PTR harvest — 11 uncached senators are all genuine nulls

*2026-07-28. Harvest run and verified. This document exists because a null
harvest writes nothing to disk — without it, the next agent re-runs all 11 to
rediscover the same nulls.*

## Result

**All 11 senators filed zero periodic transaction reports for 2022–2026.**
0 errors across all 11 runs.

| senator | bioguide | state | result |
|---|---|---|---|
| Amy Klobuchar | K000367 | MN | no PTRs found |
| Bernie Sanders | S000033 | VT | no PTRs found |
| Chuck Schumer | S000148 | NY | no PTRs found |
| Cory Booker | B001288 | NJ | no PTRs found |
| Elizabeth Warren | W000817 | MA | no PTRs found |
| John Cornyn | C001056 | TX | no PTRs found |
| Josh Hawley | H001089 | MO | no PTRs found |
| Lisa Murkowski | M001153 | AK | no PTRs found |
| Rand Paul | P000603 | KY | no PTRs found |
| Ted Cruz | C001098 | TX | no PTRs found |
| Tommy Tuberville | T000278 | AL | no PTRs found |

Each was run individually via
`npx tsx skills/senate-ptr/fetch.ts --name "<roster name verbatim>"`, covering
the default 2022–2026 window.

## Why this is a real result and not a broken fetcher

**A uniform "0 for everyone" is exactly the signature of a failed
`getSession()`** (`skills/senate-ptr/fetch.ts:89`) — if the efdsearch CSRF
scrape or disclaimer POST breaks, every senator fails identically. That
possibility was ruled out with a **positive control**:

```
$ npx tsx skills/senate-ptr/fetch.ts --name "Sheldon Whitehouse"
  ✓ Sheldon Whitehouse: 30 PTR(s) (1 new, 29 cached)
  Done: 1 new, 29 cached, 0 errors
```

A known filer returned 30 filings through the same code path in the same
session. The terms-of-use interstitial, CSRF token, session cookie, and search
POST are all working. **The 11 zeros are therefore substantive, not a
connectivity artifact.**

Anyone re-checking this later should re-run the positive control first rather
than assuming the nulls are stale.

## Context: this is the expected base rate

The House side showed the same pattern — 23 of 26 House members with zero
`pfd_transactions` had filed **zero PTRs ever**, verified offline against the
House Clerk index (`data/caches/pfd-cache/index/*FD.txt`). Most members of
Congress do not trade individual securities; several of these senators
(Sanders, Warren, Schumer, Booker) are publicly known not to hold individual
equities.

**Zero trades is a fact about the member, not a gap in the pipeline.** Do not
"fix" these members, and do not treat their `insufficient-data` theme-gaps band
as a defect.

## Note: the Senate has no offline index

Unlike the House, there is no bulk filing index for the Senate — `SOURCES.md:262`
records that efdsearch is JS/terms-gated and is *"the one place browser-harness
is justified"*. Consequently:

- The fetch **is** the diagnosis. There is no way to know in advance whether a
  senator filed, short of running it.
- A senator with no cache files is indistinguishable from one never attempted,
  **which is precisely why this document exists**.

## Side effect: one new Whitehouse filing

The positive control picked up **1 new PTR** for `sheldon-whitehouse` (30 total,
29 previously cached). It was loaded:

```
npx tsx agents/pipeline.ts --load-senate-ptr --bioguide W000802
```

- `pfd_transactions`: 5,078 → **5,084** (+6 rows)
- Whitehouse themed trades: 80 → **85**, band unchanged (`ranked`)
- Gates after load: `verify:baseline` exit 0 (linkage 80.3%), **208/208 tests**

Note `--member <slug>` does **not** work for these loaders — `lib/ingest-scope.ts`
resolves names, not hyphenated slugs. Use `--bioguide <id>`.

## If this is revisited

The window was 2022–2026 (the fetcher default). A senator who traded before 2022
would not appear. Widening it (`--from-year`) is the only thing that could change
these results, and there is no reason to expect it would for this roster.

Re-running is cheap and safe — `fetch.ts:304` skips filings already cached, so a
repeat run costs one search per senator and writes nothing new.
