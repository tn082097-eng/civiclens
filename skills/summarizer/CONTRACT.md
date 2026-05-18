# Summarizer — Agent Contract

Single source of truth for what the Summarizer does. `pipeline.ts` and
Hermes-invoked runs both follow this file. If code or SKILL.md contradicts,
this document wins.

## Purpose

Turn Researcher + Data Checker + Connection Mapper output into a neutral,
readable summary (bio, key facts, narrative). The Summarizer **narrates**
— it never discovers. Every claim in its output must be traceable to a
field in a prior agent's output.

This is the agent with the highest hallucination risk in the pipeline,
because it's the one asked to produce prose. The contract exists to make
fabrication structurally hard, not just discouraged.

## Architecture — two stages

- **Stage 1 — deterministic (code only, no model):**
  Build the `headline` from structured fields (`name`, `role`, `state`,
  `party`). Format bill/donor/controversy text blocks for the model prompt.
  Construct the neutrality-rules preamble. No model call yet.

- **Stage 2 — narrative synthesis (model, over stage-1 inputs):**
  The model receives structured facts and writes `bio`, `keyFacts`, and
  `neutralNarrative`. The model may re-word, compress, and select — it may
  not invent.

- **Stage 3 — post-processing (code only, no model):**
  Regex auto-replacements for charged phrases, neutrality-violation check,
  keyFacts verification (each fact must reference something from the
  Researcher output).

## INPUTS

1. `pipeline/<task-id>/researcher.json` — primary facts.
2. `pipeline/<task-id>/data-checker.json` — quality flags, auto-corrections.
3. `pipeline/<task-id>/connection-mapper.json` (optional) — verified shared
   donors and network summary. If present, Summarizer may reference
   specific shared donors by name in narrative.
4. No other inputs. No external fetches. No stub data.

## OUTPUTS

Write `pipeline/<task-id>/summarizer.json`:

```json
{
  "taskId":               "task-...",
  "summarizedAt":         "ISO-8601",
  "headline":             "Full Name — Role, State (Party)",
  "bio":                  "2-3 sentence neutral biography",
  "keyFacts":             ["fact 1", "fact 2", "fact 3"],
  "neutralNarrative":     "3-4 sentence overview of record and context",
  "dataQualityNote":      "one sentence on validation status",
  "neutralityViolations": ["word1", "phrase2"]
}
```

## MUST DO

1. **Construct headline deterministically** from `researcher.data.{name,role,state,party}`.
   The model does not generate headline — it's a format string.
2. **Every `keyFact` must reference at least one token** from
   `researcher.data.{bills,donors,votes,bio,party,state,role}`. Facts with
   no traceable reference get flagged as `unverifiedFacts` and dropped.
3. **Re-word Wikipedia bio** into 2-3 neutral sentences. The source bio may
   contain charged language; the output bio must not.
4. **Apply neutrality auto-replacements** (`blocked` → `voted against`,
   `rammed through` → `passed`, etc.) to bio and narrative after the model
   call, not before.
5. **Run the FORBIDDEN-word check** on the final bio + narrative and emit
   any surviving violations in `neutralityViolations`. Do not fail the
   agent for violations; surface them.
6. **Reference verified shared donors by name** in narrative if the
   Connection Mapper ran and found any. This anchors the narrative in
   verified data.

## MUST NOT

1. Do not invent facts, positions, quotes, votes, or relationships. If it
   isn't in one of the input JSON files, it doesn't exist.
2. Do not invent "controversies" — this was a prior bug; the Summarizer
   generated 3 fake controversies via LLM. Controversies come only from
   Researcher or Connection Mapper output.
3. Do not use "alleged" or "reported" unless the source itself uses them —
   prepending "alleged" to a neutral fact is its own form of editorializing.
4. Do not use FORBIDDEN words (see neutrality rules in the prompt) even
   when they appear in the source bio.
5. Do not call any model for headline — that field is deterministic.
6. Do not call any external API or fetch URLs.

## INHERITS

- **no-stubs** — applies in full. No fabricated facts; narrate only from
  upstream agents' outputs.
- **neutral-voice** — applies in full. This is the agent where the rule
  matters most because it produces prose.
- **provenance** — applies via dependency. The Summarizer itself doesn't
  emit `sourceUrl` fields (its output is narrative, not records), but every
  fact it narrates must be traceable to an upstream record that has one.

## Failure modes

| Symptom | Cause | Required response |
|---|---|---|
| Model returns non-JSON | parsing failure | fail the agent; Brain retries once |
| `keyFacts` contains untraceable claim | model invention | drop that fact, log `unverifiedFacts` warning |
| Neutrality violation survives auto-replace | model used a FORBIDDEN word not in the replacement list | emit in `neutralityViolations`, do not fail |
| No Connection Mapper output | Mapper skipped or failed | narrative omits network commentary — do not fabricate one |
| Researcher has empty bills/votes/donors | low-profile politician or API gap | narrative is sparse but truthful — do not pad with invented context |
