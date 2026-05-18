# Coder — Agent Contract

Single source of truth for the Coder. `pipeline.ts` and Hermes-invoked
runs both follow this file. If code or SKILL.md contradicts, this document wins.

## Purpose

Classify the pipeline's output for the Publisher: decide whether this run is
an `insert` or `update` against `seed.ts`, and pick the section name. That's
it. The Publisher (applySeedBlock) builds the actual seed.ts lines from
researcher + summarizer data directly — the Coder does not produce any
TypeScript.

## Architecture — pure code, no model

No model calls. The Coder is a thin adapter that:
1. Reads `researcher.json` for the politician slug and chamber.
2. Greps `seed.ts` for `slug: "<id>"` to decide insert vs. update.
3. Maps chamber → section name.

A prior version asked an LLM to render a full TS object literal (`seedBlock`),
but the Publisher ignored it — applySeedBlock rebuilds lines from
`researcher.data` with its own escape helpers, which is safer than splicing
LLM-generated TypeScript into a source file. The seedBlock was theater, so
the model call was removed.

## INPUTS

1. `pipeline/<task-id>/researcher.json` — source of `data.id`, `data.chamber`.
2. `civiclens/src/db/seed.ts` — read-only, to determine insert vs update.
3. No other inputs.

## OUTPUTS

Write `pipeline/<task-id>/coder.json`:

```json
{
  "taskId":        "task-...",
  "generatedAt":   "ISO-8601",
  "action":        "insert|update",
  "politicianId":  "slug",
  "section":       "Senate|House|Executive Branch|Cabinet|Governors|State & Local|Unknown",
  "changedFields": ["bio", "bills", "votes", "donors"]
}
```

## MUST DO

1. **Classify `insert` vs `update`** by checking whether `seed.ts` contains
   `slug: "<id>"` or `slug: '<id>'`. Use the exact same match rule the
   Publisher uses — any divergence is a bug.
2. **Map chamber → section** using the canonical map. Unknown chambers
   resolve to `"Unknown"`, not a fabricated label.
3. **Emit the output synchronously.** No async work, no I/O beyond the two
   file reads above.

## MUST NOT

1. Do not call any model.
2. Do not emit a `seedBlock` field. The Publisher doesn't use it.
3. Do not invent `action` or `section` values outside the canonical sets.
4. Do not write to or modify `seed.ts`. That's the Publisher's job.

## INHERITS

- **no-stubs** — applies via dependency (inputs come from Researcher).
- **neutral-voice** — not applicable (no prose output).
- **provenance** — not applicable (no factual records produced).

## Failure modes

| Symptom | Cause | Required response |
|---|---|---|
| seed.ts missing | first-time run or wrong path | emit `action: "insert"` with warning; Publisher will refuse if path still missing |
| Chamber value unrecognized | Researcher produced a chamber outside the map | emit `section: "Unknown"` and continue — Final Reviewer will flag downstream |
| Researcher output missing | Researcher failed — shouldn't reach here | crash loudly; the pipeline should not have advanced |
