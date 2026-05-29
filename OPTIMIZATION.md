# CivicLens — Optimization Plan (calibrated)

Synthesised from a three-model review (2026-05-28): Claude (methodology/breadth),
Grok (integrity/operability), ChatGPT (generic best-practices). Calibrated to the
project's actual scale — **solo, ~48 members, single embedded DuckDB, one machine** —
not to an enterprise deployment.

## Core invariant (do not violate)

**Deterministic spine, nondeterministic edges.** Keep: DB deterministic · loaders
authoritative · views as truth · AI isolated from writes · browser automation
quarantined. Every item below *tightens* this invariant rather than expanding
infrastructure. This restraint is the project's strongest asset, not a limitation.

## The hidden moat

The real differentiator is **not** the detectors — many tools can generate
"interesting corruption narratives." Very few can *reproduce, audit, statistically
defend, and trace every claim to source rows.* That is: provenance discipline +
statistical defensibility + deterministic reproducibility. Reinforce that direction.

---

## Calibrated verdict on the full review

| Item | Verdict | Right-sized action |
|------|---------|--------------------|
| DB single-writer contention | **DONE (2026-05-28)** | Root cause was a no-op `closeDb()`. Fixed: `closeDb()` now releases the lock; `regenerateVault()` calls it before spawning. No writer-process/queue needed. |
| Run steps in order | **TODO (small)** | Wrapper: batch → `--load-bills --api-pass` → vault regen. Prevents stale % and lock overlap. |
| Manifest / immutable run snapshots | **TODO (small, high value)** | `runs/<date-batch>/` freezing manifest + prompts + hashes + outputs + detector scores + DB version + git SHA. Feeds the moat (reproducibility). Enables resumable/skippable runs (batch currently can't skip done members). |
| Strict schemas + provenance fields | **Mostly done** | Data Checker already Zod-validates. Add `schema_version`, `generated_by`, consistent `source_urls`. Incremental. |
| Cache AI outputs | **Mostly done** | 24h cache exists; hash prompt+source for true reuse if cost matters. Low priority. |
| Token/cost tracking | **TODO (small)** | Switch `claudeViaCli` to `--output-format json`, sum `usage`, write per-task. Currently usage is discarded. |
| Tier models (cheap for extraction/format) | **Mostly done** | Cheap agents already use Haiku; deterministic code does extraction. |
| **Matched-peer null models** | **ROADMAP — TOP ITEM** | The one genuinely differentiating upgrade. See spec below. |
| Incremental detectors | **Later** | Rerun only changed members. Real win once roster is large; not urgent at 48. |
| Materialize expensive views | **When slow** | Candidate: `v_trade_bill_nexus`. Measure first; premature now. |
| Provenance graph (claim→detector→rows→filing) | **Gradual** | Formalize what `source_url` already implies. Aligns with the moat. |
| Entity resolution layer | **Medium-term** | Canonical member/donor/PAC/spouse table. Names are ad-hoc now (cf. Sanders dedup). |
| Immutable raw archives | **Good, cheap** | Append-only store of raw filings/HTML/PDF/JSON for audit + reproducibility. |
| Confidence surfaces (not binary) | **Gradual** | Represent evidence quality + statistical confidence + source completeness. |

### Explicitly CUT (scale mismatch — would add the "manager layer" the design avoids)
Message queues (Kafka/RabbitMQ) · task-queue frameworks (Celery) · in-memory stores
(Redis) · workflow orchestrators (Temporal/Prefect/Dagster/Airflow) · vector DBs
(Pinecone/Weaviate — there is no RAG here) · microservices · ELK/observability stacks ·
dedicated DB-writer process · split operational/analytical DBs. A plain `cron` + a
wrapper script covers everything these were proposed for.

### Explicitly FORBIDDEN (violates the spine)
Autonomous agent retries that mutate state · self-modifying prompts · dynamic pipeline
branching · **AI-generated loader/SQL writes** · autonomous source ingestion.
Rule: **LLMs propose, deterministic code commits.** (Same principle as the recorded
"no generative Grok in pipeline" decision.)

---

## Spec: Matched-Peer Null Models (the differentiating roadmap item)

**Goal:** move from *correlation spotting* ("trade near relevant vote") to *behavioral
anomaly detection* ("member behaves X× differently from expected baseline"). The
intellectual core becomes: **how do we define expected behavior?**

Four baseline layers, each a null model the observed behavior is scored against:

1. **Member baseline** — the member vs their own history. *Do they normally trade
   defense stocks, or only around Armed Services activity?* Controls for habitual traders.
2. **Peer-group baseline** — vs matched peers: same chamber · committee · party · wealth
   band · trading-frequency band. Avoids over-flagging active traders and under-flagging
   committee-specific behavior.
3. **Sector baseline** — normalize by sector volatility, market-wide events, ETF moves,
   earnings season. Prevents semiconductor/defense/pharma rallies from reading as signal.
4. **Opportunity-window modeling** — replace flat "within N days" with weighted
   informational windows: committee briefing · markup · amendment · closed session ·
   sponsorship timing. Not all congressional events carry equal information value.

Target output shape:
> "This member trades semiconductor equities **4.8× more frequently within 14 days of
> committee actions than matched peers**" — materially stronger analytically *and*
> rhetorically than "a trade happened near a vote."

Builds directly on the existing rigor pillar (permutation + seeded RNG + z-scores);
extend with member/peer/sector baselines and event-weighted windows. Keep all scoring
in deterministic code/SQL — auditable, reproducible, explainable.

---

## Highest-impact order

**Now (small, real):** ✅ DB lock fix · stage sequencing · token tracking · run snapshots.
**Roadmap (big, differentiating):** matched-peer null model.
**Later (when scale/need justifies):** incremental detectors · materialized views ·
entity resolution · provenance graph formalization.
