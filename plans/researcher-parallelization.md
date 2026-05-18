# Plan: Researcher Parallelization

## Goal
Split the current monolithic Researcher into parallel sub-agents, one per data source. Same inputs, same output shape — just faster and more debuggable.

## Why
Today `fetchPolitician()` runs serially: identity → bio → bills → votes → donors → totals. Six sequential awaits per politician. With the recent limit bumps (250 bills, 500 votes, 4-cycle donors) each politician now takes 60–90s wall-time. Most of that is idle waiting on network.

Additional motivation:
- **Isolates failures.** A GovTrack outage currently fails the politician's votes silently — but the slow timeout also delays downstream stages. Parallel sub-agents mean one source's timeout doesn't block the others.
- **Clearer debugging.** Each sub-agent writes its own output file (`bills.json`, `votes.json`, `donors.json`, `bio.json`) alongside the merged `researcher.json`. Makes it obvious which source failed and why.
- **Easier to add new sources.** New specialist agents (stock trades, lobbying, revolving door) plug in as additional sub-agents rather than new branches in one long function.

## Proposed shape

```
Researcher (orchestrator)
├── IdentityAgent       → bioguide, canonical name, govtrack id, state, chamber
├── BioAgent            → Wikipedia extract
├── BillsAgent          → Congress.gov sponsored-legislation
├── VotesAgent          → GovTrack vote_voter
├── DonorsAgent         → OpenFEC schedule_a (multi-cycle union)
└── TotalsAgent         → OpenFEC committee totals
```

1. Orchestrator resolves identity first (sequential — everything else depends on bioguide).
2. Fan out the remaining five sub-agents with `Promise.allSettled`.
3. Merge results. Partial failures become warnings, not pipeline-wide failures.

## Scope boundary
- **Same output contract** as today's `fetchPolitician()`. The Data Checker, Summarizer, and everything downstream don't need to know the orchestrator changed.
- Does **not** add new data sources. That's a separate plan per specialist.
- Does **not** parallelize the pipeline's outer agent graph (Researcher → Data Checker → …). That's a different change.

## Tradeoffs
- Slightly more code complexity (orchestrator + sub-agent files vs. one `fetch.ts`).
- Need a coherent partial-success rule: does "no bills but has votes+donors" still produce a publishable record? Current answer: yes, with warnings. Keep that.

## Rough estimate
~300 LOC moved, ~50 LOC net added for orchestration. 1–2 hours with tests.
