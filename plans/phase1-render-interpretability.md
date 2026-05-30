# Phase 1 — Render-Layer Interpretability (Implementation Plan)

**Status:** SHIPPED & VERIFIED in working tree (`render/build.ts`). This document is the
executable plan of record; the steps below reproduce exactly the edits that were applied.

## Objective

Make existing `pattern_hits` data understandable through the UI alone. No schema, detector,
scoring, or pipeline changes. Deterministic spine untouched. Three deliverables:

1. Structured **flag cards** replacing the `anomalyVerdict` one-liner.
2. **Plain-English confidence phrasing** derived ONLY from existing `pattern_hits` columns.
3. **Homepage interpretability framing** — a "How to read a flag" box + a "Strongest flags" feed.

## Conflict resolution applied

Grok (minimalism / scope containment) wins over the Claude plan's additive-DB-fields and
synthesis-layer proposals. Phase 1 is strictly render-only:

- ❌ NO new DB columns (`mechanism`/`why_summary`/`caveat`/`effect_size`). Mechanism and caveat
  copy live as a **static `Record` in `build.ts`**, keyed by detector name — UI text, not data.
- ❌ NO methodology page, profile synthesis layer, or null-model expansion (later phases).
- ✅ Reuse the existing `.trade-card` intensity tiers (weight-only, no color affect).

## Scope

- **Only file edited:** `render/build.ts`.
- No new files, dependencies, or systems. `db/schema.sql`, `pipeline/patterns/*`,
  `pipeline/score-anomaly.ts`, `agents/pipeline.ts` are NOT touched.
- Columns consumed (all pre-existing on `pattern_hits`): `pattern, member, finding, intensity,
  citing_json, dates_json, null_model, observed, expected, p_value, z_score, n_perm`.

---

## File-by-file steps (order of edits)

### `render/build.ts`

**Edit 1 — CSS (in the `<style>` string, after `.glance-*` rules).**
Add flag-card and homepage classes. No new colors; reuse existing CSS vars:
- `.flag-card .fc-why / .fc-conf / .fc-mech / .fc-stats / .fc-caveat / .fc-evidence` and
  `.fc-evidence .ev-kind`.
- `.how-to-read` container + `ul`/`li` for the homepage box.

**Edit 2 — `StrongestFlag` interface + `fetchStrongestFlags()` (before `buildIndex`).**
Read-only inline-SQL query mirroring `fetchOverview`'s pattern:
```
SELECT ph.pattern, ph.member, m.name AS member_name, ph.intensity, ph.citing_json,
       ph.null_model, ph.observed, ph.expected, ph.p_value, ph.n_perm
  FROM pattern_hits ph JOIN members m ON m.member_id = ph.member
 ORDER BY ph.z_score DESC NULLS LAST, ph.intensity DESC, ph.detected_at DESC
 LIMIT ?            -- default 12
```
Map rows; parse `citing_json` length into `citingCount`; coerce nullable stat columns to
`number | null`.

**Edit 3 — `confidencePhrase()` helper (replaces `anomalyVerdict`).**
Pure function. Input = the stat columns the caller already holds + `citingCount`. Output =
`{ lead: string; stats: string | null }`:
- If `null_model == null || p_value == null` → honest descriptive lead
  (`"Based on N cited record(s); not statistically scored against a null model."`), `stats: null`.
  **Never fabricate statistics.**
- Else build `stats = "observed X vs expected Y under a <null> null · N permutations · p = …"`.
- If `p ≤ 0.05` → lead `"Stands out: about K× more than this member's own trading would
  produce by chance."` (fold = observed/expected when finite).
- Else → `"About what this member's own trading would produce by chance — not flagged as unusual."`

**Edit 4 — `PATTERN_META` static copy `Record` (next to `confidencePhrase`).**
Per-detector `{ mechanism, caveat }` display strings for `trade-vote-alignment`,
`spousal-trade-timing`, `donor-sector-vote-alignment`. Factual, non-accusatory. Detectors
absent from the map simply render without mechanism/caveat lines (graceful).

**Edit 5 — `renderPatterns()` card rendering (replace the old block).**
For each hit: compute `conf = confidencePhrase(...)`, look up `meta = PATTERN_META[pattern]`,
group citing rows into labeled `.ev-kind` chips, and emit a single
`<div class="trade-card flag-card {intensityClass}">` containing, in order:
header (label + date span) → `.fc-why` (finding) → `.fc-mech` ("How measured: …", if meta) →
`.fc-conf` (bold lead) → `.fc-stats` (if `conf.stats`) → `.fc-evidence` (chips) →
`.fc-caveat` ("What this doesn't show: …", if meta).
Update the section lede to describe the new card structure. Delete the old `rigor`/`anomalyVerdict` path.

**Edit 6 — `buildIndex()` homepage additions.**
- Call `const strongest = await fetchStrongestFlags();` at the top.
- Build `strongestRows` (member link · pattern label via `PATTERN_LABELS` · `confidencePhrase(...).lead`)
  and a `strongestBlock` (`<h2>Strongest flags</h2>` + lede + table), empty string if no rows.
- Prepend to the page body: a corpus lede ("…reports patterns, not verdicts."), a
  `.how-to-read` box (3 bullets: pattern ≠ accusation; what confidence means; alignment ≠ intent),
  then `${strongestBlock}` above the existing "Explore" section.

---

## Verification (run after edits)

```bash
cd ~/.hermes/civiclens
grep -rn "anomalyVerdict" render/        # expect: no matches
npx tsx render/build.ts                  # expect: clean build, all member pages + index
```

Spot-check rendered output:
- `site/index.html` contains "How to read a flag", "Strongest flags", "reports patterns, not verdicts".
- A scored member (e.g. `site/members/pramila-jayapal.html`) shows a full flag card:
  header, `.fc-why`, "How measured", bold confidence lead, `observed … vs expected … · p = …`,
  evidence chips, "What this doesn't show".

**Verified 2026-05-29:** build green across 36 member pages; `anomalyVerdict` fully removed;
homepage + Jayapal card render all parts; only `render/build.ts` in scope (the `names.txt`
roster change in the tree is unrelated and excluded from this commit).

## Out of scope (Phase 2+)

Additive DB columns, methodology page, profile-level synthesis, per-row deep-link anchors,
null-model expansion. Validate Phase 1 UI value before any of these.
