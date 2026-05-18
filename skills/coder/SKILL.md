---
name: coder
description: Generates or updates CivicLens database seed data from validated, summarized politician data. Uses qwen2.5-coder:32b for code generation (upgrade to qwen3-coder:32b when available on Ollama). Called by the Brain agent after Summarizer completes.
tools: Read, Write, Bash
---

# Coder Agent

Generate a TypeScript seed block from summarized politician data. Do not validate — that's already done.

## Step 1: Read inputs

```bash
cat ~/.hermes/civiclens/pipeline/<task-id>/summarizer.json
cat ~/.hermes/civiclens/pipeline/<task-id>/researcher.json
```

## Step 2: Generate seed block

```bash
ollama run qwen2.5-coder:32b "Generate a TypeScript object literal for CivicLens seed.ts. Return only the object — no imports, no markdown.

Rules:
- inOffice: must be boolean true/false (not 1/0)
- All dates: 'YYYY-MM-DD'
- party: 'Democrat'|'Republican'|'Independent'
- chamber: 'executive'|'senate'|'house'|'cabinet'|'governor'|'state'
- bill status: 'introduced'|'passed'|'failed'|'signed'|'vetoed'
- vote: 'yea'|'nay'|'abstain'|'absent'
- donor type: 'individual'|'pac'|'corporation'
- Use this bio: <summarizer.neutralNarrative>

Data: <researcher.json data block>"
```

Fix common issues in output: `inOffice: 1` → `true`, `inOffice: 0` → `false`.

Check if politician already exists in seed.ts to determine action (insert or update):
```bash
grep -n "<politician-id>" ~/civiclens/src/db/seed.ts
```

## Step 3: Write output

Write to `~/.hermes/civiclens/pipeline/<task-id>/coder.json`:
```json
{
  "taskId": "<task-id>",
  "generatedAt": "<ISO>",
  "action": "insert|update",
  "politicianId": "<slug>",
  "section": "Executive Branch|Cabinet|Senate|House|Governors|State & Local",
  "seedBlock": "<TypeScript object literal>",
  "notes": "..."
}
```
