# Publisher — Agent Contract

Single source of truth for the Publisher. `pipeline.ts` and Hermes-invoked
runs both follow this file. If code or SKILL.md contradicts, this document wins.

## Purpose

Apply an approved pipeline run to `civiclens/src/db/seed.ts`. The Publisher
is the only step that modifies files outside the pipeline task directory,
so its scope is deliberately narrow.

The Publisher runs as `npx tsx agents/pipeline.ts --apply <task-id>` — not
as part of the automatic pipeline flow. That's intentional: seed.ts mutations
happen only after a human has reviewed the Final Reviewer's decision.

## Architecture — pure code, no model

No model calls. The Publisher rebuilds each seed.ts line from
`researcher.json` + `summarizer.json` using hand-written escape helpers.
A prior design had the Coder emit a full TS `seedBlock` that the Publisher
would splice in — but splicing LLM-generated TypeScript into a production
file is a meaningfully larger correctness risk than rebuilding from
validated structured data. The rebuild approach stays.

## INPUTS

1. `pipeline/<task-id>/final-review.json` — must have `readyToApply: true`
   (i.e., decision is `approved` or `approved_with_warnings`).
2. `pipeline/<task-id>/researcher.json` — source of structured fields for
   the politician, bills, votes, donors.
3. `pipeline/<task-id>/summarizer.json` — source of `bio` (neutrality-checked).
4. `pipeline/<task-id>/coder.json` — source of `action`, `section`,
   `politicianId` (used in the publisher.json output).
5. `civiclens/src/db/seed.ts` — the file to modify.

## OUTPUTS

Write `pipeline/<task-id>/publisher.json`:

```json
{
  "taskId":        "task-...",
  "appliedAt":     "ISO-8601",
  "action":        "insert|update",
  "politicianId":  "slug",
  "section":       "Senate|House|...",
  "appliedAtLine": 123,
  "backupPath":    "seed.ts.bak.<timestamp>"
}
```

## MUST DO

1. **Refuse to run if `readyToApply` is false.** The Final Reviewer is
   authoritative. `rejected` decisions never reach the Publisher.
2. **Backup seed.ts to `seed.ts.bak.<ISO-timestamp>` before mutation.**
   A single backup per invocation is sufficient.
3. **Detect action by slug presence:**
   - If `slug: "<id>"` or `slug: '<id>'` exists → `action = 'update'`,
     replace the `bio:` field on the existing line.
   - Else → `action = 'insert'`, append a new politician row plus related
     bills/votes/donors to their respective top-level const arrays.
4. **Use `summarizer.bio` (not `researcher.data.bio`) for the bio value.**
   The Summarizer's bio is neutrality-checked and re-worded.
5. **Record `appliedAtLine`** — the 1-based line number where the politician
   row was inserted or updated — in `publisher.json`.
6. **Preserve file formatting** — 2-space indent, trailing commas where the
   existing entries use them.

## MUST NOT

1. Do not run if Final Reviewer's decision is `rejected`.
2. Do not call any model.
3. Do not modify any file other than `seed.ts` and the backup.
4. Do not splice a Coder-generated `seedBlock` — there isn't one, and
   inserting LLM-generated TypeScript into a source file is the thing this
   architecture explicitly avoids.
5. Do not perform git operations. Version control is the user's
   responsibility.

## INHERITS

- **no-stubs** — applies via dependency.
- **neutral-voice** — applies via dependency (summarizer.bio is already
  neutralized; Code Checker gated the ship surface).
- **provenance** — each related record (bill, vote, donor) carries its
  `source` field from the Researcher into seed.ts.

## Failure modes

| Symptom | Cause | Required response |
|---|---|---|
| `readyToApply` is false | rejected decision or bug upstream | refuse to run, exit non-zero |
| `seed.ts` missing | wrong path or fresh install | fail loudly; do not create an empty seed.ts |
| Target const array not found | seed.ts refactored away from the `const politicians = [ … ];` structure | warn, skip that array, continue — Publisher records a partial apply |
| Existing politician line has no `bio:` field | seed.ts hand-edited into a shape the regex doesn't match | warn and continue — update path becomes a no-op, insert path is unaffected |
| Backup copy fails | filesystem permissions | fail before any mutation — the invariant is "never write without a backup first" |
