# Uniform Member Skeleton + Empty-State-as-Data (Issue #7)

> **For agentic workers:** Use superpowers:subagent-driven-development or executing-plans. Checkbox steps for tracking.

**Goal:** Every member page renders the same ordered section scaffold (stable `h2` + `id` anchors). Absence is explicit data — never section omission. Kills accusation-list bias where flagged members look longer because sections appear only when populated.

**Architecture:** A `MEMBER_SECTIONS` registry drives `buildMemberPage()`. Each slot always returns HTML (populated content or a typed empty shell). Lane 1 seam: `renderReceiptsSection()` already implements four first-class empty states (`render/receipts.test.ts`); wire for **all** members via `loadThemeGapsOrSentinel()` when `pipeline/artifacts/<slug>.theme-gaps.json` is absent.

**Tech stack:** TypeScript, `render/build.ts` (+ optional `render/member-sections.ts`), `node:test` golden tests, ADR 0001 (deterministic HTML, no LLM).

**Sequencing:** Land **before** Issue #6 Task 9 (money-votes wire). #6 plugs into `sec-money-votes` reserved slot; do not race `buildMemberPage` assembly.

---

## Current omission hotspots (`buildMemberPage`)

| Section | Today | #7 behavior |
|---------|-------|-------------|
| Revolving door | `revolvingBlock = ''` when empty (L1459) | Always `sec-revolving` + empty copy |
| Outside spending | returns `''` when no IE / no FEC id (L1346–1356) | Always `sec-outside-spending` + empty/unavailable |
| Trade–vote receipts | `renderReceiptsSection` exists (L90+) but **not** in member body | Always `sec-receipts` |
| Patterns | already explicit empty (L1264–1267) | keep |
| Donors / peers | muted empty | keep (already visible) |

---

## Data model

No new DuckDB tables.

**Sentinel artifact** — must parse `ThemeGapReceiptsSchema` (`lib/schemas.ts`):

```ts
{ memberId, tradeCount: 0, disclosedTradeCount, band: 'insufficient-data',
  nPerm: 10000, windowDays: 90,
  coverage: { votesTotal, votesBillLinked }, receipts: [] }
```

`disclosedTradeCount` + coverage from same queries as `pipeline/score-theme-gaps.ts`.

---

## Section registry (ordered)

1. `sec-identity` — meta; bio per ADR 0001 (static-only path — do not expand hide-when-empty LLM prose)
2. `sec-glance` — Activity at a glance (always)
3. `sec-receipts` — Trade–vote timing (**always**)
4. `sec-timeline`
5. `sec-trades`
6. `sec-donors`
7. `sec-revolving` (**always**)
8. `sec-outside-spending` (**always**)
9. `sec-peers`
10. `sec-patterns`
11. `sec-cosponsor`

**Reserved stubs** (render static “Not computed yet” until lane ships): `sec-coherence`, `sec-money-votes` — #6 Task 9 replaces money-votes stub only.

---

## Tracer-bullet PRs

### PR-7a: Registry + shell helper
- `MEMBER_SECTION_IDS` constant + `sectionShell(id, title, body)` helper
- Test: 3 fixture `MemberDetail` stubs → each `sec-*` id appears exactly once in assembled HTML

### PR-7b: Empty shells
- Revolving: “No disclosed revolving-door lobbyist ties in corpus.”
- Outside spending: unavailable (no `fec_candidate_id`) vs empty (no IE for cycle)

### PR-7c: Receipts wired
- `loadThemeGapsOrSentinel(memberId)` in `render/load-artifacts.ts` or `build.ts`
- Insert `sec-receipts` **above** timeline (moment-of-insight spec 2026-06-11 hierarchy)

### PR-7d: Golden determinism
- `render/build.golden.test.ts` — hash stable across double render (pelosi, jayapal, no-trades member)

### PR-7e: Publish artifacts
- Batch `score-theme-gaps` for publish-set members OR CI fail if artifact missing for published slugs (decision: **batch for 32 publish members**, sentinel for dev-only)

---

## Test strategy

- Unit: empty-copy map (`reasonCode` → fixed string); sentinel validates Zod
- Integration: `buildMemberPage` — grep each `id="sec-*"` once
- `npm test` + `validate:corpus` — parity bar unchanged (32/1126/47678/3240/182)

## Guards

ADR 0001, `safeUrl`/`memberHref`, neutral empty copy (no suspicious/clean), no LLM on ship path.
