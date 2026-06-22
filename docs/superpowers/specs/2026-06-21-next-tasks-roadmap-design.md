# Next-Tasks Execution Roadmap (Design)

> **Date:** 2026-06-21 · **Type:** sequencing/meta-plan, not a feature design.
> The three feature plans below already exist and are Grok-reviewed. This doc fixes their
> **execution order and dependency edges** — it does not re-design any feature.

## Sequencing principle

Ship visible member-page wins cheapest-first; defer the only new-data lift (#6's FEC
Schedule A ingestion) to last. Every phase preserves the corpus parity bar
**32 / 1126 / 47678 / 3240 / 182** and **ADR 0001** (deterministic HTML, no LLM on the ship path).

**Order: #7 → Lane 3 → #6.**

## Dependency edges (why this order)

- **#7 Uniform Skeleton** owns `buildMemberPage`, reserves the `sec-coherence` and
  `sec-money-votes` slots, and finally wires `renderReceiptsSection` into the page
  (built-but-dark on `main` today). Keystone — everything else slots into it.
- **Lane 3 Coherence** reuses views that already exist (`v_theme_eligible_votes`,
  `v_trade_bill_nexus`, `v_member_donor_theme`). No new data. Cheap.
- **#6 Money-Vote**: Tasks 1–8 are backend-only and depend on **nothing** in #7. Only
  **Task 9** (page wire) waits on #7's reserved `sec-money-votes` slot. #6 also carries the
  arc's only new-data lift (FEC Schedule A → `fec_contributions` / `pac_theme`), so it goes last.

Source plans:
- `docs/superpowers/plans/2026-06-18-uniform-member-skeleton.md` (#7)
- `docs/superpowers/plans/2026-06-18-theme-coherence-cards.md` (Lane 3)
- `docs/superpowers/plans/2026-06-18-money-vote-detector.md` (#6, rev 2026-06-19)

---

## Phase A — #7 Uniform Member Skeleton (entry point)

Ends accusation-list bias (flagged members no longer look longer) **and** lights up Lane 1 receipts.

- **7a** — Registry + `sectionShell(id, title, body)`; each `sec-*` id appears exactly once.
- **7b** — Empty shells: revolving ("No disclosed revolving-door lobbyist ties in corpus."),
  outside-spending (unavailable = no `fec_candidate_id` vs empty = no IE for cycle).
- **7c** — **Wire `renderReceiptsSection`** via `loadThemeGapsOrSentinel`. *Highest-value single
  change in the arc.* Insert `sec-receipts` above the timeline (moment-of-insight hierarchy).
- **7d** — Golden determinism test: stable hash across double render (pelosi, jayapal, no-trades).
- **7e** — Batch `score-theme-gaps` for the 32 publish members; sentinel for dev-only slugs.

**Exit gate:** every member renders all 11 ordered sections + 2 reserved stubs
(`sec-coherence`, `sec-money-votes` = "Not computed yet"); `npm test` + `validate:corpus`
green; parity bar unchanged.

## Phase B — Lane 3 Coherence Cards (reuse-only)

Fills #7's reserved `sec-coherence`. All four metrics from existing views.

- **C1** `v_member_theme_footprint` view + SQL smoke (pelosi `Tech & Semiconductors` > 0)
- **C2** schemas + `pipeline/score-theme-coherence.ts` + fixture test
- **C3** `render/coherence.test.ts` (empty / single / multi theme)
- **C4** wire `sec-coherence` in the #7 registry + sentinel empty artifact
- **C5** optional `validate-artifact-corpus` entry

**Exit gate:** `sec-coherence` renders `active` / `surface-only` / empty states; golden test
confirms donor-only theme activity → `surface-only` copy. No new null model in v1.

## Phase C — #6 Money-Vote Detector (heaviest; new FEC ingestion)

- **Tasks 1–8** backend: Schedule A source freeze → schema (`fec_contributions`, `pac_theme`,
  `v_donor_vote_nexus`) → `lib/fec-contributions.ts` fetcher → loader + detector glue →
  seed `pac_theme` from loaded data → `renderMoneyVotesSection` + tests. **None gated on #7.**
- **Task 9** fills #7's reserved `sec-money-votes` slot via `loadMoneyVotesOrSentinel`
  (mirror of `loadThemeGapsOrSentinel`). *Only step gated on Phase A.* Confirm seam first:
  `rg -n 'sec-money-votes' render/build.ts` must return the reserved slot before starting.

**Exit gate:** money-votes section renders the sentinel empty-state for members lacking themed
PAC receipts; never crashes, never omits; parity bar unchanged.

---

## Parked (explicitly out of scope for this arc)

- **Batch-concurrency mutex** (Grok blocker) — only bites parallel pipeline runs; this arc is
  single-process render, so it does not block. Note, don't fix here.
- **Vote→bill linkage regression** (71.6% → 78%) — data-quality, feature-frozen per phase-2
  closeout. Independent track.
- **`db/migrate.ts` runner**, **FEC-offline render** — deferred.

## Verification (all phases)

`npm test` + `npm run validate:corpus`; parity bar **32 / 1126 / 47678 / 3240 / 182** held
constant; ADR 0001 (no LLM on ship path); `safeUrl` / `memberHref` on all links; neutral
empty copy (no "suspicious" / "clean").

## Next step

Invoke writing-plans for **Phase A / #7** as the first executable unit. (#7's source plan
already has tracer-bullet PRs 7a–7e; the implementation plan operationalizes those into
checkboxed steps.)
