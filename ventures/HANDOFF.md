# Handoff — what is done, what needs you, what happens next

**Date:** 2026-09-21

---

## Done, autonomously, and verified

- **Researched and compared five opportunities**, with sources and explicit
  disproofs — `OPPORTUNITY-ANALYSIS.md`. Four were killed on evidence, including
  the one this repo made most tempting (congressional trade alerts).
- **Ran the falsification test first.** The thesis depended on the SAM.gov public
  extract being usable without credentials. A read-only probe on a GitHub runner
  confirmed it: no key, no quota, and it carries NAICS, set-aside, deadline,
  place of performance, agency and contact.
- **Built the ingestion and the site**, tested, and ran both against the live
  feed: 81,512 notices parsed with **zero malformed rows**, filtered to **4,208**
  open set-aside opportunities.
- **Kept it clear of CivicLens.** No pipeline, DuckDB or render code is touched,
  and the venture does not use CivicLens's Pages deployment.

## What needs you

Deliberately short, and deliberately deferred until the thing was real.

### 1. Where it deploys — the one blocking decision

The site must not go on CivicLens's Pages: ADR 0002 keeps that deployment
dormant and manual, and a commercial product does not belong at that URL under
that project's name. So it needs a **separate public repository** (public is
required for free Pages). I have not created one, because my instructions for
this session pin me to this repo and branch, and publishing a site under your
account is outward-facing.

Say the word and I will create it, move `ventures/govcon/` across, enable Pages
and deploy. Everything else is ready — `deploy-pages.yml.template` is the
finished workflow.

### 2. Later, and only if the traffic justifies it

Not needed to launch. Do not spend on these yet.

| Thing | Why | When |
|---|---|---|
| Domain | `*.github.io` ranks worse and reads as a hobby project | once there is any organic traffic |
| Email provider | alerts are the paid feature; the signup form is wired but gated behind an unset endpoint so it cannot silently drop addresses | before charging |
| Stripe | revenue legally needs an identity behind it | when there are people to charge |
| Analytics | Pages gives no server logs, so "measure results" needs a third party | at deploy, ideally |

## Honest expectations

**This is a slow asset, not a fast one.** The realistic path to first revenue is
months, and it runs through search. I am not going to dress that up:

- Distribution without your involvement is essentially SEO plus being genuinely
  better than the alternatives. The site ships ~300 stable, data-backed pages,
  which is a real surface — but new sites rank slowly, and 2026 search is hostile
  to thin ones.
- The channels that would be *fast* — posting in r/govcon, LinkedIn groups, APEX
  Accelerator resource lists — need a human identity. I am not going to post as
  you, and an undisclosed bot pitching a product in those communities would be
  both dishonest and counterproductive.
- The category is not empty. SAM.gov Hunter and similar sit at $0–119/mo. The
  bet is quality and free depth, not novelty.

**What is genuinely good about it:** $0 to run and nothing to administer, so it
costs nothing to let it sit and compound. It cannot fail expensively.

## Monetisation, when the time comes

Free search stays free — paywalling data the government publishes is both wrong
and weak positioning. The paid tier is **daily email alerts** for a saved NAICS
+ state + programme combination, which is the thing people currently pay
freelancers to do by hand. Somewhere around $19–29/mo, self-serve, no sales
call. Deadline-driven, so the value is obvious and recurring.

Gate the decision on evidence: **do not build alerts until the free site shows
real search traffic.** If nobody arrives, the alerts have nobody to alert, and
the right move is to stop rather than to spend.

## What I would do next, unprompted, once deployed

1. Wire analytics and let it sit for a few weeks.
2. Watch which facet pages attract impressions, and deepen those rather than
   adding more.
3. Add an alerts waitlist once there is traffic to convert.
4. Report back with numbers — including if the numbers say to kill it.
