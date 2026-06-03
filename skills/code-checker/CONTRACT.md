# Code Checker — Agent Contract

Single source of truth for the Code Checker. `pipeline.ts` and Hermes-invoked
runs both follow this file. If code or SKILL.md contradicts, this document wins.

## Purpose

Last neutrality + integrity gate before the run is loaded into DuckDB by
`sync-task`/`load-from-tasks` and rendered by `render/build.ts`. Runs against
the exact text that will land on the public site — the Summarizer's bio plus
the Researcher's `bills`, `votes`, `donors` strings. The surface under review is
whatever reaches DuckDB, not a separate LLM-generated artifact.

## Architecture — pure code, no model

No model calls. Everything this agent checks is deterministic:
- FORBIDDEN-word neutrality scan
- Boolean-type check on `inOffice`
- Minimum bio length
- Future-date rejection on bills and votes

> History: a prior version ran deepseek-coder-v2 as a stage-2 TS linter on a
> `seedBlock` emitted by the Coder. Both the Coder and the `seed.ts` apply path
> were dead `seed.ts`-era topology, removed in Phase 1.

## INPUTS

1. `pipeline/<task-id>/researcher.json` — source of ship-bound strings
   (`bills`, `votes`, `donors`, `role`) and the `inOffice` boolean.
2. `pipeline/<task-id>/summarizer.json` — source of the bio that will
   actually land in DuckDB and on the site.
3. No other inputs.

## OUTPUTS

Write `pipeline/<task-id>/code-checker.json`:

```json
{
  "taskId":          "task-...",
  "checkedAt":       "ISO-8601",
  "passed":          true,
  "score":           0.0,
  "issues":          [{ "field": "...", "severity": "critical|warning|info", "message": "..." }],
  "neutralityCheck": "pass|fail",
  "typeCheck":       "pass|fail",
  "summary":         "one-line human summary"
}
```

## MUST DO

1. **Build the ship surface** as the concatenation of: `summarizer.bio`,
   `researcher.data.role`, and every string in `bills`/`votes`/`donors` that
   `sync-task` will load into DuckDB.
2. **Run the FORBIDDEN-word check** on the full ship surface. Any hit is a
   critical issue — the pipeline cannot ship charged language.
3. **Verify `inOffice` is a boolean literal** on `researcher.data`.
4. **Verify `summarizer.bio` is ≥ 60 chars.**
5. **Reject any future-dated `introducedAt` / `date` string.**

## MUST NOT

1. Do not call any model.
2. Do not check a `seedBlock` field — it's gone.
3. Do not skip the neutrality check — it's the load-bearing gate.
4. Do not fail on warnings — only criticals block the load into DuckDB.

## INHERITS

- **no-stubs** — applies via dependency.
- **neutral-voice** — applies in full to the ship surface.
- **provenance** — not directly applicable.

## Failure modes

| Symptom | Cause | Required response |
|---|---|---|
| Forbidden word in ship surface | Summarizer or Researcher leaked charged language | critical — pipeline cannot ship |
| `inOffice` not boolean | Data Checker auto-correct failed upstream | critical |
| Bio too short | Summarizer produced thin output | critical |
| Future date present | Data Checker should have clamped — something regressed | critical |
