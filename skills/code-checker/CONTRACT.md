# Code Checker — Agent Contract

Single source of truth for the Code Checker. `pipeline.ts` and Hermes-invoked
runs both follow this file. If code or SKILL.md contradicts, this document wins.

## Purpose

Last neutrality + integrity gate before the Publisher writes to `seed.ts`.
Runs against the exact text that will land in the seed file — the
Summarizer's bio plus the Researcher's `bills`, `votes`, `donors` strings.
The surface under review is whatever `applySeedBlock` will actually embed
in seed.ts, not a separate LLM-generated artifact.

## Architecture — pure code, no model

No model calls. The Coder no longer emits a `seedBlock`, so the LLM stage
that previously reviewed it is gone. Everything this agent checks is
deterministic:
- FORBIDDEN-word neutrality scan
- Boolean-type check on `inOffice`
- Minimum bio length
- Future-date rejection on bills and votes

A prior version ran deepseek-coder-v2 as a stage-2 TS linter on the dead
seedBlock. Removed with the seedBlock itself.

## INPUTS

1. `pipeline/<task-id>/researcher.json` — source of ship-bound strings
   (`bills`, `votes`, `donors`, `role`) and the `inOffice` boolean.
2. `pipeline/<task-id>/summarizer.json` — source of the bio that will
   actually land in seed.ts.
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
   applySeedBlock will embed in a string literal.
2. **Run the FORBIDDEN-word check** on the full ship surface. Any hit is a
   critical issue — the pipeline cannot ship charged language.
3. **Verify `inOffice` is a boolean literal** on `researcher.data`.
4. **Verify `summarizer.bio` is ≥ 60 chars.**
5. **Reject any future-dated `introducedAt` / `date` string.**

## MUST NOT

1. Do not call any model.
2. Do not check a `seedBlock` field — it's gone.
3. Do not skip the neutrality check — it's the load-bearing gate.
4. Do not fail on warnings — only criticals block the Publisher.

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
