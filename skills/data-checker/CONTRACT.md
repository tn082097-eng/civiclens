# Data Checker — Agent Contract

Single source of truth for the Data Checker. `pipeline.ts` and Hermes-invoked
runs both follow this file. If code or SKILL.md contradicts, this document wins.

## Purpose

Validate the Researcher's output and catch structural, schema, and semantic
problems before downstream agents operate on bad data. Auto-correct common
fixable issues; flag the rest. The Data Checker is the last line of defense
against garbage propagating through the pipeline.

## Architecture — two stages

- **Stage 1 — deterministic validation (code only):** Auto-correct common
  fixable issues (type coercion, date clamping, enum normalization), then
  run Zod schema validation + semantic checks. This stage catches 95% of
  real problems and never hallucinates.
- **Stage 2 — plausibility check (model):** A single bounded call asking
  whether the bio reads as a plausible political bio for this person.
  Returns YES/NO + one-line reason. The model never edits data; it only
  flags.

The code stage MUST run to completion before the model is called. If the
code stage fails critical checks, skip the model — the pipeline fails here.

## INPUTS

1. `pipeline/<task-id>/researcher.json` — the record under review.
2. `lib/schemas.ts` ResearcherOutputSchema — the Zod contract.
3. No other inputs.

## OUTPUTS

Write `pipeline/<task-id>/data-checker.json`:

```json
{
  "taskId":      "task-...",
  "validatedAt": "ISO-8601",
  "passed":      true,
  "score":       0.0,
  "issues":      [{ "field": "data.path", "severity": "critical|warning|info", "message": "..." }],
  "summary":     "one-line human summary"
}
```

Also write any stage-1 corrections back to `researcher.json` as
`corrections: string[]` so downstream agents see the fixed data.

## MUST DO (stage 1, code)

1. **Auto-correct before Zod** so fixable problems don't fail validation.
   Current auto-corrections: `inOffice` coercion, future-date clamping,
   bill-summary fallback, vote-option normalization, donor-type clamping,
   party/chamber enum normalization.
2. **Run Zod validation on ResearcherOutputSchema** after auto-correct.
   Every Zod error → critical issue.
3. **Run semantic checks:** bio ≥50 chars, state is valid 2-letter code,
   no future dates (post-correction), `inOffice` is boolean, confidence ≥0.60.
4. **Surface corrections** in the console output so the user sees what was
   changed.

## MUST DO (stage 2, model)

1. **Pass only the bio** to the plausibility model (not the whole record).
   The check is "is this a plausible bio for this person", not "is the whole
   record good".
2. **Keep the call short** — 60s timeout, one-line response.
3. **Treat the model's NO as a warning, not a critical.** The model can be
   wrong; code-stage criticals can't.

## MUST NOT

1. Do not let the model edit data. The model reads; code writes.
2. Do not skip stage 1 just because stage 2 passed — schema validity isn't
   optional.
3. Do not auto-correct anything that isn't objectively mechanical (e.g.,
   don't "correct" a bill title, a donor name, or a bio — those are facts).
4. Do not fail on warnings or info — only criticals fail the pipeline.
5. Do not use the LLM plausibility check as a substitute for the schema.

## INHERITS

- **no-stubs** — applies in full. No synthesizing missing fields.
- **neutral-voice** — not directly applicable (Data Checker emits no prose).
- **provenance** — applies via dependency (if Researcher output lacks
  sourceUrl on a record, flag it as a warning here).

## Failure modes

| Symptom | Cause | Required response |
|---|---|---|
| Zod validation fails | schema mismatch the auto-correct didn't catch | critical issue, pipeline fails |
| State is full name | Researcher bug (should use `stateCode`) | flag as critical — Researcher must fix, don't paper over |
| Plausibility check says NO | model noise or actually wrong bio | warning only; does not fail |
| All bills/votes/donors empty | low-profile politician or API gap | info issue, does not fail |
| Confidence < 0.60 on any record | low-quality source data | warning per record |
