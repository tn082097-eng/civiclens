# CivicLens — Member Profile Page Redesign

**Date:** 2026-05-03
**Status:** Design (pre-implementation)
**Owner:** duckjustice
**Scope:** Redesign the per-member profile page rendered by `render/build.ts`. Companion future projects are listed at the end but are NOT in scope for this spec.

---

## Why

The current member profile page (e.g., `site/members/marjorie-taylor-greene.html`) is ~64,000 pixels tall, prose-heavy, and dumps every trade-bill row into a single flat table. There is no scannable summary, no visual hierarchy, and the framing leans toward implication rather than fact. CivicLens's editorial principle is "before, not after" — show the data plainly, let readers draw conclusions. The current page does the opposite.

The profile page is the most-read surface on the site. Citizens unfamiliar with politics, journalists, and political insiders all land here. The redesign needs to serve all three without picking a tribe.

## Editorial constraints (non-negotiable)

These come from the CivicLens core skill. Any decision in this spec defers to them.

- **Neutral framing.** No moralizing words ("suspicious", "shady"). Counts and dates speak; the reader judges.
- **Primary sources only.** No stub data, no LLM-generated placeholders. If a section's data isn't available for a member, the section is hidden, not faked.
- **Source-first workflow.** Probe live, freeze samples to `SOURCES.md` before building any new agent or fetcher.
- **Skip predictor.** Predictor agent output is not displayed unless the user explicitly requests it.

## Sections (final layout, top to bottom)

1. **Identity card** — name, party, chamber, state, district, tenure, committee assignments. Compact. Above the fold.

2. **Activity at a glance** — a small grid of plain numbers. No labels like "score" or "risk." Cells:
   - Total trades (current 2-year election cycle)
   - Total trade volume (USD, current cycle)
   - Votes cast (current Congress)
   - Bills sponsored (current Congress)
   - Top donor sector (one word)
   - Trades within 14 days of related votes (count only — no judgment)

3. **Timeline** — chronological ribbon merging trades, votes, donations, and Super PAC activity. Same time axis. Filterable by event type. Already partly implemented from the 2026-04-27 work; needs visual treatment to be the primary navigation surface for the page.

4. **Trades & bills table** — option-3 detail level (settled in earlier brainstorm). Each trade row links to the related bill row(s) within ±14 days, with raw dates side-by-side. No interpretation column.

5. **Donors** — top donor sectors and top named individual contributors with amounts. FEC individual contributions only. Clearly scoped: this is money given *to* the candidate's committee, capped and disclosed per donor.

6. **Outside spending (Super PACs)** — separate section from Donors, with explicit framing that this is independent expenditure, uncapped, and not coordinated with the candidate. Two sub-blocks:
   - Supporting Super PACs — committees with positive independent expenditures for this member; total + top 3 by spend
   - Opposing Super PACs — committees with negative IE against this member; total + top 3 by spend
   - Each PAC row shows top funders behind that PAC where data is available (FEC Schedule A on the recipient committee).
   - Data source: FEC `/schedules/schedule_e/` filtered by `candidate_id`; funders via `/schedules/schedule_a/` filtered by recipient committee.

7. **Co-sponsorship (embedded)** — small embedded version of the existing co-sponsorship network, links out to the full network page.

8. **Patterns detected** — placeholder section. Empty for v1; populated later by the Pattern Discovery project (out of scope here). Stub the section with a note: "Pattern detection coming soon — see /about for methodology when published."

## Explicitly NOT included in v1

- **Lobbying section.** Data thinness in current pipeline. Revisit when the revolving-door agent matures.
- **Standalone "suspicion score."** Counts and dates carry the signal; a synthesized score introduces interpretation we don't want.
- **Predictor output.** Per core skill, only render on explicit request.

## Visual research seed: intensity-mapped rendering

A separate research thread, scoped narrowly into v1 so it doesn't bloat the redesign.

**Idea:** the visual weight of any element on the page reflects how anomalous that fact is relative to a baseline, not how important the section is in the layout. Quiet members render quiet pages. Members with anomalies (e.g., spouse trade 6 days before a vote against the same sector) get visual loudness on that specific element — contrast, density, weight — without any text saying "this is suspicious."

**Why it belongs in this spec:** because we already compute anomaly-adjacent scores (`agents/revolving-door.ts`, suspicion scoring on trade-vote pairs). The substrate exists; we just need to surface it visually instead of textually.

**Scope for v1:**
- Pick one section (Trades & bills table is the natural candidate) and apply intensity-mapped rendering: row visual weight = anomaly score for that pair.
- Crude is fine. This is a research artifact, not a feature. Document what worked / didn't in a follow-up note for project iteration.

**Out of scope for v1:** rendering every section by intensity, building a full visual language, or designing a "member glyph."

## Visualization gallery (separate page, deferred)

A standalone `/gallery` page where data is rendered into abstract visual forms with no analytical purpose. Each data category gets an assigned visual element (bills as threads, members as nodes, money as flow, votes as pulses, committees as fields), and compositions emerge from how the assigned elements interact.

**This is not part of v1.** Listed here so it isn't forgotten. Build after the profile redesign ships.

## Architecture

### Data flow

No new pipeline agents are required for v1. All data is already produced by the existing pipeline:

- Identity, votes, bills, co-sponsorship → existing pipeline output
- Trades, trade-vote pairs → existing Trade Analyst agent
- Donors → existing FEC integration
- **Super PACs → NEW data fetch needed.** Add an FEC IE fetcher in `lib/fec.ts` (or a new `lib/fec-ie.ts`) that pulls Schedule E filings by `candidate_id` and Schedule A funders for those committees. Cache responses to `pfd-cache/` per existing pattern. Document samples in `SOURCES.md` BEFORE writing the fetcher (source-first workflow).

### Render layer

- Modify `render/build.ts` to emit the new section structure.
- Each section is a separate render function that receives the member's data slice and returns HTML. Sections that have no data return null and are omitted from the page.
- Keep existing inline CSS approach; no framework introduction.
- Intensity-mapped rendering for the Trades & bills table: each row gets an `intensity` class (low/med/high) computed from the existing pair anomaly score. CSS controls weight, contrast, padding density.

### Files touched

- `render/build.ts` — section reorganization, new render functions
- `lib/fec.ts` or new `lib/fec-ie.ts` — Super PAC IE fetcher (new)
- `SOURCES.md` — document FEC Schedule E + Schedule A sample payloads (new entries)
- `lib/types.ts` — add types for IE filings and Super PAC funder summaries
- `lib/schemas.ts` — Zod schemas for the new FEC endpoints
- Member rendering uses the existing DuckDB-backed data; new IE data lands in DuckDB via standard sync

### Files NOT touched

- `agents/pipeline.ts` — no new agent, no new pipeline order changes
- `agents/*.ts` — no agent prompt changes
- Existing site pages other than the profile page

## Testing

Per civiclens-core checklist:
- Smoke test on MTG (gold standard).
- Re-run full pipeline on MTG to confirm end-to-end.
- Run 20-member batch only after MTG smoke test passes.
- Manually inspect rendered pages for: section omission when data missing, no fake data, neutral language throughout, intensity rendering producing visible-but-not-overwhelming differentiation.

## Future deepening (separate projects, not v1)

These came up during brainstorm and are recorded so they aren't lost:

1. **Pattern Discovery** (project #2) — discovery-driven cross-source pattern detection. Hypothesis-driven library of named patterns first (votes ↔ donors ↔ spousal trades ↔ district events), graph-based discovery later. District-level data is the underused piece (USAspending federal contracts by district, FEMA, BLS by district).
2. **Donor → Super PAC → ad spend chains** (the dark-money trail).
3. **Bundler inference** from clustered donations.
4. **Sector concentration over time** — is a member's funding base shifting?
5. **Revolving-door integration** — surface `agents/revolving-door.ts` output once data quality is acceptable.
6. **Whole-picture view** — landing visualization where Congress is the subject and members are marks within it. Same intensity language at country/member zoom levels.
7. **Visualization gallery** — standalone abstract-rendering section, no analytical purpose.

## Decision log

- **"Suspicion summary card" rejected** — violates neutrality rule from civiclens-core skill. Replaced with "Activity at a glance" (raw counts).
- **Lobbying section deferred** — data quality not sufficient yet.
- **Predictor output excluded** — per core skill, only on explicit request.
- **Visual language / member glyph deferred** — too large for v1; intensity-mapped rendering is the seed that grows toward it.
- **Whole-picture inversion deferred** — promising but not v1; tracked as future project #6.
- **Visualization gallery deferred** — standalone, no dependencies; build after v1 ships.
