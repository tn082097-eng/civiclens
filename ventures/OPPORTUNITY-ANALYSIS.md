# Revenue opportunity analysis

**Date:** 2026-09-21
**Author:** autonomous research session
**Status:** research complete → one candidate selected for build

This document exists so the decision is auditable and so a later session
inherits the reasoning instead of re-deriving it. Every demand claim below is
sourced. Where I could not verify something, it says so.

---

## 0. Operating constraints (these shaped the answer more than the market did)

| Constraint | Consequence |
|---|---|
| Container egress is blocked to everything except `registry.npmjs.org` and `api.github.com` (verified: 403 CONNECT for example.com, reddit, congress.gov, api.usaspending.gov; `WebFetch` is blocked too) | I cannot develop or test against any live third-party API from this session. Any ingestion must run in **GitHub Actions**, which has open network, and be debugged through CI logs. |
| No payment processor, no domain, no email provider | First real dollar requires exactly one human action (see §5). Not skippable — revenue legally requires an identity behind it. |
| "As little ongoing involvement from the owner as possible" | Disqualifies anything with a sales motion, onboarding calls, or manual fulfilment. B2B SaaS to SMBs is **not** low-involvement, regardless of margin. |
| Distribution cannot depend on the owner | Leaves organic search and marketplaces. Rules out cold outreach and audience-building. |
| I can schedule myself (`create_trigger` / `send_later`) | Maintenance work can fall on *me*, not the owner. This makes otherwise maintenance-heavy data products viable. |

The egress constraint is the single biggest finding. It means "build fast, iterate
against real data" is not available; the build loop is push → Actions run → read logs.

---

## 1. Candidates considered

### A. Congressional stock-trade alerts — **rejected**
The obvious idea given this repo (House PTR/PFD ingestion already exists).

**Demand:** real. Quiver Quantitative sells API access from ~$25–30/mo (hobbyist,
billed annually) up to $75/mo+ for lobbying/insider tiers. Unusual Whales is
~$50–99/mo with congressional alerts bundled into its options-flow product.

**Disproof (decisive):** Capitol Trades gives the same STOCK Act disclosures away
free, and Congress.gov/House Clerk are the free primary sources. The category is
commoditised from below (free) and from above (bundled into products people
already pay for). A new entrant has no wedge and no pricing power.

### B. Congressional / lobbying **data API** — rejected
Same underlying repo asset, sold to developers rather than traders.

**Disproof:** the buyers who want bulk data (academics, students, journalists)
have no budget, and bulk datasets leak instantly — one buyer can republish the
file. The buyers with budget already pay Quiver or an enterprise vendor.

### C. Legislative tracking for small orgs — rejected
**Demand:** real and large. Quorum and FiscalNote are custom-quote enterprise;
POLITICO Pro is a professional policy-intelligence subscription.

**Disproof:** the affordable tier already exists and is well served — Plural from
$59/mo, LegiScan free, LegiStorm and Congress Plus positioned explicitly as the
cheap alternative. Entering means competing on price against funded incumbents,
with a nonprofit/association sales cycle. Fails the low-involvement test twice.

### D. Grant discovery for small nonprofits — rejected (close second)
**Demand:** strongly evidenced. Instrumentl is $299/mo (Discover, annual) rising
to $999/mo; Foundation Directory annual plans were $1,599 as of May 2024.
Commentary is consistent that $300–$1,000/mo is unjustifiable for orgs without
dedicated grant staff, i.e. a real priced-out segment.

**Disproof:** Grant Gopher already exists *specifically* to serve the priced-out
segment, Foundation Directory is free at public libraries nationwide, and
nonprofits are the most price-sensitive, highest-support buyer in this list.
Good market, bad buyer for a zero-involvement product.

### E. Federal contract-opportunity intelligence for small business — **selected**
See §2.

---

## 2. Selected: GovCon opportunity intelligence

**The gap is a pricing gap, and it is unusually wide and well documented:**

- SAM.gov is free, mandatory (agencies must advertise contracts over $25,000
  there), and widely described as hard to search.
- The paid tier jumps straight to enterprise: HigherGov ~$150–500/mo,
  GovWin IQ $12,000+/yr, Bloomberg Government $500+/mo.
- Guidance aimed at small businesses lands on a budget of **$0–$99/mo**, and is
  explicit that $500+/mo platforms are rarely cost-effective under ~$5M revenue.

So: a free, mandatory, clumsy source at $0; a capable source at $6k–12k/yr; and a
large population of SAM-registered small businesses in between.

**Independent confirmation that the pain is paid for today:** businesses hire
freelancers to do this by hand. Fiverr carries a standing category of government
bid-search, RFP/RFQ response and capability-statement gigs. When people pay
humans monthly to run searches, the search itself is the unmet product.

**Why the data is actually obtainable despite my constraints:** the SAM.gov
*public API* is useless for this (10 requests/day on a public key), but SAM.gov
publishes **public bulk data extracts that need no account, no API key, and carry
no quota**. That is the intended path for consuming the data at scale, and it is
a perfect fit for a nightly GitHub Actions job.

**Why maintenance is genuinely low:** ingestion is a cron job in Actions,
publication is a static site on Pages. No servers, no database to operate, no
per-request cost. Infra cost is $0 and stays $0.

**Why it does not touch CivicLens's integrity rules:** contract award and
solicitation data is factual procurement record. It makes no claim about any
named individual, so ADR 0001's neutrality/no-LLM-on-public-render regime and the
ADR 0003 confirmatory-analysis governance are not implicated. It is kept in a
separate `ventures/` tree and must not reuse CivicLens's Pages deployment.

### Honest disproof attempt against E

I tried to kill this one too. What survives:

- **It is not an empty field.** SAM.gov Hunter ($0–119/mo), Gov Contract Finder
  and similar low-end tools exist, and several sites ranking for these terms are
  thin SEO plays. *Counter:* the buyer population is large and the incumbents at
  the low end are mostly thin; the defensible wedge is data quality and free
  depth, not being first.
- **SEO is a slow channel.** Realistic time-to-first-revenue is months, not days,
  and 2026 search is hostile to new thin sites. *This is the main risk and it is
  not fully mitigated.* Mitigation is depth: pages that answer a specific query
  with real data beat generated filler.
- **Blind development.** I cannot see the data from here, so v1 correctness has
  to be established in CI. Mitigation: verify the extract in Actions first, before
  building anything on top of assumptions about its shape.

### What would falsify the whole thesis

If the SAM.gov public extract turns out to require authentication, or to omit the
fields needed for useful filtering, the ingestion premise collapses and E should be
abandoned rather than patched. **This is checked first, before any product code.**

---

## 3. Sources

- Quiver / Unusual Whales / Capitol Trades pricing — unusualwhales.com guides, kapitol.ai, tradercongress.com comparisons
- GovCon tooling pricing and the $0–99/mo small-business budget — govcontractfinder.com, jorpex.com, samgov-hunter.com, SBA
- SAM.gov mandatory posting threshold and search experience — sam.gov, govconchamber.com
- SAM.gov API rate limits + no-key public bulk extracts — api.sam.gov/docs/rate-limits, open.gsa.gov get-opportunities-public-api, boringdataplatform.com, govtrove.com
- Grant database pricing — instrumentl.com, fundingforgood.org, councilofnonprofits.org, zeffy.com
- Legislative tracking pricing — quorum.us, fiscalnote.com, legistorm.com, thesoftedge.com
- Freelance demand for manual bid search — fiverr.com government-contract and bidding categories

Search results in this space are heavily polluted by vendor marketing and
AI-generated listicles. Pricing figures above are the ones that recurred across
independent sources; treat any single figure as approximate.

---

## 4. Decision

Build **E**, smallest useful version, in this order:

1. Verify the SAM.gov public extract in GitHub Actions. **Stop if it fails.**
2. Normalise to clean JSON, committed to the repo.
3. Static search + programmatic landing pages, GitHub Pages.
4. Instrument, then measure before adding a paid tier.

## 5. What requires the owner (and only this)

Deferred until there is a demand signal, so none of it is spent on a guess:

- a payment processor account (Stripe) — required for any revenue at all
- a domain, if we want one that isn't `*.github.io`
- an email/ESP account, if alerts become the paid feature
- a decision on whether this deploys under a **separate repo**, since it must not
  take over CivicLens's own Pages site
