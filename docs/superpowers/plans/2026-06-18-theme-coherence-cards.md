# Per-Theme Coherence Cards (Lane 3)

> **For agentic workers:** Use superpowers:subagent-driven-development or executing-plans.

**Goal:** Per economic theme, a deterministic footprint card summarizing cross-surface activity: trades, theme-eligible votes, guarded nexus pairs, donor theme totals. Descriptive alignment index — **not** a corruption score, **not** a ranked accusation list, **no p-values on the hero line**.

**Builds on:** Lane 1 receipts (`ThemeGapReceipts`), validated `v_theme_eligible_votes` superset (2026-06-18 drift + smoke). Slots into Issue #7 skeleton as `sec-coherence` (after `sec-receipts`, before timeline).

**Tech stack:** TypeScript, DuckDB, Zod, `tsx --test`, ADR 0001.

---

## What a card asserts

Template (deterministic):

> In **{theme}**: {tradeCount} theme-mappable disclosed trades · {eligibleVoteCount} theme-eligible roll-call votes · {nexusPairCount} trade→vote juxtapositions in the credibility loop · {donorLine}.

`donorLine` = formatted `v_member_donor_theme` total for latest cycle, or “no mapped donor money for this theme/cycle.”

**Card states (derived at render):**
- `active` — `nexusPairCount > 0`
- `surface-only` — activity on ≥1 surface but `nexusPairCount === 0`
- Omit card rows where all four metrics are zero; section empty: “No theme-mapped activity across trade, vote, and donor surfaces.”

---

## SQL / predicates (reuse)

| Metric | Source |
|--------|--------|
| `tradeCount` | `pfd_transactions` + `ticker_sectors` / `sic_theme` / `ticker_theme_override` — same theme mapping as `score-theme-gaps.ts` |
| `eligibleVoteCount` | `v_theme_eligible_votes` GROUP BY `member_id`, `theme` |
| `nexusPairCount` | `v_trade_bill_nexus` GROUP BY `member_id`, `theme` |
| `donorTotal` | `v_member_donor_theme` (latest cycle) |

Optional view `v_member_theme_footprint` for SQL-level smoke tests.

---

## Artifact schema (`lib/schemas.ts`)

```ts
ThemeCoherenceCardSchema = z.object({
  theme: z.string(),
  tradeCount: z.number().int().nonnegative(),
  eligibleVoteCount: z.number().int().nonnegative(),
  nexusPairCount: z.number().int().nonnegative(),
  donorTotal: z.number().nullable(),
  donorCycle: z.number().int().nullable(),
});
ThemeCoherenceArtifactSchema = z.object({
  memberId: z.string(),
  donorCycle: z.number().int().nullable(),
  cards: z.array(ThemeCoherenceCardSchema), // sorted theme ASC
});
```

Orchestrator: `pipeline/score-theme-coherence.ts` → `pipeline/artifacts/<slug>.theme-coherence.json` (validate-on-write throw).

---

## Render (`renderThemeCoherenceSection`)

- Zero themes with activity → `sec-coherence` h2 + empty paragraph (#7 empty-as-data)
- Cards in deterministic sort; footer: “Themes from hand-curated `theme_bill_match` / sector crosswalk v1.”
- Optional link: anchor to receipt articles with matching `data-theme` (no client-side filter required in v1)

---

## Tracer-bullet PRs

- **C1:** `v_member_theme_footprint` view + SQL smoke (e.g. pelosi `Tech & Semiconductors` > 0)
- **C2:** schemas + `score-theme-coherence.ts` + fixture test
- **C3:** `render/coherence.test.ts` (empty / single / multi theme)
- **C4:** Wire `sec-coherence` in #7 registry + sentinel empty artifact
- **C5:** optional `validate-artifact-corpus` entry

## Test strategy

- Sanity: per theme `nexusPairCount <= tradeCount` (and ≤ eligible votes where applicable)
- Inherits eligible superset proof — no new null model in v1
- Golden render: donor-only theme activity → `surface-only` copy

## Relation to other lanes

- Lane 1: pair-level detail in receipts; coherence = theme rollup
- #6 money→vote: reuses eligible vote population; coherence gives theme context header
- #7: `sec-coherence` always-on slot

## Guards

ADR 0001, neutral copy, row-backed counts only, no cross-member leaderboard.
