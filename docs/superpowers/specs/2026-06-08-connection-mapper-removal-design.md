# Connection Mapper removal — design

**Date:** 2026-06-08
**Status:** approved, implementing
**Branch:** `chore/remove-connection-mapper` (off the Phase 2 cleanup line)

## Context

The Connection Mapper agent (`agents/connection-mapper.ts`) is the next Phase 2
simplification slice (plan: `~/.claude/plans/pipeline-simplification-agile-quasar.md`).
It does two things:

1. **Deterministic match** — `computeSharedDonors()` / `computeSharedCommittees()`
   over `loadCorpus()` (already DuckDB-backed). Real value.
2. **LLM stage 2** — narrates speculative `directLinks` / `hiddenConnections` /
   `indirectLinks` / `networkSummary`. Inferred, not sourced → violates the
   truth-over-narrative / no-fabrication rule.

The deterministic shared-donor match already exists as SQL in the consolidated
query layer: `findSharedDonors()` in `db/queries.ts` (the same query the public
site renders). This mirrors how the **revolving-door** agent was removed this
session: delete the agent, converge on `db/queries.ts`.

**Why now:** the agent's two public-facing consumers are already cut over — the
site uses `findSharedDonors()`, and `render/connections-to-vault.ts` was repointed
to it in `d96e2d8`. The *only* remaining live reader is the Summarizer. Repoint it
and the agent is fully removable: one LLM call + one failure point + one pipeline
stage gone per member.

## Key facts (verified during exploration)

- **Pipeline ordering makes `findSharedDonors()` viable mid-run.** `syncTask(task.taskId)`
  runs at `agents/pipeline.ts:33` — right after the Researcher, *before* the
  Summarizer (`:69`). So this member's donors are in DuckDB by the time the
  Summarizer runs. `d.id == members.member_id` (confirmed via `loadCorpus`).
- **The Summarizer only consumes `sharedDonors`**, never `sharedCommittees`
  (`agents/summarizer.ts:40-44`). Committees die with the agent at zero loss.
- **The 3 compute helpers are used only inside `connection-mapper.ts`.**
  `db/load-from-tasks.ts` and `db/load-lda.ts` keep their *own* copies (comments
  say "mirrors") — no imports to break.
- **Other readers:** `agents/devils-advocate.ts:84` reads the pipe but is an
  unwired orphan (not imported by `pipeline.ts`); it already guards for absence.

## Approach

### 1. Repoint the Summarizer → `findSharedDonors()`
`agents/summarizer.ts`:
- Add `import { findSharedDonors } from '../db/queries.js';`
- Remove the optional `mapper = readPipe(...'connection-mapper')` block (`:19-20`).
- Replace the `sharedDonorText` builder (`:40-44`) with a peer-oriented version:
  ```ts
  const peers = await findSharedDonors(d.id);
  const sharedDonorText = peers.length > 0
    ? peers.map(p => `- ${p.peer_name}: ${p.shared_count} shared donor${p.shared_count === 1 ? '' : 's'}`
        + (p.donor_canonicals.length ? ` (${p.donor_canonicals.slice(0, 5).join(', ')})` : '')).join('\n')
    : 'None identified.';
  ```
- Update the prompt label `Verified shared donors (from Connection Mapper, if any):`
  → `Verified shared-donor peers (deterministic SQL match):`.

### 2. Delete the agent
- Delete `agents/connection-mapper.ts` (the 3 helpers go with it — unused elsewhere).
- Delete `skills/connection-mapper/` (`SKILL.md` + `CONTRACT.md`).

### 3. Unwire from the pipeline
`agents/pipeline.ts`:
- Remove `import { runConnectionMapper }` (`:31`).
- Remove the stage: `setStatus(task, 'connecting')` + `const mapOk = await runConnectionMapper(task)` (`:169-170`) and any `mapOk` use/logging.
- Remove `'connection-mapper'` from the agent-order display array (`:208`).
- Remove the `--rerun-mapper` CLI branch (`:459-470`) and its `--help` line.
- Update the stale comment at `:59` referencing connection-mapper output.

### 4. Reconcile the type unions / init
- `lib/types.ts`: drop `'connection-mapper'` from `AgentName` (`:7`) and `'connecting'`
  from `PipelineStatus` (`:20`).
- `agents/shared.ts`: drop the `'connection-mapper': { ...def }` slot in `initTask` (`:117`).

### Out of scope (note, don't do)
- `devils-advocate.ts` orphan cleanup (separate dead-topology pass; Grok review lists it).
- Unifying the duplicate `normalizeDonorName` copies in `db/load-*.ts`.
- Reordering sync so the site and summarizer share one query path (already do — both DuckDB).

## Verification

1. **No residue:** `rg -n "connection-mapper|ConnectionMapper|runConnectionMapper|computeSharedDonors|computeSharedCommittees|'connecting'|rerun-mapper"` returns only the `db/load-*.ts` "mirrors" comments (acceptable).
2. **Loads:** `npx tsx agents/pipeline.ts --help` runs; no `--rerun-mapper` listed.
3. **Tests:** `npm test` → 21/21.
4. **Summarizer data path (deterministic, no LLM):** small `tsx` snippet calling
   `findSharedDonors('<existing member_id>')` prints sensible peers — and diff its
   donor set against the old agent's `computeSharedDonors` for one member to confirm
   the canonicalization difference is acceptable (expected: near-identical).
5. **Render unaffected:** `npx tsx render/build.ts` green across members.
6. **Vault unaffected:** `npx tsx render/connections-to-vault.ts` green (already off the agent).
7. Commit incrementally; do **not** merge/push (user decision).
