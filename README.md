# CivicLens

A **local-first congressional transparency pipeline**. It pulls primary-source data on members of
Congress — stock trades, votes, sponsored bills, donors, and lobbying filings — runs it through a
chain of TypeScript agents into a **DuckDB** warehouse, detects patterns, and renders a **static HTML
site**.

Editorial stance is deliberate: **primary sources only, neutral framing, no stub data** (the pipeline
fails loudly rather than invent values), and a "before, not after" view of trade-vs-vote timing.

> **Status note:** This README describes what `main` actually runs. Some other docs in this repo
> (`PROJECT_OVERVIEW.md`, `SOLO.md`, `CLAUDE.MD`, `civiclens-core`) are partly stale — when they
> disagree with the code, trust `agents/pipeline.ts`, `lib/paths.ts`, `db/schema.sql`, and this file.

---

## How it works

```
primary sources ─▶ agents ─▶ pipeline/task-*/  ─▶ sync-task ─▶ DuckDB ─▶ run-patterns ─▶ render/build ─▶ site/
 (Congress.gov,    (per-member  (per-run JSON      (load into   (data/         (deterministic   (static HTML)
  GovTrack, FEC,    fetch +      artifacts,         warehouse)   civiclens      detectors write
  House/Senate      analysis)    audit trail)                    .duckdb)       pattern_hits)
  PFDs, LDA)
```

Three layers:

| Layer | What it does | Key files |
|-------|--------------|-----------|
| **Agents** | Fetch + analyze one member at a time, emit JSON | `agents/pipeline.ts`, `agents/*.ts`, `skills/researcher/fetch.ts` |
| **Warehouse** | 23 tables + 10 views; cross-member queries & pattern substrate | `db/schema.sql`, `db/sync-task.ts`, `db/queries.ts` |
| **Render** | Build the static site from DuckDB | `render/build.ts` → `site/` |

The investigative core is SQL: views like `v_trades_near_votes`, `v_suspicious_trades`, and
`v_trade_bill_nexus` surface trade-vs-vote timing and committee jurisdiction **without** baking in a
"guilt score." LLMs are used only for the narrative layer (bios, summaries), and always on top of
deterministically-verified facts.

### Agent order (on `main`)

`Researcher → Data Checker → Predictor* → Connection Mapper → Trade Analyst → Revolving Door →
Summarizer → Code Checker → Final Reviewer → sync → render`

- `*` **Predictor** is skipped by default (only runs when explicitly requested).
- The Phase 1 cleanup is **merged** (`d57abb2`..`6c9eda5`): the legacy **Coder**, **Visualizer**, and
  **Publisher** slots — dead `seed.ts`-era topology nothing on the public site read — are deleted, and
  the **Final Reviewer** is now a pure deterministic gate (its LLM call was stripped).
- **Hard** stages (a failure after retry aborts the run): Researcher, Data Checker, Summarizer.
  **Soft** stages (a failure logs a warning and the run continues without that section): Connection
  Mapper, Trade Analyst, Revolving Door, Code Checker.

---

## Requirements

- **Node.js 20+**
- [`tsx`](https://github.com/privatenumber/tsx) — used to run the TypeScript directly (installed as a
  dev dependency; everything runs via `npx tsx ...`)
- API keys (see below)

There is no build step and no `dev`/`start` script — you invoke the pipeline CLI directly with `tsx`.

## Setup

```bash
npm install
cp .env.example .env   # then fill in your keys (see below)
```

### `.env`

| Variable | Purpose | Required |
|----------|---------|----------|
| `CONGRESS_API_KEY` | Congress.gov — member identity, bills, cosponsors | yes |
| `OPENFEC_API_KEY` | OpenFEC — donors and Super PAC independent expenditures | yes |
| `ANTHROPIC_API_KEY` | Claude — summarizer / narrative agents | for LLM agents |
| `XAI_API_KEY` | Grok — researcher / devil's-advocate | for LLM agents |
| `LLM_MODEL`, `LLM_SUMMARIZER_MODEL`, `LLM_TRADE_MODEL`, `LLM_REVIEWER_MODEL` | per-agent model overrides | optional |
| `CIVICLENS_USE_CLAUDE_API=1` | use the Anthropic API directly instead of shelling out to the local `claude` CLI | optional |

> By default the LLM agents shell out to a local `claude` CLI (Claude Code OAuth). On a headless
> server or CI, set `CIVICLENS_USE_CLAUDE_API=1` and provide `ANTHROPIC_API_KEY`.

All paths are derived from the repo root by `lib/paths.ts`, so the project runs from wherever you
clone it. The DuckDB file lives at `data/civiclens.duckdb` and caches under `data/caches/`.

---

## Usage

Run `--help` to see everything:

```bash
npx tsx agents/pipeline.ts --help
```

### Common commands

```bash
# Run the full pipeline for one member (--force bypasses the 24h research cache)
npx tsx agents/pipeline.ts "Marjorie Taylor Greene" [--force]

# Add a member to names.txt, run, and auto-apply
npx tsx agents/pipeline.ts --append "Some Representative"

# Run several in parallel (default concurrency 3 — see caveat below)
npx tsx agents/pipeline.ts --batch names.txt [n]

# Inspect runs
npx tsx agents/pipeline.ts --list
npx tsx agents/pipeline.ts --status <task-id>

# Build the static site into ./site/
npx tsx agents/pipeline.ts --render
```

### Bulk data loaders

These ingest primary-source datasets into DuckDB (most are idempotent; add `--dry-run` to preview):

```bash
npx tsx agents/pipeline.ts --load-pfd <year[,year]>        # House Clerk PFD trades
npx tsx agents/pipeline.ts --load-senate-ptr               # Senate EFDS PTRs
npx tsx agents/pipeline.ts --load-fec-ie <cycle[,cycle]>   # FEC Super PAC independent expenditures
npx tsx agents/pipeline.ts --load-opensecrets <cycle>      # cached OpenSecrets industry HTML
npx tsx agents/pipeline.ts --load-bills [--api-pass]       # backfill votes.bill_id + bill summaries
npx tsx agents/pipeline.ts --load-sponsored [member-id]    # authoritative sponsor rows + policy area
```

> **OpenSecrets** is harvested separately via a browser step (Cloudflare-protected); `--load-opensecrets`
> only parses the cached HTML. See `SOURCES.md`.

### Pattern detection

```bash
npx tsx pipeline/run-patterns.ts --all     # run detectors, upsert into pattern_hits
```

Detectors live in `pipeline/patterns/` and use permutation null models for statistical honesty.

---

## Tests

```bash
npm test     # runs the pattern-subsystem unit tests (pipeline/patterns/*.test.ts)
```

Test coverage is currently limited to the pattern subsystem; the fetch/sync/render paths are not yet
covered.

---

## Reproducing the site from a fresh clone

`site/`, `data/*.duckdb`, and `pipeline/task-*/` are **gitignored** — a clean checkout does not contain
built output or data. To reproduce:

1. `npm install` and configure `.env`
2. Run the bulk loaders for the datasets you want (PFD, FEC, bills, …)
3. Run the pipeline for the members in `names.txt`
4. `npx tsx pipeline/run-patterns.ts --all`
5. `npx tsx agents/pipeline.ts --render` → open `site/index.html`

---

## Known caveats

- **DuckDB is single-writer.** Batch mode runs members in parallel but they share one `.duckdb` file;
  heavy parallelism can contend on the write lock. Lower concurrency if you see sync warnings.
- **Render can hit live FEC** for outside-spending data at build time, so rebuilds aren't fully
  offline/reproducible yet.
- **PFD member matching** is name/state based with a `match_confidence` column — verify low-confidence
  attributions.
- Several docs predate the current architecture; see the status note at the top.

---

## Repository layout

```
agents/      pipeline orchestrator + per-agent logic
skills/      agent contracts (CONTRACT.md) and the researcher fetch layer
db/          schema.sql, loaders (load-*.ts), sync-task, queries
lib/         paths, types, schemas, shared helpers (fec-ie, etc.)
pipeline/    run-patterns + patterns/ detectors; task-*/ run artifacts (gitignored)
render/      build.ts (static site) + connections-to-vault.ts
data/        civiclens.duckdb + caches/ (gitignored)
site/        generated static site (gitignored)
```

---

*Non-partisan. Primary sources only. The goal is to make congressional behavior legible — let the
data speak plainly.*
