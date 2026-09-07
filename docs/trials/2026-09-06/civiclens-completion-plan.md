# CivicLens Completion Plan — Track A (finish the ten-member site) + Track B (certify run-any-member)

**Status:** awaiting final approval. Nothing branched, extracted, loaded, rendered, pushed, or deployed.
**Provenance:** dialogue 2026-09-04/06 between the maintainer, Claude, and Codex. Claude drafted, self-reviewed hostilely, Codex reviewed independently and sent eleven corrections, all accepted. This file is the reconciled result.

---

## Context — why this plan exists

CivicLens is a local-first congressional transparency pipeline: primary sources → TypeScript agents → DuckDB → deterministic static HTML. The repo is private and the site is offline by maintainer choice.

Weeks of work have gone into research-shaped tasks (OCR probes, detector baselines, reconciliations) without a visible finish line. This plan fixes a finish line the maintainer named directly:

> **"getting to the point where we can run any member of congress reliably"**

That is a *pipeline property*, not a roster size. It splits into two tracks:

- **Track A** — repair and publish the current ten-member site. It is first because it produces the clean database Track B needs, and because it ends the unshipped backlog.
- **Track B** — certify run-any-member reliability with a six-stratum fresh-member trial.

**Intended outcome:** a corrected live ten-member artifact, and a tracked certification record showing six distinct fresh members each ending in a verified local page or a source-backed disclosure.

### Concrete blockers this plan closes

1. Dirty PTR rows in production — label text embedded in asset names, null mixed-case tickers (per the 2026-08-22 closeout analysis; counts not independently re-verified).
2. `db/load-pfd.ts:346` skips zero-row and missing-identity filings **before** `classifyFiling` (`:386`), so the zero-row `unresolved` verdict is unreachable and never reaches `withheld`.
3. Committed `public/` is a mixed snapshot: five pages stamped `2026-07-28 03:47Z` predate the IE cycle fix; five uncommitted pages stamped `2026-08-22` were rendered from dirty rows.
4. Raw p-values render at `render/build.ts:137` on nine of ten public pages — the receipts section reads as accusations where the data says nothing.
5. Verbatim OpenSecrets industry labels at `pipeline/patterns/donor-sector-vote-alignment.ts:162` reach at least four public pages, violating the substrate-only rule.
6. Scope interface mismatch: `lib/ingest-scope.ts:137` routes `--member` through `normalizeName` (`lib/legislators.ts:77`, whitespace-split) so a hyphenated slug never matches; `pipeline/run-patterns.ts:172` and `pipeline/score-theme-gaps.ts:202` accept **only** `--member <slug>`.
7. No durable *not-collected* / *verified-empty* / *withheld* signal. `db/load-opensecrets.ts:171` detects verified-empty and stores nothing; `render/member-sections.ts:50` renders the same copy for both.
8. `scripts/package-launch.sh:45` freshness guard refuses any listed member whose render is older than the DB — so any reload forces re-rendering all ten.

### Frozen scope — deferred, not in this plan

Scanned-PTR **OCR of any kind**. Timing confirmatory runs (`score-anomaly.ts`, `pipeline/patterns/*-baseline.ts` — ADR 0003, both detectors `registered`/unconsumed). The 12-member OpenSecrets harvest. Corpus pages (`index`/`network`/`nexus`). Money-vote and coherence detectors. STATUS.md rewrite. New dependencies. Unrelated refactors.

### Three open product decisions (recommendations, not settled)

| Id | Decision | Recommended default |
|---|---|---|
| D1 | Does "run" include publishing? | **No** — run ends at a verified local page; publishing stays the ADR 0002 §C gate |
| D2 | Is OpenSecrets required for a base run? | **No** — optional; the page must say *"not collected"*, never *"no data"* |
| D3 | Committed artifact: five pages or ten? | **Five + index + manifest now**; ten only after Gate A4 diff review |

### Standing constraints

- The **PREPTR backup is gone** (verified absent). Current `data/civiclens.duckdb` is the only candidate base. The 417 drifted `fetched_at` values **stay unchanged** — their historical values cannot be honestly reconstructed, and those rows *were* in fact re-read that day.
- The 2026-07-03 pre-identity backup is **not** a restore source for anything here.
- ADR 0003: no confirmatory computation on the parked timing pair, either track. `run-patterns.ts` filters the pair internally under both `--member` and `--all` (`:198-199`), so it carries no confirmatory risk; the hazard is `score-anomaly.ts` and the `*-baseline.ts` runners.
- Never `git stash`, `git reset`, `git clean`, or brace-expansion checkout in either checkout. Restores name each path individually via `git restore`.

---

## Track A — finish the ten-member site

### A0. Freeze scope from authority — **Gate A1**

Do **not** rediscover the repair set. Record, in `docs/trials/<date>/`:

- The **19 launch PTR filing IDs**, taken from the cached House Clerk index (`data/caches/pfd-cache/index/<year>FD.xml`) plus the prior audited roster.
- sha256 of each filing's cached `.pdf` and `.txt`.
- sha256 of current `data/civiclens.duckdb`, after confirming **no `.wal` beside it**.

**Gate A1:** maintainer approves the 19 IDs and the file inventory as frozen scope.

### A1. Candidate branch — **Gate A2**

```
git worktree add ../civiclens-launch -b launch/ptr-closeout 04d23bf
```

Base is `origin/main`, **not** local `main`. Reapply only PTR-required changes as new commits.

The eight non-PTR commits on local main (`53696d8`, `4fc5e13`, `c733967`, `2a2e4d6`, `66ca5a1`, `8bec5e9`, `bb401b5`, `b6794ac` — IE disclosure, FEC-IE delete guard + tests, OpenSecrets test, docs) are reviewed **separately** as **Gate A2**.

> **Consequence to accept:** until Gate A2 passes, the candidate render lacks the IE fetch-failure disclosure. No page depending on it ships before that gate.

### A2. Test-first PTR repairs — one commit each

Red test first, then code. Re-read live line numbers before editing; do **not** trust closeout-doc references.

| Fix | Red test | Change |
|---|---|---|
| Spelled labels | Fixtures from `2022/gottheimer-josh-20020393.txt` (~:238-241) and `2022/pelosi-nancy-20020515.txt` (~:24-26); assert asset carries no `LOCATION:`/`DESCRIPTION:` text and description is populated | Case-tolerant spelled-label patterns beside `LOCATION_RE` (`skills/pfd-fetcher/extract.ts:340`); route to existing fields |
| Mixed-case ticker / asset type | `(AAPl)`, `(NVdA)`, `[Ol]` resolve to uppercase ticker + asset type | Case-tolerant `TICKER_RE` / `ASSET_TYPE_RE`; normalize on emit |
| Row-count invariant | Fixture where 1 of 3 rows fails → result is `unresolved`, reason `row-count-mismatch` | In `extractPTRResult`, compare matched primary rows to **structural candidate rows inside the transaction table only** — never global date pairs (header/certification dates would false-trip) |
| Loader routing | `db/load-pfd.validation.test.ts`: a zero-row filing appears in `withheld` and existing rows are preserved | Replace the skip at `db/load-pfd.ts:346` so zero-row and missing-identity filings reach `classifyFiling` |

Each commit ends with `npm test` and `npx tsc --noEmit` clean (tsc baseline is 0 — any error is a real regression).

### A3. Source verification — **Gate A3**

**The current 193 rows were produced by the buggy parser and are not ground truth.**

Copy **only `.txt` files** for the 19 filings into an isolated scratch cache — never the PDFs, so the OCR branch at `extract.ts:612` cannot fire. Extract with the candidate parser, then verify **against the source PDFs**:

- Per filing: extracted row count vs. the visible source transaction table.
- First and last row of every filing, read against the source.
- **Every** changed `description`, `location`, `ticker`, and `asset_type` value.
- Every unusual layout encountered.

Differential extraction (pre-repair parser at `dfc6e43` vs. candidate) runs **only as a cross-check**: it must reproduce exactly the frozen 19. A mismatch is a **stop**, never a scope expansion.

**Gate A3:** maintainer approves the verification findings.

### A4. Candidate database + delta gates

Copy current production DB into the worktree. Build a load cache containing **exactly the 19 filings and nothing else** — `--load-pfd --bioguide` loads every JSON present for that member, and the six affected members have other already-loaded filings with the same pollution.

Load scoped: `npx tsx agents/pipeline.ts --load-pfd <year> --bioguide <id>` per year per member. Record every loader summary line including `withheld`.

New tracked helper `scripts/db-delta.ts` (reused by Track B) — per-table row count + content hash for two DuckDB files, plus per-filing `pfd_transactions` diff.

**Semantic gate.** Same 19 filing IDs; same per-filing row **multiset** compared by content, not `tx_index`; differences confined to `asset`, `ticker`, `asset_type`, `description`, `location`, `fetched_at`. Any change to `tx_date`, `tx_type`, `amount_band`, `holder`, `match_confidence`, or `match_method` is a **stop**.

**Parity gate.** Every other table byte-identical; `pfd_transactions` differs only in rows whose `filing_id` is in the frozen 19. `npm run verify:baseline` passes on both files.

**Report three quantities separately — never merged:**
1. Historical **gross +193** launch rows (what the 2026-09-01 load added).
2. Current-to-candidate **zero net** row change.
3. Per-row **replacements** within the 19 filings (cleaned columns only).

**Known limitation to record:** label pollution persists in *other* already-loaded filings of the same era. Out of scope this round, stated explicitly.

### A5. Receipts + OpenSecrets — **Gates R1, O1** — before deploy

Both are launch blockers, not post-deploy cleanup. Separate branches, separate bounded plans, separate approvals, merged before Gate A7.

- **Receipts honesty (R1):** items 1–3 of `docs/superpowers/specs/2026-07-28-receipts-distribution-design.md` — rarity band replacing the raw p-value, capped cards with an explicit count line, verdict line. Verification: `grep -c 'p = 0\.' site/members/*.html` → 0.
- **OpenSecrets compliance (O1):** Phase 0 of the 2026-08-04 plan — theme-level chips replacing verbatim industry labels, provenance line in Money & votes, detector rerun for the ten via `run-patterns.ts --member <slug>` (ten times; `--bioguide` is **not** a valid flag on that CLI). Verification: label grep returns zero.

### A6. Rendering

Copy into the worktree: `.env`, `data/caches/legislators-cache/`, and **`data/caches/pfd-cache/fec-ie/`** — outside-spending renders fetch live from OpenFEC without it, and a fetch failure now renders disclosure copy, which would break determinism.

Ensure pipeline task artifacts are present, then run `npm run validate:corpus` **in the candidate worktree** (it reads `PIPE_DIR` from the repo root — running from main validates the wrong tree).

Full build (`buildOne` writes only the member page; `scripts/package-launch.sh:39` requires `site/methodology.html`, which only `buildAll` produces). Then double-render each of the ten and compare stamp-stripped hashes:

```
grep -v "generated 2026" site/members/<slug>.html | sha256sum
```

### A7. Artifact assembly + boundary — **Gate A4**

Assemble in the **clean isolated worktree** — never from the current mid-assembly state. If assembling elsewhere is ever necessary, first explicitly verify all seven currently-dirty tracked artifacts.

`scripts/update-manifest.ts` rewrites all ten manifest entries from the candidate DB. A manifest change must **match a recorded post-2026-07-28 load** (Whitehouse's Senate reload, Frankel's IE load are known); an unexplained change is a stop.

Preserve unrelated public pages: restore each out-of-boundary page with `git restore` naming **each path individually**.

**Gate A4:** approve the exact committed page set and its diff. Decide D3 here, with the consequence stated plainly — the five `2026-07-28` pages carry the IE cycle bug (Goldman hides ~$150K of opposing spend per the 2026-07-29 handoff), so keeping them live is an explicit known-wrong decision.

### A8. Production replacement + publish — **Gates A5, A6, A7**

1. Fresh backup: `cp data/civiclens.duckdb ~/backups/civiclens-<date>-pre-ptr-clean.duckdb`, sha256 recorded. **Confirm no `.wal` first.**
2. **Gate A5** authorizes the production write. Method: scoped load against production from the 19-file cache, then delta gate on backup vs. after. Whole-file replacement only if parity is proven *and* Gate A5 names it.
3. Tag rollback point: `pages-prev-<date>` on current origin/main.
4. **Gate A6** authorizes push: `git push origin launch/ptr-closeout:main`, fast-forward only.
5. **Gate A7** authorizes deploy: `gh workflow run deploy-pages --ref main`, then verify live bytes equal committed bytes per page via sha256.

**Rollback:** restore the hashed backup by file copy with hash check; redeploy the `pages-prev-<date>` tag; git rollback is always a revert commit, **never** a force-push.

### A9. Local reconciliation — **Gate A8**

Seven individually named `git restore` paths for the superseded tracked files, **then** `git merge --ff-only origin/main`. Untracked user files are never touched.

---

## Track B — certify run-any-member

### B0. Minimal prerequisites — **Gate B1**

- **Slug interface fix.** In `lib/ingest-scope.ts`, add a *separate* injectable to `ResolveDeps` (`:100`) — `slugLookup?: (slug: string) => Promise<{bioguide, memberId, chamber} | undefined>`, default `SELECT bioguide_id, member_id, chamber FROM members WHERE member_id = ?`. It cannot reuse `memberLookup`, which takes a bioguide. In `resolveScope`, when `raw.by === 'member'`, try `slugLookup` first; on miss fall through to the existing name path unchanged. Tests: slug resolves, name still resolves, unknown still `unresolved`. Detector CLIs unchanged. Correct the `slug|name` wording in `AGENTS.md` and the onboarding skill.
- **Onboarding skill:** drop district loaders (zero references to district/recipient tables anywhere in `render/` — they feed only the two consumed-fail detectors); mark OpenSecrets optional with *"not collected"* copy; state the contract — `--bioguide` for loaders, `--member <slug>` for detectors and render — until the slug fix merges.
- **Explicitly out of prerequisite scope:** the run-report schema and render integration. Certification runs on the **tracked trial record** alone; run-report is a follow-on gated by evidence the trial itself produces.

### B1. Freeze selection inputs — **Gate B2**

sha256 + retrieval time for: `legislators-current.yaml` (with upstream commit), each House `index/<year>FD.xml` for **2023, 2024, 2025, and 2026 through the frozen cutoff** (omitting 2026 would misclassify current filers as non-traders), and saved Senate EFDS search responses per senator queried. Fixed cutoff date in the manifest.

### B2. Deterministic selection — six distinct, non-overlapping people

Pool: current members from the frozen YAML, excluding every bioguide resolved from `names.txt` (both candidates for an ambiguous line) **and** every bioguide already in the `members` table. Sort by bioguide ascending. Assign strata in the order below, **removing each chosen member from the pool** so all six are distinct by construction. Backfill only on *pre-run* predicate disqualification: next bioguide in sorted order satisfying the predicate, reason logged.

| # | Stratum | Predicate (frozen indexes only) | Expected outcome |
|---|---|---|---|
| 1 | Senator with PTRs | `type sen`; EFDS 2023–2026 returns ≥1 PTR | Loaded trades; band `ranked` or `low-power` |
| 2 | House non-trader | `type rep`; zero type-P filings across frozen indexes | Zero trades; honest empty receipts state |
| 3 | House text-layer trader | `type rep`; ≥10 type-P in 2025; pdftotext yields text on every PTR | Clean parsed rows, no label pollution |
| 4 | Senator without PTRs | `type sen`; EFDS returns zero PTRs | Authoritative verified-empty |
| 5 | No FEC candidate id | `id.fec` empty (`lib/legislators.ts:56`) | Outside-spending "unavailable" shell |
| 6 | House scanned filer | `type rep`; ≥1 type-P; no text layer on every PTR | Withheld filings + unreadable disclosure |

Strata 3 and 6 classify by text-layer presence — a property of the *source file*, so legitimate selection input. Classification downloads happen in the trial worktree after the index freeze, before the manifest freeze. If no member satisfies stratum 5, close it by disclosure with the count as evidence.

### B3. Per-stratum execution — one fresh scratch DB per stratum

Each stratum gets its **own worktree and its own fresh clone** of the certified Track A database, plus its own caches. No accumulation across strata, so every result is independently attributable.

```
npm run verify:baseline                                   # pre-state
npx tsx agents/pipeline.ts --append "<Full Name>"          # record slug + bioguide
npx tsx agents/pipeline.ts --load-sponsored <slug>
npx tsx db/load-cosponsored.ts <slug>
npx tsx agents/pipeline.ts --load-bills --bioguide <id> --api-pass
# House only
npx tsx skills/pfd-fetcher/fetch.ts --years 2023,2024,2025,2026 --name "<Last>"
npx tsx skills/pfd-fetcher/extract.ts data/caches/pfd-cache/<year>     # per year
npx tsx agents/pipeline.ts --load-pfd <year> --bioguide <id>           # per year
# Senate only
npx tsx skills/senate-ptr/fetch.ts --name "<Full Name>" --from-year 2023 --to-year 2026
npx tsx agents/pipeline.ts --load-senate-ptr --bioguide <id>
# both
npx tsx agents/pipeline.ts --load-fec-ie 2024,2026 --bioguide <id>
npx tsx pipeline/run-patterns.ts --member <slug>
npx tsx pipeline/score-theme-gaps.ts --member <slug>
npm run verify:baseline && npm test
npx tsx render/build.ts --member <slug>                    # twice, stamp-stripped compare
npx tsx render/build.ts --member <reference-slug>          # cross-member triage
```

The fetcher filters the House index by `--name` and downloads only matches; `extract.ts` scans a whole year directory and writes sibling JSON — harmless because the worktree cache starts empty. Surname collisions may pull a second filer; loader member-scope keeps them out of the DB and the extra JSON is inert.

OpenSecrets is **not run** and is recorded `not-collected`. Every step records exactly one of: `ok`, `verified-empty`, `not-collected`, `withheld`, `failed`. **A step with no recorded outcome fails the stratum.**

Reference-page drift is a **triage trigger**, not an automatic stop — shared-donor and cosponsor relationships can legitimately change another member's page. Triage against the declared expected outcome.

### B4. Stop gates and closure — **Gates B3, B4**

Stop and attribute before continuing: baseline or tests regress; double-render differs (determinism regression — fix generally, never per-member); unexplained cross-member mutation.

**Disclosure closes a stratum only** for an inherent, source-backed limitation confirmed by a recorded query and response: authoritative verified-empty, no text layer in the source PDF, or identity absent from both the YAML and OpenFEC. It must render on the member or methodology page and cite its evidence. Console output, handoffs, and vault notes do **not** close a stratum.

**Must fail and be fixed or rerun** under the frozen manifest: transient network errors, implementation defects, silent skips, parser/template mismatch, cross-member mutation. Same candidate, attempt number recorded.

**Gate B3:** accept or reject each disclosure closure. **Gate B4:** accept certification, or name the strata that must rerun.

---

## Change ledger

**Gross additions.** Four extractor/loader tests; `scripts/db-delta.ts`; slug lookup + tests; `docs/trials/<date>/` tracked record; tag `pages-prev-<date>`; decision note recording D1–D3 and an ADR 0002 amendment defining "run".

**Replacements / removals.** Extractor label, ticker, and asset-type patterns; the extractor's acceptance rule; the loader skip at `db/load-pfd.ts:346`; empty-state copy in `render/member-sections.ts` and `render/empty-shells.ts`; district-loader steps in the onboarding skill; the approved public page set + index + manifest; production `pfd_transactions` rows within the 19 filings.

**Net change.** Parser correct for the 200xxxxx era; loader never silently loads or skips; one scope contract; pages can say *not collected* / *verified empty* / *withheld*; corrected pages live; **zero net rows** in the DB (cleaned columns only); no schema migration; no new dependencies.

---

## Human approval gates

| Gate | Track | Decision |
|---|---|---|
| A1 | A | Approve the 19 frozen filing IDs + file inventory |
| A2 | A | Approve the eight non-PTR commits, separately |
| A3 | A | Approve source-verification findings |
| A4 | A | Approve the committed page set + diff (decides D3) |
| A5 | A | Authorize the production database write |
| A6 | A | Authorize push to origin |
| A7 | A | Authorize the Pages deploy |
| A8 | A | Authorize the seven named restores in local main |
| R1 | A | Approve the receipts honesty plan |
| O1 | A | Approve the OpenSecrets compliance plan |
| B1 | B | Merge Track B prerequisites |
| B2 | B | Freeze index snapshots + selection manifest |
| B3 | B | Accept each disclosure closure |
| B4 | B | Accept certification |
| Standing | both | ADR 0003 — no confirmatory computation on the parked timing pair |

Nothing runs, writes, or publishes without the gate above it.

---

## Verification summary

- Per repair commit: `npm test`, `npx tsc --noEmit` (both baselines clean).
- Source verification against PDFs before any DB use.
- Semantic + parity delta gates before any production write.
- `npm run validate:corpus` in the candidate worktree.
- Double-render byte-identity, stamp-stripped, for every rendered member.
- Live-bytes-equal-committed-bytes check after deploy.
- Track B: per-stratum baseline before/after, tests, double-render, cross-member triage, evidence pack in the tracked record.

---

## Immediate next action

**Gate A1.** Assemble and present the authoritative 19 launch PTR filing IDs with their cached-file sha256 values, plus the current database sha256, for approval as frozen scope. This is read-only work.

Nothing is branched, extracted, loaded, rendered, pushed, or deployed until that approval lands.
