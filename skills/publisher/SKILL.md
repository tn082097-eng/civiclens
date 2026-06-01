---
name: publisher
description: Applies approved seed data to ~/civiclens/src/db/seed.ts. No LLM. Blocked if final-review.readyToApply is false. Called by Brain as the last pipeline step.
tools: Read, Write, Bash
---

# Publisher Agent

Apply the approved seed block to seed.ts. No generation, no LLM — this is a deterministic apply step.

## Step 1: Check approval gate

```bash
cat ~/Developer/civiclens/pipeline/<task-id>/final-review.json
```

If `readyToApply` is not `true`, stop immediately and report the decision and reasons. Do not touch seed.ts.

## Step 2: Run apply script

```bash
npx --prefix ~/Developer/civiclens tsx ~/Developer/civiclens/skills/publisher/apply.ts <task-id>
```

The script will:
- Read `coder.json` for the `seedBlock`, `action`, `politicianId`, and `section`
- For `action: "update"` — find and replace the existing line with matching slug
- For `action: "insert"` — insert into the correct section in the politicians array
- Write `publisher.json` with the result

## Step 3: Verify

```bash
grep -n "<politicianId>" ~/civiclens/src/db/seed.ts
cat ~/Developer/civiclens/pipeline/<task-id>/publisher.json
```

## Step 4: Update state

```bash
npx --prefix ~/Developer/civiclens tsx ~/Developer/civiclens/lib/state.ts update <task-id> publisher '{"status":"complete"}'
```
