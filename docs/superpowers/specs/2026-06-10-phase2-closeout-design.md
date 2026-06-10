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

Three risk-ordered PRs off `main`, merged in sequence. Each is independently
revertable with its own verification gate. PR 3 builds on PR 2's validated stage
boundaries.

**Constraints honored throughout:**
- The deterministic spine never depends on LLM sidecars.
- Grok access has ended; the Grok-dependent `devils-advocate.ts` stays dormant
  (kept, paused — not deleted, not wired). Other LLM providers remain usable for
  the opt-in Summarizer / trade-narrative paths.

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

## PR 2 — Typed artifact reads + devils-advocate pause

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
- **Devils-advocate:** header block only —
  `PAUSED 2026-06-10: Grok subscription ended; not wired into pipeline.ts;
  excluded from the typed-reads pass. Revisit if Grok access returns or it is
  reworked onto another provider.` No other changes; stays dormant and untyped.

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

PRs 1–3: ~5–6 hours total (one long session or two comfortable ones).
PR 1 ≈ 1–1.5h, PR 2 ≈ 2h (schema-vs-reality reconciliation is the slow part),
PR 3 ≈ 1.5–2h.
