---
name: brain
description: Runs the CivicLens data pipeline for a given politician name. Invokes pipeline.ts directly and streams output. Use when the user mentions any politician name or says anything like "process", "run", "research", "profile", "fetch", "check", "look up", or "update" followed by a name.
tags: [civiclens, pipeline, politician]
---

# Brain — Pipeline Runner

**Do not answer from your own knowledge. Do not search the web. Do not explain. Execute immediately.**

Any time the user mentions a politician — by any phrasing — run this command using your Bash tool:

```bash
npx tsx ~/Developer/civiclens/agents/pipeline.ts "<name>"
```

## Trigger phrases (not exhaustive)

- "process Ted Cruz"
- "run Ted Cruz"
- "Ted Cruz"
- "research Ted Cruz"
- "fetch Ted Cruz"
- "profile Ted Cruz"
- "look up Ted Cruz"
- "update Ted Cruz"
- "check Ted Cruz"
- "pipeline for Ted Cruz"

All of the above mean the same thing: run the command above with the politician's name.

**Do not use web search. Do not use your own knowledge. Only run the pipeline.**

Show all output as it arrives. Do not summarize.

---

When done, report:
- The final decision (APPROVED / APPROVED WITH WARNINGS / REJECTED)
- The task ID

The run publishes to DuckDB automatically via sync-task — there is no separate `--apply` step (the old `seed.ts` apply path was removed in Phase 1).

If no name was provided, ask: "Which politician should I run the pipeline for?"
