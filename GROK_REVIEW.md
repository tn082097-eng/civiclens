<!--
  Provenance: external adversarial review of CivicLens by Grok (xAI), acting in its critic-only role.
  Generated read-only via `grok --permission-mode plan` (plan mode forbids edits) on 2026-06-06.
  Grok explored the repo with its own read tools; this file is its captured stdout, lightly framed.
  Raw output: ~/grok-workspace/reviews/20260606-083446-civiclens-project.md
  Review prompt: ~/grok-workspace/inputs/civiclens-project-review.md
  These are Grok's opinions, not verified facts — treat findings as leads to confirm, not gospel.
-->

# CivicLens — Grok's Review

> External, adversarial-but-fair assessment by Grok (read-only), 2026-06-06.
> Grok did not build this project and could not modify it; everything below is its own
> reading of the code. File/line references are Grok's — verify before acting.

## What this project is

CivicLens is a **local-first congressional transparency pipeline** that ingests primary-source political data, runs it through a sequential multi-agent workflow, lands everything in a **DuckDB warehouse** (`data/civiclens.duckdb` via `lib/paths.ts`), and renders a **static HTML site** (`render/build.ts` → `site/`). The editorial stance is explicit and serious: primary sources only, neutral framing, trade-before-vote timing, fail loudly rather than invent data.

The runtime shape I read in the code:

1. **Orchestrator** — `agents/pipeline.ts` (~521 lines) drives the flow, writes per-task JSON under `pipeline/task-<id>/`, and calls `db/sync-task.ts` after Researcher and again after Final Reviewer.
2. **Agents** (13 slots in `lib/types.ts`, 11+ actually run) — Researcher → Data Checker → Predictor → Connection Mapper → Trade Analyst → Revolving Door → Summarizer → Coder → Code Checker → Visualizer → Final Reviewer, with optional Publisher (`agents/publisher.ts`).
3. **Warehouse** — `db/schema.sql` defines **20 tables** and **10 views**, including investigative joins like `v_trades_near_votes`, filtered `v_suspicious_trades`, LDA tables (`lda_filings`, `lda_lobbyists`), and `pattern_hits` for post-pipeline pattern discovery.
4. **Post-pipeline analytics** — `pipeline/run-patterns.ts` (not an agent) runs deterministic detectors from `pipeline/patterns/registry.ts` (`trade-vote-alignment`, `spousal-trade-timing`, `donor-sector-vote-alignment`) and upserts into `pattern_hits`.
5. **Render** — `render/build.ts` (~2,089 lines) reads DuckDB via `db/queries.ts`, optionally hits live FEC for outside spending (`lib/fec-ie.ts`), and emits member pages with trade-vote tables, pattern cards, donor networks, etc.

Data enters through two lanes: **per-member agent fetch** (`skills/researcher/fetch.ts` — Congress.gov identity, GovTrack votes, OpenFEC donors) and **bulk loaders** (`db/load-pfd.ts`, `db/load-lda.ts`, `db/load-bill-summaries.ts`, `db/load-opensecrets.ts`, plus a dozen more documented in `db/LOADER-INPUT-MAP.md`). PFD trades get member-linked via last-name/state resolution in `db/load-pfd.ts` with explicit `match_confidence` / `match_method` columns.

The project has clearly evolved past its own overview doc: `PROJECT_OVERVIEW.md` still describes an "11-agent pipeline" and lists Revolving Door as a blocker, but `agents/revolving-door.ts` is wired into `agents/pipeline.ts` (lines 191–195) and queries `lda_lobbyists` / `lda_filings`. Trade Analyst (`agents/trade-analyst.ts`) is likewise live and DB-backed against `v_suspicious_trades`.

---

## Architecture assessment

**What fits well**

The **three-layer split** is coherent:

| Layer | Role | Key files |
|-------|------|-----------|
| Artifact lane | Per-run audit trail, human-inspectable JSON | `pipeline/task-*/{agent}.json`, `state.json` |
| Warehouse lane | Cross-member queries, views, pattern substrate | `db/schema.sql`, `db/queries.ts`, `db/sync-task.ts` |
| Presentation lane | Deterministic HTML from DB | `render/build.ts` |

The **deterministic-vs-LLM boundary** is thoughtfully drawn in the highest-risk places:

- **Connection Mapper** (`agents/connection-mapper.ts`): Stage 1 is pure code (`computeSharedDonors`, `computeSharedCommittees`) against `loadCorpus()` from DuckDB; Stage 2 LLM is explicitly narrative-only with slug filtering (lines 158–203).
- **Trade Analyst**: SQL ranking rubric in `agents/trade-analyst.ts` (lines 136–189) is deterministic; LLM only writes the paragraph from pre-ranked findings.
- **Summarizer** (`agents/summarizer.ts`): three-stage pipeline — deterministic scaffolding → LLM JSON → post-process with neutrality checks and **token grounding** against researcher corpus (lines 129–152).
- **Pattern discovery**: fully code-driven with permutation null models (`pipeline/patterns/_permutation.test.ts`); render reads stats honestly (`render/build.ts` lines 1129–1164).

**CONTRACT.md over SKILL.md** (`agents/shared.ts` `loadSkill()`) is a good pattern for agent behavior contracts. `db/LOADER-INPUT-MAP.md` is unusually clear about loader inputs — rare in solo projects.

**Schema design** shows real domain thinking: `v_suspicious_trades` documents why GS/MF/ETF rows are excluded; `bill_mentions_ticker` is a signal, not a score; `pattern_hits` deliberately avoids a PRIMARY KEY because of a documented DuckDB index bug (`db/schema.sql` lines 480–506).

**Weak seams**

- **`pipeline/` is overloaded**: it holds ~190 task artifact dirs *and* source code (`pipeline/patterns/`, `run-patterns.ts`). `.gitignore` acknowledges historical parallel dirs (`pipeline-grok/`, `pipeline-hybrid/`) — topology debt even if those dirs are empty in-repo now.
- **Dual source of truth**: agent JSON files are "source of truth for the run" (`db/sync-task.ts` line 6) while DuckDB is "source of truth for cross-corpus queries." Sync is best-effort (warn-and-continue on failure in `agents/pipeline.ts` lines 156–157, 233–234).
- **Publisher / seed path is a fossil**: `agents/publisher.ts` still writes to `SEED_PATH = ~/civiclens/src/db/seed.ts` (`agents/shared.ts` line 19) while the live site path is `render/build.ts` from DuckDB. Two publishing models coexist.
- **`brain` agent slot** is initialized in `agents/shared.ts` `initTask()` but never executed — dead topology in the state machine.

---

## Strengths

1. **Primary-source discipline is enforced in code, not just docs.** `agents/researcher.ts` line 49 explicitly fails when fetch returns null ("stub data disabled"). `skills/researcher/fetch.ts` builds bios deterministically from Congress.gov metadata (lines 637–661) and rejects Wikipedia as a bio source.

2. **Investigative SQL is first-class.** `v_trades_near_votes` exposes `days_from_trade_to_vote`, committee jurisdiction (`member_on_bill_committee`), and bill context without baking in a "guilt score." `v_suspicious_trades` adds thoughtful noise reduction. This is the project's sharpest asset.

3. **LLM guardrails are layered.** Neutrality word lists with word-boundary matching (`agents/shared.ts` lines 348–374), summarizer grounding, connection-mapper slug filtering, and a 10-point Final Reviewer checklist (`agents/final-reviewer.ts` lines 21–32). The design assumes models will misbehave and plans for it.

4. **Pattern rigor pillar is real.** Permutation tests with seeded RNG, honest "unscored" rendering when `null_model IS NULL`, and three passing unit tests in `pipeline/patterns/*.test.ts`. This is more statistically serious than most "AI transparency" projects.

5. **Operational awareness in comments.** DuckDB single-writer lock handling (`db/init.ts` `closeDb()`, `agents/pipeline.ts` `regenerateVault()`), FEC ID backfill surfacing (`sync-task.ts`), PFD filer resolution confidence — the authors have been burned and documented it.

6. **Path independence.** `lib/paths.ts` derives everything from repo root; the project survived relocation out of a Hermes app directory.

---

## Risks & weaknesses

### Blocking

- **[blocking] Documentation is dangerously stale relative to code.** `PROJECT_OVERVIEW.md` claims 11 agents, 10 tables + 6 views, and "Revolving Door" as the current blocker — but `agents/pipeline.ts` runs Trade Analyst + Revolving Door, and `db/schema.sql` has 20 tables + 10 views. `README.md` is literally two lines (`# ugh` / `asdf`). A new contributor will misread system state immediately.

- **[blocking] Schema evolution has no general migration story.** `db/init.ts` `applySchema()` only runs `CREATE TABLE IF NOT EXISTS` / `CREATE OR REPLACE VIEW` via semicolon splitting (lines 44–59). Column additions for existing tables rely on one-off scripts like `db/migrate-pattern-hits.ts` (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`). Adding a non-nullable column or renaming anything will silently diverge DBs across machines.

- **[blocking] Batch concurrency vs DuckDB single-writer.** `agents/pipeline.ts` `runBatch()` runs up to 3 pipelines in parallel (lines 268–304), each calling `syncTask()` → `getDb()`. DuckDB is single-writer per file (`db/init.ts` lines 31–35). Parallel batch runs risk lock contention, partial syncs, or race-y writes unless carefully serialized — the code does not appear to mutex around DB access.

### Concern

- **[concern] `v_trades_near_votes` is a member-level trade×vote cross join** (`db/schema.sql` lines 323–324: `JOIN votes v ON v.member_id = t.member_id` with no day window in the view). The 16,427+ pair count cited in `PROJECT_OVERVIEW.md` is structurally expected but expensive and easy to misread; filtering happens downstream in agents/views, not at the join.

- **[concern] Trade scoring rubric is duplicated.** The 0/3-day + committee scoring appears in `agents/trade-analyst.ts` (lines 145–151), inline SQL in the same file, and again in `render/build.ts` `rowIntensityScore()` (lines 92–109). Drift between agent narrative weighting and rendered badges is likely over time.

- **[concern] LLM transport depends on local `claude` CLI subprocess** (`agents/shared.ts` lines 180–221). Default path strips `ANTHROPIC_API_KEY` and shells out to Claude Code OAuth. CI, headless servers, and contributors without Claude Desktop will hit opaque spawn failures. API fallback exists (`CIVICLENS_USE_CLAUDE_API=1`) but is opt-in.

- **[concern] Final Reviewer model/docs mismatch.** Comment in `agents/final-reviewer.ts` line 12 says "default pins to Haiku" but line 13 sets `claude-sonnet-4-6`. `PROJECT_OVERVIEW.md` table says Haiku 4.5 for Final Reviewer. QC gate behavior will vary with model cost/capability without anyone noticing.

- **[concern] Render still hits live FEC at build time** (`render/build.ts` line 1263 `fetchSuperPacIE`) despite `super_pac_ie` tables and `db/load-fec-ie.ts` existing. Static site rebuilds are not reproducible offline and can rate-limit or fail partially per member.

- **[concern] PFD member matching uses fuzzy last-name LIKE** (`db/load-pfd.ts` lines 61–63). `state_lastname_ambiguous` is tracked but ambiguous matches can still attach trades to wrong members — high stakes for the core investigative feature.

- **[concern] Revolving door risk model is a documented proxy, not ground truth** (`agents/revolving-door.ts` lines 38–42: filing recency substitutes for "left government" date; last-name regex matching lines 76–78). False positives are acknowledged in comments but will surface on member pages as narrative.

- **[concern] `controversies` is permanently empty.** `agents/researcher.ts` line 78 hardcodes `controversies: []`; `db/schema.sql` has a `controversies` table; Summarizer renders "None on record" — dead schema surface.

- **[concern] Test coverage is minimal.** `package.json` `"test"` runs only `pipeline/patterns/*.test.ts` (3 files). Zero tests for Researcher fetch, Data Checker Zod path, PFD resolution, sync-task, or render XSS/escaping. For a data-integrity project, this is thin.

- **[concern] Dead / parallel topology accumulates.** Unused: `loadOtherResearchers()` in `agents/researcher.ts` (superseded by `loadCorpus()` per comment, never called). Unwired: `agents/devils-advocate.ts` (explicitly not imported by `pipeline.ts`). Reserved: `skills/code-reviewer/SKILL.md` with no `agents/code-reviewer.ts`. Initialized but never run: `brain` agent slot. Legacy: Publisher → `~/civiclens/src/db/seed.ts`. Side channels: `agents/whatsapp.ts` / `agents/telegram.ts` still read `STUB_PATH` stub data, bypassing the live pipeline.

- **[concern] `pipeline/` directory naming collision.** Task artifacts (`pipeline/task-*/`, gitignored) share a parent with production source (`pipeline/patterns/`). `.gitignore` line 18–24 shows awareness of past `pipeline-grok/` and `pipeline-hybrid/` experiments — evidence of prior forked pipelines that may still exist on developer machines.

### Nit

- **[nit] GovTrack pagination failures now log warnings** (`skills/researcher/fetch.ts` lines 123–125, 550–552) — `PROJECT_OVERVIEW.md` "Known Brittle Points" is outdated on this item.

- **[nit] `render/build.ts` at 2,089 lines** is a second monolith after the pipeline split; member page sections would benefit from extraction.

- **[nit] Hardcoded model IDs** (`claude-haiku-4-5-20251001`, `claude-sonnet-4-6`) throughout `agents/shared.ts`, `agents/trade-analyst.ts`, `agents/summarizer.ts` — will rot on API deprecation.

- **[nit] `skills/researcher/CONTRACT.md` JSON example still mentions Wikipedia bio** (line 38) while `fetch.ts` forbids it — contract sample lags implementation.

- **[nit] Data Checker auto-corrects before Zod** (`agents/data-checker.ts` lines 20–73) — clamping future dates to today and defaulting invalid donor types to `individual` can mask upstream fetch bugs rather than surfacing them.

---

## Recommendations

**P0 — Make the repo legible to outsiders**

1. Replace or rewrite `README.md` from `PROJECT_OVERVIEW.md`, updating agent count (13 slots, ~11 active), table/view counts, and removing stale blockers. Add a single architecture diagram: fetch → agents → `pipeline/task-*` → `sync-task` → DuckDB → `run-patterns` → `render/build`.
2. Delete or archive dead paths: `loadOtherResearchers()`, unused `brain` slot, or wire `devils-advocate` / `code-reviewer` with explicit opt-in flags documented in `SOLO.md`.

**P0 — Data integrity & reproducibility**

3. Add a **`db/migrate.ts` runner** that applies ordered migration scripts (pattern established by `db/migrate-pattern-hits.ts`) and records `schema_version` in DuckDB. Stop relying on `CREATE IF NOT EXISTS` alone for evolved columns.
4. **Serialize DuckDB writes in batch mode** — mutex around `syncTask()` / `getDb()` or run batch concurrency at 1 for sync steps while keeping LLM/API fetches parallel.
5. **Extract shared trade-scoring** into one module (e.g. `lib/trade-scoring.ts`) consumed by Trade Analyst SQL generation, `render/build.ts`, and pattern detectors.

**P1 — Close the deterministic/LLM boundary gaps**

6. **Move FEC outside-spending fully offline**: render should read `super_pac_ie` / `super_pac_ie_filings` populated by `--load-fec-ie`, with live fetch only as explicit `--live-fec` fallback in `render/build.ts`.
7. **Tighten PFD matching**: require `match_confidence >= 0.95` (or manual override table) before rows enter `v_suspicious_trades`; surface unmatched filers on `site/index.html` as a data-quality panel.
8. **Populate or drop `controversies`**: either add a deterministic controversies fetcher with primary-source URLs or remove the table/column references from schema and summarizer prompts.

**P1 — Testing**

9. Add vitest/tsx tests for: `normalizeDonorName` / shared-donor joins, PFD `resolveFiler()` ambiguous cases, `sync-task` round-trip on a fixture `researcher.json`, and `esc()` in render. Even 20 tests would dramatically raise confidence.

**P2 — Structural cleanup**

10. **Split `pipeline/`**: move `pipeline/patterns/` and `run-patterns.ts` to `analysis/patterns/` or `db/patterns/`; keep `pipeline/` for task artifacts only (or rename artifacts to `runs/`).
11. **Retire Publisher/seed path** or gate it behind `--legacy-seed`; document that `npx tsx render/build.ts` is the only publish path.
12. **Extract `render/build.ts`** into `render/member-page.ts`, `render/trades-section.ts`, `render/patterns-section.ts` — the file is doing too much.

**P2 — Operations**

13. Document LLM prerequisites: Claude Code CLI vs `CIVICLENS_USE_CLAUDE_API=1`, model override env vars (`LLM_SUMMARIZER_MODEL`, `LLM_TRADE_MODEL`, `LLM_REVIEWER_MODEL`).
14. Wire `pipeline/run-patterns.ts --all` into the post-batch hook in `agents/pipeline.ts` (after successful batch, before render) so pattern cards are not stale.

---

## Verdict

CivicLens is **architecturally sound for a solo research pipeline** — the DuckDB investigative views, primary-source fetch discipline, and deterministic-first / LLM-narrator split are genuinely good design choices rare in this space. The codebase reads like people who ship and debug real data, not a demo.

The single most important thing to fix is **operational truthfulness**: stale docs (`PROJECT_OVERVIEW.md`, empty `README.md`), dual publishing models (DuckDB render vs Hermes `seed.ts`), and unserialized batch DB sync create a gap between what the project *claims* to be and what a clean checkout *actually* runs. Close that gap before adding more agents or automation — otherwise every new feature will fork another parallel pipeline directory.
