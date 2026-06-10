# Phase-2 close-out — design

**Date:** 2026-06-10
**Status:** approved (design), spec under review
**Predecessor:** `~/.claude/plans/pipeline-simplification-agile-quasar.md` (Phases 1–2), PR #1 (`fix/deterministic-gates`, merged 2026-06-10)

## Context

Phase 1 of the pipeline simplification is merged; Phase 2 is mostly done (Connection
Mapper removed, brain theater removed, gates deterministic, Summarizer demoted to
opt-in sidecar). This spec closes out what remains, plus the oldest queued safety
item (XSS hardening, flagged 2026-05-30, still unshipped — verified zero
`safeJson`/`safeUrl` hits in `render/build.ts`).

Four risk-ordered PRs off `main`, merged in sequence. Each is independently
revertable with its own verification gate. PR 3 builds on PR 2's validated stage
boundaries; PR 4 builds on PR 3's stage table.

**Constraints honored throughout:**
- The deterministic spine never depends on LLM sidecars. Sidecars may run by
  default, but their failure or output must never block or alter the publish
  path.
- Grok subscription renewed 2026-06-10. `devils-advocate.ts` (Grok-backed) gets
  wired in PR 4 as an **advisory-only** sidecar, enabled by default, opt-out
  via env flag. It never gates.

## PR 1 — XSS hardening in `render/build.ts`

Two helpers added next to the existing `esc()` (`render/build.ts:44`), same
single-file pattern:

- **`safeJson(value)`** — `JSON.stringify`, then escape `<` → `\u003c`,
  `>` → `\u003e`, and U+2028/U+2029 → `\u2028`/`\u2029`. Prevents `</script>` breakout and
  HTML-comment tricks in inline `<script>` embeds. Apply at the 4 embed sites:
  `dataJson` (:748), `graphJson` (:1599), `nexusJson` (:1835), inline `THEME`
  stringify (:1851).
- **`safeUrl(url, fallback = '#')`** — allowlist `http:`/`https:` absolute URLs,
  same-page `#anchors`, and relative `*.html` links; everything else
  (`javascript:`, `data:`, `vbscript:`, protocol-relative `//`) returns the
  fallback. Apply at the ~15 `href` sites carrying external-data URLs
  (`source_url`, `sourceUrl`, `bill_source_url`, `vote_source_url`,
  `trade_source_url`). Pattern: `href="${esc(safeUrl(...))}"` — `esc()` alone
  does not neutralize `javascript:` URLs; that is the gap being closed.
- Internal hrefs built from `peer_id` slugs get a conservative slug guard
  (`/^[a-z0-9-]+$/`) instead of URL parsing.

**Verification:**
1. New `node --test` file with hostile payloads
   (`</script><script>alert(1)</script>`, `javascript:alert(1)`, U+2028,
   `"><img onerror=...>`) asserting helper output.
2. Full corpus render diff: hash `site/*.html` before/after — **byte-identical**
   expected for the existing (clean) corpus.
3. `npm test` stays green.

## PR 2 — Typed artifact reads

- Extend `lib/schemas.ts` with output schemas for live producers that lack one:
  data-checker, trade-analyst, summarizer, predictor, final-reviewer.
  (`ResearcherOutputSchema` exists.) Schemas must match what agents *actually
  emit* — derive by validating against existing task artifacts on disk, loosen
  where reality demands, never tighten beyond observed shape in this PR.
- `readPipe` in `agents/shared.ts` gains an optional Zod schema parameter:
  `readPipe(taskId, name, schema?)`. Validates on read; throws with a message
  naming taskId, agent, and offending field. Optional-sidecar reads keep their
  existing try/catch semantics — a schema failure on an optional artifact logs a
  warning, never kills the run.
- Convert all live `readPipe<any>` sites (`code-checker.ts`, `data-checker.ts`,
  `final-reviewer.ts`, summarizer-related reads) **and** the raw `JSON.parse`
  artifact reads in `db/load-from-tasks.ts` / `db/sync-task.ts` — the DB loader
  is the real publish path and gets the same validation.
- **Devils-advocate:** untouched in this PR — PR 4 wires it and adds its schema
  there, keeping this PR a pure no-behavior-change conversion of live readers.

**Verification:**
1. `npx tsc --noEmit` clean.
2. `npm test` — all green (21/21 at time of writing), plus a new test feeding a
   malformed artifact and asserting the error names the offending field.
3. Pipeline smoke on an existing member completes with validated reads.

## PR 3 — Declarative job graph in `agents/pipeline.ts`

Replace the hand-rolled sequence (`pipeline.ts:139–200`) with a stage table:

```ts
const STAGES: Stage[] = [
  { name: 'researcher',     status: 'researching',      run: runResearcher,    required: true },
  { name: 'data-checker',   status: 'validating',       run: runDataChecker,   required: true,
    onFail: retryResearcherOnce },   // preserves the existing one-retry coupling
  { name: 'predictor',      status: 'predicting',       run: runPredictor,     required: false },
  { name: 'trade-analyst',  status: 'analyzing-trades', run: runTradeAnalyst,  required: false },
  { name: 'summarizer',     status: 'summarizing',      run: runSummarizer,    required: false,
    enabled: () => summarizerOptedIn },
  { name: 'code-checker',   status: 'reviewing-code',   run: runCodeChecker,   required: true },
  { name: 'final-reviewer', status: 'final-review',     run: runFinalReviewer, required: true },
];
```

A small `executeStages(task, stages)` runner owns status transitions,
required-failure abort, and per-stage result recording into `pipeline_runs`
(whose schema comment already claims that role). The `--research-only` path
becomes a slice of the same table instead of the parallel copy at `:345`.

**Deliberately excluded:** retries framework, parallelism, config system, any
abstraction beyond the table. This is the "small DAG" the simplification plan
specified, kept linear.

**Verification:**
1. Full pipeline smoke (`--force` on an existing member); stage-by-stage status
   sequence matches pre-refactor behavior.
2. `site/` render byte-diff unchanged.
3. `npm test` green; `--help` output and CLI flags unchanged.

## PR 4 — Devils-advocate as advisory sidecar (wired, on by default)

Wire the dormant `agents/devils-advocate.ts` into the pipeline as a stage-table
row (trivial after PR 3), advisory-only, running by default:

- **Slot:** after Summarizer, before Code Checker —
  `{ name: 'devils-advocate', status: 'adversarial-review', required: false,
  enabled: () => !devilsAdvocateOptedOut }`. Add `'adversarial-review'` to
  `PipelineStatus` and `'devils-advocate'` to `AgentName` in `lib/types.ts`;
  add the agent slot back to `initTask` in `agents/shared.ts`.
- **Default on, opt-out flag:** `CIVICLENS_NO_DEVILS_ADVOCATE=1` disables it
  (inverse of the trade-narrative pattern, because this one defaults on). Any
  LLM error or schema violation logs a warning and the run continues —
  identical semantics to the other optional sidecars.
- **Input fix:** replace the dead `readPipe(... 'connection-mapper')` read
  (`devils-advocate.ts:84`) with `findSharedDonors()` from `db/queries.ts` —
  the same migration the Summarizer went through in the Connection Mapper
  removal. If the Summarizer didn't run (it's opt-in), the stage critiques the
  deterministic trade narrative + key facts instead of skipping.
- **Output:** `devils-advocate.json` — adversarial critique of the narrative
  (overclaims, missing caveats, alternative readings of the same evidence).
  Add `DevilsAdvocateOutputSchema` to `lib/schemas.ts`; written and read
  through the PR 2 validated path.
- **Consumer:** the QC review workflow, not the site. A small
  `render/qc-to-vault.ts` writes the critique as a vault note
  (`~/NoService/Projects/CivicLens/QC/<member>-devils-advocate.md`) so it lands
  where manual tone/bias/suitability review happens. Nothing in
  `render/build.ts` or `db/load-from-tasks.ts` reads it.
- **Never gating:** Final Reviewer and Code Checker do not read it. Its
  presence, absence, or content cannot change the publish decision.

**Verification:**
1. Default run, one member: `adversarial-review` status appears, artifact
   validates against the schema, vault note written, Final Reviewer decision
   identical to a `CIVICLENS_NO_DEVILS_ADVOCATE=1` run of the same member.
2. `site/` render byte-diff: identical with the stage on vs off (proves
   nothing on the publish path reads it).
3. Simulated Grok failure (bad API key): warning logged, run completes,
   pipeline status never lands on `failed` because of this stage.
4. `npx tsc --noEmit` and `npm test` green.

## After this arc — next goal

1. **Fix the vote→bill linkage regression (78% → 71.6%).** Blocking
   data-quality item ("investigate before adding more members" — STATUS.md).
   Likely fix: `--load-bills --api-pass` re-run (took it 15%→78% originally).
   Success: ≥78% on the 5-member batch, root cause documented in SOURCES.md.
2. **Then Phase 3 — provenance & lineage**, on stabilized topology and trusted
   data. Needs its own design pass; `pipeline_runs` as job-graph state source
   (PR 3) is the substrate it builds on.

**Explicitly deferred (stay queued in STATUS.md, untouched by this plan):**
roster finish (Turner + McCarthy), crosswalk tuning, donor-sector ingestion,
district-contracts detector. Rationale: those *add* claims to the site; this
arc strengthens the claims already on it. Rigor before reach.

## Estimate

PRs 1–4: ~7–8 hours total (two sessions).
PR 1 ≈ 1–1.5h, PR 2 ≈ 2h (schema-vs-reality reconciliation is the slow part),
PR 3 ≈ 1.5–2h, PR 4 ≈ 1.5–2h (prompt contract + vault-note format are the
design-sensitive parts).
