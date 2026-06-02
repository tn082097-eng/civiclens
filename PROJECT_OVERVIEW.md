# CivicLens — Project Overview

CivicLens is a political transparency research tool. It fetches live data from primary sources (Congress.gov, OpenFEC, GovTrack, House Clerk), runs it through a mostly-deterministic pipeline with a thin semantic layer, and publishes a static site showing trade-vote proximity, donor networks, and co-sponsorship patterns for US politicians. The site is built entirely by `render/build.ts` reading DuckDB views — the analytical logic lives in SQL, not in agents.

---

## Root: `~/Developer/civiclens/`

| Path | Purpose |
|------|---------|
| `agents/pipeline.ts` | Orchestrator + CLI (~385 lines). Imports from per-agent modules below. |
| `agents/shared.ts` | Shared infra: logging, task I/O, LLM wrapper, env loading, constants. |
| `agents/researcher.ts` | Researcher agent + `loadOtherResearchers` legacy helper. |
| `agents/data-checker.ts` | Data Checker agent (Zod validation + auto-correct). |
| `agents/predictor.ts` | Predictor agent (delegates to `skills/predictor/predict.ts`). |
| `agents/connection-mapper.ts` | Connection Mapper + `computeSharedDonors` + `computeSharedCommittees`. |
| `agents/summarizer.ts` | Summarizer agent (3-stage: deterministic → LLM → post-process). The site's semantic layer. |
| `agents/trade-analyst.ts` | Trade Analyst — `members.trade_activity` (deterministic) + optional LLM narrative. |
| `agents/revolving-door.ts` | Revolving-Door matcher (LDA × member); narrative (Phase 2: not yet rendered). |
| `agents/code-checker.ts` | Neutrality + date gate (deterministic, no LLM). |
| `agents/final-reviewer.ts` | Final Reviewer — **deterministic** QC gate; sets `readyToApply` from Data Checker + neutrality + completeness. |
| `db/schema.sql` | Single source of truth for DuckDB schema (10 tables, 6 views). |
| `db/init.ts` | DuckDB singleton. DB file: `data/civiclens.duckdb` (path via `lib/paths.ts`). |
| `db/queries.ts` | Public typed query API (findTradesNearVotes, findSharedDonors, etc.). |
| `db/load-from-tasks.ts` | Bulk-loads pipeline task dirs → DuckDB. |
| `db/load-pfd.ts` | Ingests House Clerk PTR PDFs → `pfd_transactions`. |
| `db/load-bill-summaries.ts` | Backfills `votes.bill_id` + fetches Congress.gov summaries. |
| `db/load-bill-committees.ts` | Fetches bill committee assignments; backfills `committee_canonical`. |
| `db/sync-task.ts` | Incremental single-task sync + `loadCorpus()` for cross-member data. |
| `render/build.ts` | Generates static HTML site from DuckDB. |
| `site/` | Output: `index.html`, `network.html`, `members/<slug>.html` (33 pages). |
| `skills/<name>/` | Per-agent CONTRACT.md (wins over SKILL.md) + supporting code. |
| `names.txt` | 20 target politicians (bipartisan). |
| `SOLO.md` | Quick-reference CLI commands. |
| `IDEAS.md` | Feature backlog. |

---

## The Pipeline (actual, post-Phase-1)

Stages run sequentially, each writing JSON to `pipeline/<task-id>/<agent>.json`. The
publish path is **agents → JSON → `sync-task`/`load-from-tasks` → DuckDB → `render/build.ts`**.
There is no `seed.ts` and no LLM "brain" — orchestration is the deterministic `runPipeline()`
in `pipeline.ts`.

```
Researcher → Data Checker → [Predictor] → Connection Mapper → [Trade Analyst]
  → [Revolving-Door] → Summarizer → Code Checker → Final Reviewer
  → sync-task (→ DuckDB) → render/build
```

| Stage | Type | LLM |
|-------|------|-----|
| Researcher | data-fetch (Congress.gov / OpenFEC / GovTrack APIs) | no |
| Data Checker | Zod validation + auto-correct | no |
| Predictor | voting-pattern baseline models (skipped by default) | no |
| Connection Mapper | shared donors/committees (SQL) + stage-2 narration (vault only) | Haiku 4.5 — Phase 2: → SQL |
| Trade Analyst | `trade_activity` deterministic; narrative optional | optional |
| Revolving-Door | LDA × member match; narrative | optional |
| Summarizer | bio + neutral narrative — **the semantic layer** | Sonnet 4.6 |
| Code Checker | neutrality + date gate | no |
| Final Reviewer | deterministic QC gate → `readyToApply` | **no (Phase 1)** |

Removed in Phase 1 (legacy `seed.ts` plumbing, no longer fed the site): **Coder,
Visualizer, Publisher**, and the stale `lib/state.ts`. See `plans/pipeline-simplification-agile-quasar.md`.

---

## Key CLI Commands

```bash
# Run full pipeline for one politician
npx tsx agents/pipeline.ts "Name"

# Batch run (parallel, default concurrency 3)
npx tsx agents/pipeline.ts --batch names.txt [concurrency]

# Load PFD stock trades
npx tsx agents/pipeline.ts --load-pfd 2024 [--dry-run]

# Load bill summaries from Congress.gov
npx tsx agents/pipeline.ts --load-bills [--limit N]

# Rebuild static site
npx tsx agents/pipeline.ts --render

# Status / list
npx tsx agents/pipeline.ts --list
npx tsx agents/pipeline.ts --status <task-id>

# Manual apply (after review)
npx tsx agents/pipeline.ts --apply <task-id>
```

---

## Data Sources & Env Vars (`~/Developer/civiclens/.env`, repo-local)

| Var | Source |
|-----|--------|
| `CONGRESS_API_KEY` | api.congress.gov |
| `OPENFEC_API_KEY` | api.open.fec.gov |
| `ANTHROPIC_API_KEY` | Claude API |
| `XAI_API_KEY` | xAI Grok (optional) |
| `LLM_MODEL` | Override default model (e.g. `grok-3`) |
| `LLM_SUMMARIZER_MODEL` | Override summarizer model |
| `CIVICLENS_PIPE_DIR` | Override pipeline task dir |

---

## Current State (as of 2026-04-30)

- **35 member pages live** on the site
- **20 full pipeline runs** completed
- **Trade Analyst agent** now live — flags suspicious trades + generates narratives
- **Trade-vote proximity**: 16,427+ pairs (8,217+ where trade preceded vote)
- **Brier score**: 0.2378 on proximity predictions
- **DuckDB**: `civiclens.duckdb` with 10 tables + 6 views, fully synced

---

## Completed (archived)

1. ~~**Fix vote data gap**~~ — **DONE 2026-04-28**
2. ~~**Break up `pipeline.ts` monolith**~~ — **DONE 2026-04-28**: 1,938→385 lines; 10 agent modules
3. ~~**Add API retry/backoff**~~ — **DONE 2026-04-28**
4. ~~**Re-enable neutrality checker**~~ — **DONE 2026-04-28**
5. ~~**Add site search + cross-member queries**~~ — **DONE 2026-04-28**

---

## Next Priorities (as of 2026-04-30)

### High Priority
- **Revolving Door Agent** — Build dedicated agent using LDA bulk data + DuckDB corpus to detect former staffers now lobbying the member or their committee
- **Daily Automation** — Full end-to-end cron pipeline (new filings → preprocessing → DuckDB sync → alerts)
- **Smart Shared Donor Alerts** — Filter out weak PAC/industry overlaps; flag only high-risk individual/company pay-to-play patterns

### Medium Priority
- **Spouse / Family Trading Risk Flags** — Use historical patterns as permanent risk multiplier on current trades
- **Member Page Enhancements** — Add suspicion badges, trade-vote timeline visualization, and revolving door callouts
- **Non-Stock Transparency** — Foreign travel, book deals, earmarks, and campaign payroll to family

### Nice-to-Have
- Browser Harness integration for fully autonomous filing scraping
- Brier score tracking dashboard + anomaly detection
- Public export of raw DuckDB views / API endpoints

**Current blocker:** Revolving Door data ingest + matching logic

---

## Known Brittle Points

- GovTrack pagination `catch { break }` swallows errors silently — consider logging
- `pipeline.ts` is now 385 lines (orchestrator + CLI only); agents are in per-file modules
- Neutrality checker active; word list may need tuning as more members are processed
- Two data-access paths for corpus (legacy file scan + DB-backed) — legacy not yet removed
- No tests (vitest/playwright mentioned in CLAUDE.MD but zero test files)
- Hardcoded model names; will break when API retires them
- `controversies` field always empty — nothing populates it downstream
- `code-reviewer` agent slot reserved but never implemented

---

## Editorial Rules (non-negotiable)

- Primary sources only — never invent or stub data
- Neutral framing — no charged language ("radical", "corrupt", "hero")
- "Before not after" — report what happened before decisions, not after
- Fail loudly rather than fall back to LLM-generated data
