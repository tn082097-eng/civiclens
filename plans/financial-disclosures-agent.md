# Plan: Financial Disclosures Agent

## Goal
Pull required financial disclosures across all three branches — Congress (STOCK Act), executive (OGE 278), and judicial (AO-10) — and surface them alongside the policy decisions those officials influenced. Enables the kind of "trade date vs. decision date" cross-reference the pipeline can't do today.

## Why
The Hegseth / pre-Iran-strike broker activity is the archetype: a trade happens, a policy decision follows, and the raw filings are public — but in different portals, under different forms, with no cross-reference. The accountability lives in the **join**, and the join never happens because nobody reads all three branches' filings side-by-side against policy calendars.

Current pipeline can't even see Hegseth because he has no Congress.gov bioguide. Same gap for Rubio-as-SecState, every White House staffer, every agency head, every federal judge. This agent fixes the scope gap directly.

## Who's in scope
- **Congress** — members + senior staff above STOCK Act thresholds. Includes spouse and dependent-child holdings (disclosure is required).
- **Executive branch** — cabinet, deputy secretaries, agency heads, commissioners, WH senior staff, presidential appointees requiring Senate confirmation.
- **Judicial** — SCOTUS justices, circuit/district judges. Sensitive post-recent-reforms.

Not in scope initially:
- State/local officials (federal-first rule).
- Career civil servants below disclosure thresholds.

## Data sources (primary, in priority order)
1. **House Clerk Financial Disclosures** — `disclosures-clerk.house.gov`. Periodic Transaction Reports (PTRs — trades within 45 days) and annual FDs. XML downloads available; relatively clean.
2. **Senate Office of Public Records** — `efdsearch.senate.gov`. Same forms, less friendly to scraping; requires respectful session handling.
3. **OGE Public Access** — `ogepublicaccess.oge.gov`. Executive-branch 278 filings (pre-appointment, annual, termination). PDFs; needs OCR/parsing pipeline.
4. **U.S. Courts financial disclosures** — `uscourts.gov` for federal judges, plus SCOTUS-specific pages. PDFs; sparse.
5. **SEC Form 4** — `sec.gov/cgi-bin/browse-edgar`. Only relevant when an official also sits on a public-company board (rare but possible for judges or ex-cabinet).

Secondary aids (navigation only, not citations): Quiver Quantitative, Capitol Trades, the Senate Stock Watcher bot. Every published claim must cite the primary filing.

## What the agent produces
For each tracked official, a record like:

```json
{
  "personId": "hegseth-pete",
  "disclosures": {
    "source": "oge-278",
    "filedAt": "2025-01-22",
    "coveringPeriod": "2024-01-01_to_2025-01-22",
    "sourceUrl": "https://ogepublicaccess.oge.gov/...",
    "transactions": [
      { "holder": "spouse", "asset": "LMT", "type": "sale", "date": "2025-06-14",
        "amountBand": "$15,001-$50,000", "source": "oge-278" }
    ],
    "holdings": [...],
    "liabilities": [...]
  }
}
```

PTRs for Congress have the same shape with `source: "house-clerk-ptr"` or `senate-efd-ptr`.

## Pipeline integration
- Runs as a new specialist agent in the Researcher phase (post-parallelization) **or** as its own pipeline stage if we want disclosure tracking to run on a different cadence (e.g., weekly sweep vs. per-politician lookup).
- Connection Mapper gains a new, powerful join type: **trade-date × decision-date proximity**. Requires a companion data source:
  - A **Policy Events** dataset (next plan). For MVP, manually-curated list of major decisions (Iran strike 2025, tariff announcements, rate decisions, major procurement awards). Automate later.
- Ticker-to-committee-jurisdiction mapping: a senator on Armed Services trading defense-industry stock is structurally different from the same senator trading consumer-tech stock. Annotate where defensible.

## How the story is told (editorial discipline)
The temptation to write "Hegseth's broker sold before the Iran strike" is exactly the editorializing the mission forbids. The output is three dated records side-by-side:

> **2025-06-14** — Periodic Transaction Report filed by P. Hegseth: spouse sold Lockheed Martin, $15,001–$50,000 band.
> **2025-06-21** — DoD confirms strike on Iranian facilities (Source: DoD press release).
> **2025-06-22** — SEC closing price LMT: [value], +N% since 2025-06-14.

Reader draws the inference. The pipeline's `noEditorializing` check must treat any phrasing of causation as a hard fail in this agent's output — the signal is strong enough that the prose must be weaker, not the other way around.

## Scope caveats
- **Correlations aren't causation.** Many trades are pre-scheduled (10b5-1 plans, blind trusts, quarterly rebalances). Must distinguish where possible — 10b5-1 trades are disclosed as such on the PTR.
- **Amount bands, not exact values.** STOCK Act reports trades in ranges. Our records must preserve the range, not imply precision.
- **Family holdings are political dynamite.** Spouses and dependent children are disclosed by law — but the standard of "the official did this" is weaker than "the official's spouse did this." Label clearly.
- **Blind trusts.** Federal officials often use qualified blind trusts — the official doesn't know the trades. Flag trust-held accounts and decline to allege knowledge.
- **Legal defensibility.** Publishing inferences of insider trading is actionable. Publishing dated records side-by-side is not. Stick to the latter.

## Rough order of work
1. House Clerk PTR/FD ingestion (easiest — XML dumps available).
2. Name-matching across Congress records we already have (leverages existing canonical-name work).
3. Senate eFD ingestion.
4. OGE 278 ingestion (harder — PDFs, OCR).
5. Federal judges' AO-10 disclosures.
6. Policy Events dataset (separate plan) — enables the join.
7. Connection Mapper join logic.

## Unlocks
- Hegseth pre-strike case (executive branch, already a public controversy).
- Every STOCK Act case that OpenSecrets and Quiver have been flagging for years — but with primary-source citations instead of inference from a third-party database.
- Nancy Pelosi trading pattern visibility (legal; data is public; no one has joined it against committee schedules in one place).
- SCOTUS financial disclosures in the wake of recent reforms.
- Pre-appointment 278s for Senate confirmation hearings — committee members could cross-reference the nominee's holdings against their own regulatory portfolio in real time.
