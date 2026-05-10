# CivicLens — Pattern Discovery v2

**Date:** 2026-05-09
**Status:** Design (pre-implementation)
**Owner:** duckjustice
**Scope:** Build the first version of the named-pattern library that populates the "Patterns detected" placeholder section on member profiles, and ship a roster-wide pattern visualization at `/patterns`. Hypothesis-driven detectors only in v1; graph-based discovery is a later project.

---

## Why

The 2026-05-03 profile redesign left an explicit placeholder: *"Pattern detection coming soon."* The redesign spec named Pattern Discovery as future project #1 and called district-level data the underused piece. v2 makes that placeholder real for one vertical slice — four detectors against existing data plus one new district-level source — and gives the project its first cross-member view.

CivicLens already computes anomaly-adjacent scores in `agents/trade-analyst.ts` and `agents/revolving-door.ts`. The substrate exists; this spec turns those numbers into named, reader-verifiable findings.

## Editorial constraints (non-negotiable)

Inherited from civiclens-core. Any decision in this spec defers to them.

- **Neutral framing.** No moralizing. Each pattern is named for what it *is*, not what it implies. Counts and dates speak; the reader judges.
- **Reader verification.** Every pattern hit cites the underlying rows the reader can click through to inspect. No interpretation column.
- **Primary sources only.** No stub data. If a member has no hits, the section is empty (or shows a small "No patterns detected" line). No fabricated patterns.
- **No red.** Intensity surfaces through weight, opacity, density, and size — never through color affect that codes "bad."
- **Source-first.** USAspending samples frozen to `SOURCES.md` before the fetcher is written.

## v1 detector set

Four detectors. Each is one file under `pipeline/patterns/<detector>.ts`. Each exports `{name, description, detect(memberData) → PatternHit[]}`.

1. **`trade-vote-alignment`** — trade in sector X within ±14 days of a vote on a bill touching sector X. Wraps the existing `trade-analyst` pair score with an explicit threshold and a named-pattern envelope.

2. **`donor-sector-vote-alignment`** — top donor sector matches the sector of bills the member sponsors or votes on at unusually high rates. Uses the existing donor sector classification + bill subject tags.

3. **`spousal-trade-timing`** — trades flagged `spouse` or `joint` clustering within tight windows of related committee activity. Distinct detector because spousal disclosure rules differ and the timing window behaves differently from member-direct trades.

4. **`district-contracts-vote-alignment`** — USAspending federal contract awards in the member's district correlate with their committee membership or recent votes. This is the district-level vertical slice. Smallest and least mature of the four; expect calibration churn.

The Predictor agent is **not** wired into Patterns per civiclens-core skip-by-default rule.

## Architecture

### Where pattern detection runs

**Separate pass after the agent pipeline.** A new script `pipeline/run-patterns.ts` reads from DuckDB after the agent pipeline finishes for a member (or for the whole roster), runs each detector, and writes results to a new `pattern_hits` table. Site rebuild reads from there.

**Why separate pass:**
- Detector logic changes don't trigger a full Grok-3 researcher rerun.
- Cross-member queries (e.g., "all spousal-trade hits across roster") become a SQL query, not a per-member render-time loop.
- Detectors can be re-run independently when thresholds get tuned.
- Keeps `agents/pipeline.ts` lean and matches its existing one-job-per-agent shape conceptually without adding a real pipeline agent.

### Detector contract

```ts
// pipeline/patterns/types.ts
export interface PatternHit {
  pattern: string;          // detector name, e.g. "trade-vote-alignment"
  member: string;           // member slug (e.g., "marjorie-taylor-greene")
  finding: string;          // ONE neutral sentence. No moralizing words.
  intensity: number;        // 0..1, used for visual weight only
  citing: CitedRow[];       // rows the reader can click through
  dates: string[];          // ISO dates relevant to the hit
  detectedAt: string;       // ISO timestamp of detection
}

export interface CitedRow {
  kind: "trade" | "vote" | "bill" | "donor" | "contract" | "ie";
  id: string;               // row id within its source table
  label: string;             // short human label for the row
}

export interface PatternDetector {
  name: string;
  description: string;
  detect(memberSlug: string): Promise<PatternHit[]>;
}
```

Each detector is a single file in `pipeline/patterns/<name>.ts` exporting a `PatternDetector`. `pipeline/run-patterns.ts` imports the registry, runs each detector for a member (or the whole roster), and upserts hits into `pattern_hits`.

### Schema

New DuckDB table `pattern_hits`:

```sql
CREATE TABLE pattern_hits (
  pattern         TEXT NOT NULL,
  member          TEXT NOT NULL,
  finding         TEXT NOT NULL,
  intensity       DOUBLE NOT NULL,
  citing_json     TEXT NOT NULL,   -- JSON array of CitedRow
  dates_json      TEXT NOT NULL,   -- JSON array of ISO dates
  detected_at     TIMESTAMP NOT NULL,
  PRIMARY KEY (pattern, member, dates_json)
);
CREATE INDEX idx_pattern_hits_member ON pattern_hits(member);
CREATE INDEX idx_pattern_hits_pattern ON pattern_hits(pattern);
```

`citing_json` and `dates_json` are JSON columns rather than separate tables because the read pattern is "give me all hits for member X" and the citing rows are read together with the hit. Promote to relational if cross-citing-row queries appear.

### USAspending ingestion (district-level data)

New file `lib/usaspending.ts` (mirrors `lib/fec-ie.ts`):

- Source: `api.usaspending.gov` — federal contract awards.
- Cache: `pfd-cache/usaspending/<state>-<district>/<page>.json`. Raw API responses preserved per existing pattern.
- Loader: `db/load-usaspending.ts` reads the cache, normalizes into DuckDB.
- **Source-first.** Probe live, freeze samples to `SOURCES.md` BEFORE writing the fetcher. Add Zod schema in `lib/schemas.ts`.

### Render layer

**Profile page** (`render/build.ts`):
- Replace `renderPatternsPlaceholder()` with `renderPatterns(memberSlug)`.
- Each hit renders as a card: pattern name, the one-sentence neutral finding, the dates and counts, inline links to the citing rows already on the page.
- If a member has zero hits, render a single muted line: *"No patterns detected at current thresholds."* No fake hits, no "coming soon."
- Cards stack vertically; ordering by `intensity DESC, detected_at DESC`.
- No new client JS. Static HTML, inline CSS, consistent with the rest of the page.

**`/patterns` page** (new file `render/patterns-page.ts`, emits `site/patterns.html`):
- Roster-wide force-directed graph. Nodes = members + pattern-types + frequently-co-occurring entities (donors, PACs, sectors). Edges = pattern hits linking them.
- Intensity surfaces through edge thickness, node size, and opacity. **No red.** Single accent color or grayscale + one accent.
- Time slider: edges appear/disappear by `dates` window. Especially useful for spousal-trade-timing which is fundamentally about *when*.
- Click a node: highlights connected hits and opens a side panel listing them with citing rows.
- SVG export button (no PNG — SVG is journalism-friendly and zooms cleanly).
- Built with d3-force. d3 is a new dependency for the project; tracked as a one-line note in the spec, not a side effect.
- Graph is rendered server-side as inline SVG with embedded JSON of hits and a small inline script for the slider + click handler. No build step, no framework, no bundler.

### Files touched / created

- `pipeline/patterns/types.ts` (new) — `PatternHit`, `PatternDetector` interfaces.
- `pipeline/patterns/trade-vote-alignment.ts` (new)
- `pipeline/patterns/donor-sector-vote-alignment.ts` (new)
- `pipeline/patterns/spousal-trade-timing.ts` (new)
- `pipeline/patterns/district-contracts-vote-alignment.ts` (new)
- `pipeline/patterns/registry.ts` (new) — array export of all detectors.
- `pipeline/run-patterns.ts` (new) — entry point. Args: `--member <slug>` or `--all`.
- `db/migrate-pattern-hits.ts` (new) — creates `pattern_hits` table.
- `lib/usaspending.ts` (new) — fetcher.
- `db/load-usaspending.ts` (new) — loader from cache to DuckDB.
- `lib/schemas.ts` — add USAspending Zod schemas.
- `lib/types.ts` — add `PatternHit`, `CitedRow`, USAspending types.
- `SOURCES.md` — new entry: USAspending API, with frozen sample payload.
- `render/build.ts` — replace `renderPatternsPlaceholder()` with real `renderPatterns(memberSlug)`.
- `render/patterns-page.ts` (new) — emits `site/patterns.html`.

### Files explicitly NOT touched

- `agents/pipeline.ts` — no new agent in the pipeline order.
- Existing agent prompts.
- Existing site pages other than per-member profiles and the new `/patterns` page.

## Visual language for `/patterns`

- Grayscale base. Single accent color (TBD in the visual identity pass — definitely not red, definitely not partisan blue/red).
- Node size scales with hit count or member activity, not with "badness."
- Edge thickness scales with `intensity`. Faint edges are quiet hits; thick edges are loud hits.
- No labels like "suspicious" or "corruption." Section title is *"Patterns across the roster."* Pattern type names are mechanical (e.g., "Trade ↔ vote alignment"), not pejorative.
- Time slider control bar at the top. Default state: full window. Dragging a window narrows the visible edges by hit dates.

## Testing

Per civiclens-core checklist:

- Smoke test on MTG (gold standard). Run all four detectors, confirm hits exist, click through to citing rows, confirm citing rows actually exist on her profile.
- Manually inspect `/patterns` page across the 36 roster members.
- Confirm zero-hit members render the muted "No patterns detected" line, not a fake card.
- Re-run full pipeline on MTG to confirm patterns surface end-to-end through the agent pipeline + the new patterns pass.
- Run pattern pass on full roster only after MTG passes.

Threshold tuning is expected to be iterative. Document baseline thresholds in each detector file with a one-line comment explaining the choice.

## Decision log

- **Detectors as TS modules, one per file.** Matches existing `agents/<name>.ts` shape; readable in isolation; richer return type than SQL views; pushdown to SQL views available later if profiling demands it. Hybrid SQL+TS rejected as premature complexity.
- **Separate post-pipeline pass over inline-agent.** Detector iteration must not trigger Grok-3 reruns. Cross-member queries motivated a real persistence table.
- **Per-member cards on profile, force graph at roster scale.** A force layout earns its keep where the web has real edges (shared donors/PACs across members). On a single profile, cards verify faster and stay mobile-friendly.
- **No red, no "corruption map" framing.** Editorial spine — color affect would tell the reader the answer before they read.
- **JSON cache before DB load for USAspending.** Matches existing FEC IE / Congress.gov / PFD pattern; preserves raw payload for source-first verification.
- **No client JS framework on profile page.** Inline SVG + tiny inline `<script>` on `/patterns` only.
- **d3 added as a new dependency** — only on `/patterns`. Profile page render unchanged dependency-wise.

## Out of scope (tracked, not v1)

- Graph-based discovery (unsupervised pattern mining). v1 is hypothesis-driven only.
- Donor → Super PAC → ad spend chains.
- Bundler inference from clustered donations.
- Sector concentration over time.
- Revolving-door integration into Patterns (data quality not yet acceptable).
- Whole-picture view (project #6 from the redesign spec) — `/patterns` is the prototype substrate.
- Visualization gallery — separate project.
- Additional district-level sources (FEMA, BLS) beyond USAspending.
- Engagement-driven UX additions (highlight glows, sound, animation flourishes). Editorial neutrality forbids them.

## Open follow-ups (post-v1)

- Calibrate intensity thresholds across detectors so visual weight is comparable.
- Decide whether USAspending district lookup is keyed by current district only or includes redistricting history. Current scope: current district only.
- Consider promoting `citing_json` to a relational `pattern_hit_citations` table once cross-citation queries become useful.
