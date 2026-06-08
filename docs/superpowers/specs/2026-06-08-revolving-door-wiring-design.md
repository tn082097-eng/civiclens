# Wire Revolving-Door into Render (deterministic) — Design

**Date:** 2026-06-08
**Status:** approved (brainstorming)
**Scope:** Phase 2, slice 1 of N. This spec covers *only* surfacing revolving-door
data on member profiles and deleting the now-redundant agent. Other Phase 2 cleanups
(Connection Mapper → SQL, `brain`/`brainLog` removal, enum reconciliation, declarative
stage list) are separate slices, out of scope here.

---

## Problem

`agents/revolving-door.ts` matches a member to LDA (lobbying disclosure) registrants whose
disclosed *former government role* (`covered_position`) names that member or their committee
— i.e. former staffers who now lobby. The matching is **already deterministic SQL** (a
chamber-aware regex over `covered_position` plus a committee-keyword `ILIKE` pass). The only
LLM part is a 3–5 sentence narrative paragraph.

The agent's output (`pipeline/task-*/revolving-door.json`) is **never loaded into DuckDB and
never rendered**. It is a dead-end stage: it runs, burns a Sonnet call, and produces nothing the
public site or vault consumes. Verified: `render/build.ts` queries zero LDA/lobbyist views.

Meanwhile the data is real and meaningful: 469 filings, 688 distinct lobbyists, and **24 of 48
roster members have at least one direct match** (Jason Smith 7, Schumer 5, McConnell 5, …).

## Goal

Make the revolving-door connections **visible on member profiles**, fully deterministically,
and **remove the LLM stage and the agent** — shrinking the pipeline by one stage and one
failure point. No new paradigm; this follows the project's existing "render reads DuckDB" shape.

## Decisions (locked)

1. **Drop the LLM narrative entirely.** The match cards carry the evidence on their own.
2. **Recompute at render time** from the LDA corpus via a new `db/queries.ts` function —
   *not* persisted from a pipeline run. This lights up the whole roster immediately and lets the
   agent be deleted. (Rejected alternative: persist agent output to a new table — couples the
   section to pipeline re-runs, only shows members run after the change.)
3. **Neutral framing.** No "risk" on the site. Recency tiers are relabeled to what they actually
   measure: filing recency. Internal field names may stay; only the reader-facing label changes.
4. **Show both match types**, direct ex-staff leading, committee-staff marked as the secondary/
   weaker tie.
5. **Delete `agents/revolving-door.ts`** and its enum/stage/contract entries.

## Data & query

New deterministic function in `db/queries.ts`, mirroring `findTradesNearVotes` / `cosponsorNetwork`:

```ts
export interface RevolvingConnection {
  lobbyistName: string;
  formerRole: string;          // verbatim covered_position excerpt
  currentEmployer: string | null;   // registrant_name
  latestClient: string | null;
  generalIssues: string | null;
  governmentEntities: string | null;
  latestFilingYear: number;
  latestFilingPeriod: string | null;
  matchType: 'direct' | 'committee';
  recencyTier: 'active' | 'recent' | 'historical';
  sourceUrl: string | null;
}
export async function revolvingDoorConnections(
  memberId: string, name: string, chamber: string | null,
): Promise<RevolvingConnection[]>
```

- Ports the agent's `extractLastName` / `buildDirectMatchPattern` (chamber-aware regex) and the
  committee-keyword `ILIKE` pass verbatim. De-dup: direct wins over committee.
- `recencyTier` = the existing recency computation, renamed: `active` (last filed this year or
  last year), `recent` (≤3 yrs), `historical` (older).
- Reads existing `lda_lobbyists` / `lda_filings` only. **No schema change, no new table.**
- Lives in queries.ts so both render and any future caller share one implementation.

## Render

`render/build.ts` adds a profile section, immediately after `sec-donors`:

- `<h2 id="sec-revolving">Revolving door — former staff now lobbying</h2>` with a one-line,
  neutral intro explaining the data ("Registered lobbyists whose disclosed former role names
  this member or a committee they sit on. Recency reflects the latest filing, not a judgment.").
- One card per connection, mirroring the existing `trade-card` structure and the
  `intensity-low/medium/high` weight classes — mapped from `recencyTier`
  (active→high, recent→medium, historical→low). Each card shows: lobbyist name, former role
  (verbatim, truncated), current firm · client, issue areas, "last filed YYYY (period)", a
  `direct` vs `committee staff` tag, and a source link to `lda.senate.gov`
  (`target="_blank" rel="noopener"`, `escHtml` on all interpolated values).
- Direct matches render before committee matches; a count appears in the section header.
- **Empty state:** if a member has zero connections, the section is omitted entirely (consistent
  with how quiet members render elsewhere).
- No new at-a-glance cells in this slice (keeps scope tight).

## Deletions / pipeline change

- Delete `agents/revolving-door.ts` and `skills/revolving-door/` (if present and unreferenced).
- `agents/pipeline.ts`: remove the `runRevolvingDoor` import, the `detecting-revolving-door`
  stage (and its `setStatus`/warn block), and `'revolving-door'` from the `allFiles` summary list.
- `lib/types.ts`: remove `'revolving-door'` from `AgentName` and `'detecting-revolving-door'`
  from `PipelineStatus`.
- `agents/shared.ts`: drop the `revolving-door` entry in `initTask`.
- `npx tsc --noEmit` after edits to surface every dangling reference.

## Verification

Run from `~/Developer/civiclens`:

1. `npx tsc --noEmit` — clean.
2. `npx tsx render/build.ts` builds green.
3. **Populated member:** open `site/members/jason-smith.html` (7 direct) and
   `site/members/chuck-schumer.html` (5) — the Revolving-door section renders with cards, correct
   recency tiers, working lda.senate.gov source links, and **no "risk" wording**.
4. **Quiet member:** a member with zero matches has **no** revolving-door section.
5. Pattern tests still green: `npx tsx --test pipeline/patterns/*.test.ts`.
6. Pipeline smoke (no revolving stage): `npx tsx agents/pipeline.ts "Nancy Pelosi" --force`
   runs end-to-end with no `detecting-revolving-door` step and no errors.

## Risks

- **Regex false positives** (surname collisions). Mitigated by the existing chamber-aware
  title-before-surname pattern, ported verbatim — no new matching risk introduced.
- **Committee ILIKE noise.** Mitigated by labeling committee matches as the weaker tie and
  leading with direct.
- **Render output changes** for the 24 members with matches (expected — that's the feature).
  Members without matches are byte-unchanged.
