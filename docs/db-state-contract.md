# DB State Contract

> **Purpose.** Kill a false assumption: that `data/civiclens.duckdb` can be rebuilt
> exactly from committed code. It cannot. CivicLens is **a long-lived analytical
> database with Git-managed transformation tools** — not a deterministic pipeline.
> This file states which parts of the DB are reproducible, which are accumulated
> runtime state, and the rules that keep code and DB from silently diverging.

## The three layers (they are not the same thing)

- **Code (Git):** the loaders, seeders, resolver, schema DDL. Evolves in branches.
- **DB (runtime truth):** already mutated, already seeded, already carries state
  created *outside* any migration. `data/` is fully gitignored (`*.duckdb`,
  `data/caches/`, `data/imports/`) — **0 tracked files under `data/`**.
- **Reproducibility (partial):** no migration framework. A few committed
  `backfill-*.ts` scripts exist; most schema/data changes are `CREATE IF NOT EXISTS`
  + inline `ALTER` + occasional out-of-band repairs. Lineage is **incomplete by design.**

**Consequence:** merging a feature branch merges *code only*. The DB side-effects of
that branch may already be live. Branch and DB must be **reconciled**, never assumed
in sync. You merge to *align code with an already-mutated system*, not to preserve
reproducibility.

## Reproducibility taxonomy

### Layer D — Deterministic (MUST stay exactly reproducible)
Pure function of committed code + documented public sources. If lost, rebuild is exact.

| Object | Rebuilt by | Source |
|---|---|---|
| schema (all tables/cols/indexes) | `db/init.ts applySchema()` → `db/schema.sql` | committed |
| `member_aliases` (~26k rows) | `db/load-member-aliases.ts` | `legislators-{current,historical}.yaml` (public: unitedstates/congress-legislators) |
| `donor_industry_theme` | `db/load-sector-crosswalk.ts` | committed ILIKE crosswalk |
| `ticker_sectors` | `db/load-ticker-sectors.ts` | committed |
| `sic_theme`, `theme_bill_match`, `ticker_theme_override` | *(verify seeder — `ticker_theme_override` name implies manual overrides)* | ? |
| all `v_*` views | schema/query SQL | committed (pure over base tables) |
| `pattern_hits`, `predictions` | `pipeline/run-patterns.ts`, predictor | computed over base tables (deterministic *given* the tables) |

### Layer A — Accumulated ingestion (BEST-EFFORT only; not exactly reproducible)
Built from live, point-in-time, rate-limited, or manually-harvested sources. Re-fetching
approximates; it does not restore.

- `members` — Congress.gov roster + `names.txt` curation + manual dedup/repairs
- `donors`, `donor_industry` — **OpenSecrets via browser-harness (Cloudflare-gated, manual, point-in-time)**
- `votes`, `bills`, `bill_committees`, `bill_subjects`, `bill_summaries` — Congress.gov (point-in-time)
- `committees` — Congress.gov + canonicalization
- `pfd_transactions` — House/Senate PFD & PTR filings (scraped, cached)
- `lda_filings`, `lda_lobbyists` — Senate LDA (paginated)
- `super_pac_ie`, `super_pac_ie_filings` — FEC Schedule E/A (point-in-time)
- `controversies` — *(agent/researcher output — verify provenance)*
- `pipeline_runs` — runtime audit log; **irreproducible by definition**

### Out-of-band mutations (HAZARD — currently exist only in the DB)
Transformations applied to existing rows with a backup but **no committed script**:

- ~~`UPDATE members SET chamber = LOWER(chamber)` — 2026-07-03, this session.~~
  **RESOLVED:** now an ingestion-time invariant — `db/load-from-tasks.ts` normalizes
  `chamber` to lowercase at the sole `members` write boundary, so the repair can never
  be needed again. (Live rows were already lowercased once; the invariant keeps them so.)
- Sanders `bernard-sanders`→`bernie-sanders` merge (per STATUS; `.bak-pre-sanders-merge`).
- Committee recanonicalization (strip leading "the ") — *may* be codified in
  `db/backfill-committees.ts` (verify) vs the manual op STATUS describes.

Partial discipline that DOES exist (the model to follow): `db/backfill-bioguide.ts`,
`db/backfill-committees.ts`, `db/backfill-fec-candidate.ts`.

## Contract (the rules)

1. **The DuckDB is authoritative runtime state.** It is gitignored and NOT exactly
   rebuildable from source. Do not treat "rerun the loaders" as a restore path.
2. **Reproducibility is bounded:** Layer D exact; Layer A best-effort; some rows exist
   only because of point-in-time fetches + out-of-band repairs.
3. **`.bak-*.duckdb` snapshots are the record of pre-repair states.** They are
   artifacts, not scratch. Do not delete without a newer snapshot.
4. **No inline data mutations.** Any change to existing rows MUST be a committed
   `db/backfill-*.ts` (or seeder), never an ad-hoc query. (This session violated it once.)
5. **The resolver reads the DB for slug identity** (`resolveMember` → `SELECT member_id
   WHERE bioguide_id`). The DB's existing slugs are an authoritative *input* to the code.
   This is intentional; it also means code and DB are coupled — see rule 2.

## Minimal "must reproduce" core
If the DB were lost, the recoverable-exactly set is **Layer D only** (schema + derived
tables). Layer A is re-fetched best-effort. Design new work so that anything
correctness-critical lives in Layer D or in a committed `backfill-*.ts`; treat Layer A
as append-only research state.
