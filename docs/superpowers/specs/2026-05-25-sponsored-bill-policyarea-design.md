# Sponsored-bill policyArea — authoritative loader for the donor-sector detector

**Date:** 2026-05-25
**Status:** Design agreed (core decisions locked); 2 open questions to resolve at start of implementation session.

## Problem

The `donor-sector-vote-alignment` detector keys on bills a member **sponsored**
(`bills.sponsor_role='sponsor'` → `bill_subjects` → `theme_bill_match`). But
`bill_subjects` is only populated by `load-bill-subjects.ts`, which fetches
subjects **only for bills referenced by the `votes` table** (`SELECT DISTINCT
v.bill_id FROM votes`). Sponsored bills that never got a recorded floor vote get
**no `bill_subjects` row**, so they can never match a theme.

Concrete failure: **mike-turner** (the trigger for this work). His donor money is
#1-concentrated in Defense & Aerospace ($218k, loaded 2026-05-25), and he
authored 44 Armed-Forces-policy bills (Intelligence Authorization Acts FY24/FY25,
FISA Reform, …), yet he produces **no** donor-sector hit — purely because his
171 sponsored bills have **0** `bill_subjects` rows.

### Evidence gathered during grilling (so the next session needn't re-derive)
- `bill_subjects` ≈ `votes` bills: 1,266 vs 1,267. Confirms subjects come only from the voted-bill path.
- Roster-wide: 2,725 sponsor rows; only **52** are also in `votes`; exactly **52** have subjects. The overlap *is* the entire current subject coverage of sponsored bills.
- Even the existing 6 hit members have only 2–5 subject-tagged sponsored bills. The detector runs near-blind on its own spine.
- Sponsor rows are **LLM-sourced**: Grok-3 researcher → `researcher.json` bills[] → `load-from-tasks.ts:175`. There is no Congress.gov loader for sponsored bills. The model decides `sponsorRole`.
- Turner: `bills` has **171** sponsor rows; the Congress.gov `/member/{bio}/sponsored-legislation` endpoint returns **192**. LLM under-collected.
- BUT **40 of 44** of Turner's authoritative defense bills are already present in `bills`; the 4 missing are all `hres`, which the detector excludes anyway (it counts only hr/s/hjres/sjres). So the fix is mostly **enrichment** (attach policyArea), not adding bills.
- `policyArea` is available inline in the sponsored-legislation **list** response (e.g. "Armed Forces and National Security", "Taxation") — no per-bill call needed. Granular `legislativeSubjects` are NOT in the list (those need the per-bill `/subjects` endpoint or GPO BILLSTATUS bulk — deferred).
- bill_id format: cosponsored loader builds `${congress}/${typeLower}/${number}` (slash, e.g. `119/hr/2164`). A parallel sponsored loader produces the same — no dup-format rows.
- The trade-vote detector reads `v_suspicious_trades`/nexus views, not raw `bill_subjects` for sponsored bills — so it is unaffected by this change.

## Decisions (locked)

1. **(A) Build `db/load-sponsored.ts`** — a dedicated deterministic loader paralleling `load-cosponsored.ts`. Hits Congress.gov `/member/{bioguide}/sponsored-legislation` (paginated, limit 250), UA `CivicLens/1.0 (research)`, `CONGRESS_API_KEY` from `~/.hermes/.env`. Replaces the LLM-fabricated sponsor list with primary-source data (primary-sources-only rule). ~1 list call/member, no per-bill fetches — cheap.

2. **(i) Store `policyArea` in `bill_subjects`** as `(bill_id, policy_area=X, subject=X)`. The detector's existing join works with **zero detector changes** — this mirrors `load-bill-subjects.ts:77` (policyArea-as-subject fallback). Near-zero interaction risk: the only collision surface is the 52 voted bills, which already have subjects (ON CONFLICT no-op); the other ~2,670 sponsored bills are never touched by the voted-bill loader. Accepted harmless side effect: a policyArea stored as subject can also match a `subject_pattern` ILIKE in the **same** theme (dedupes).

3. **(a) Overwrite existing rows** — `ON CONFLICT (member_id, bill_id) DO UPDATE`: set title/status/introduced_at/sponsor_role from Congress.gov, and insert the bills the LLM missed. Authoritative data wins. Safe: a member's sponsored set is disjoint from their cosponsored set (you don't cosponsor your own bill), so it cannot clobber authoritative cosponsor rows.

4. **No OpenSecrets display section.** The donor-industry breakdown stays internal detector substrate only — never republished on the site (OpenSecrets terms + primary-source rule). A *visible* funding-by-industry section would require building our own classifier from FEC primary data (deferred FEC employer/occupation tier), not OpenSecrets labels.

## Durability constraint (must honor in wiring)

`load-from-tasks.ts:173` uses **`INSERT OR REPLACE INTO bills`** — re-running the
full pipeline on a member would clobber authoritative sponsor rows with LLM data
again. Therefore `load-sponsored.ts` MUST run **after** `load-from-tasks` in any
sequence; it is a post-research enrichment loader (like cosponsored / bill-subjects).

## Open questions (resolve at start of implementation session)

- **Q5 — scope/sequencing.** Recommended: smoke-test `mike-turner` first (loader → `run-patterns --member mike-turner` → confirm the Defense hit appears end-to-end), *then* roster-wide `--all`. Matches civiclens-core "smoke-test one politician first." Implies the loader needs an optional `--member <slug>` flag.
- **Q6 — pipeline wiring.** Recommended: expose as `--load-sponsored` flag on `agents/pipeline.ts` (most loaders are; better discoverability than the standalone `load-cosponsored`), and document the run-after-`load-from-tasks` ordering. Confirm whether to also wire it into any automated sequence or keep it manual.

## Expected outcome / validation

After running for Turner: he should produce a `donor-sector-vote-alignment` hit
on **Defense & Aerospace** (his #1 donor theme, $218k; 40 qualifying authored
defense bills) — likely the strongest hit on the board. Roster-wide, total
credible hits should rise from the current 6 as other members' authored bills
gain policy areas. Existing 6 hits must not regress (their join path is untouched).

## Out of scope

- OpenSecrets bulk-data migration (replacing the Cloudflare scrape) — separate future decision.
- Granular `legislativeSubjects` via GPO BILLSTATUS bulk (Tier 2) — only if policy-area matching proves insufficient.
- Any visible donor-industry / bills-by-policy-area site section.
