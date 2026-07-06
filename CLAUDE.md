## Dev loop (incremental by default)

Run only the stage/member you're working on; full rebuild stays available.

- One member's artifact: `npx tsx pipeline/score-theme-gaps.ts --member <slug>` — skips if artifact newer than DB; `--force` recomputes.
- All artifacts: `... --all` (freshness-skipped) / `... --all --force` (full regen).
- One member's page: `npx tsx render/build.ts --member <slug>` (~1s; skips index/network/nexus).
- Full site: `npx tsx render/build.ts`.
- Data loaders are per-stage flags on `agents/pipeline.ts` (`--load-bills`, `--load-pfd`, … see `--help`); many accept a member slug or `--limit`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
