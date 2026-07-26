# Member-scope & timing-safe onboarding repair — Phase 0 plan

Status: **plan, awaiting approval** · Branch base: `sandbox/member-scope` @ `98cd865`
Scope of work: this worktree only (`~/Developer/civiclens-member-scope-sandbox`).
Production checkout `~/Developer/civiclens` is OUT OF SCOPE — no reads/writes to
its DuckDB, caches, untracked files, or artifacts. Tests use committed fixtures
+ temporary DuckDBs only.

Governing prompt: `CivicLens-Claude-Code-Safe-Onboarding-Guide.md` (Phases 0–1).
This doc covers **Phase 1 only** (implement + verify + one local commit).
**Phase 2 (live one-member onboarding) is explicitly excluded** here — it requires
the production DuckDB and live harvests, which this worktree may not touch.

## Decisions locked (user, 2026-07-23)

1. **DB test seam:** add an optional `conn?: DuckDBConnection` (and, where a
   loader also resolves paths, an optional cache-root override) to each affected
   loader. Production callers pass nothing → `deps.conn ?? await getDb()`,
   behavior identical. Tests inject a fresh temp-DuckDB connection. Mirrors the
   existing `writeAndScore(pattern, member, hits, { conn?, scorer? })` seam.
2. **Timing recompute:** `run-patterns.ts --member` **drops the parked timing
   pair entirely** — it never detects/writes/scores `trade-vote-alignment` or
   `spousal-trade-timing`. No `--include-timing` opt-in in run-patterns. Timing
   scoring lives solely in `score-anomaly.ts` and the `*-baseline.ts` runners.

## Behavioral contract (fixed)

### A. Shared ingestion scope (discriminated union)

New `lib/ingest-scope.ts`:

```ts
export type IngestScope =
  | { kind: 'member'; slug: string; bioguideId: string; memberId: string;
      chamber: 'house' | 'senate' }
  | { kind: 'all' };
```

- Canonical resolution by `bioguide_id`. A supplied slug/name must resolve to
  exactly one canonical member (reuse `lib/resolve-member.ts`) BEFORE any network
  call or DB mutation. Unknown/ambiguous → fail before work.
- Shared CLI arg parser `parseScopeArgs(argv)` requiring exactly one of
  `--member <slug|selector>`, `--bioguide <id>`, `--all`. **No selector → fail
  closed with usage text.** Supplying both member and all → fail. `undefined`
  must NEVER coerce to `all`.
- Member mode prints resolved `slug + bioguide + chamber + requested cycle/year`
  before work.
- `agents/pipeline.ts` wrappers stay behaviorally identical to direct-loader
  entry points (same parser, same scope object).

**Prerequisite fix (also unblocks the failing baseline test):** make
`resolveMember()` dependency-injectable for the identity index/aliasMap (today it
only injects `slugLookup`, so it can't be tested against a fixture — the cause of
the one red test at baseline). Add optional
`{ index?, aliasMap?, slugLookup? }`; production uses the singletons, tests pass
the fixture index.

### B. Five broad loaders → genuinely member-scoped

Each keeps `--all` semantics behind an explicit `{ kind: 'all' }`; member mode
filters BEFORE any DELETE/INSERT/fetch; DELETE-then-insert becomes transactional
per target write unit (fetch/parse first, then `BEGIN … COMMIT/ROLLBACK`).

1. **House PFD (`db/load-pfd.ts`)** — member mode may scan cache metadata but only
   filings whose resolved filer == target reach DELETE/INSERT. Unrelated
   unmatched filers do not fail a member run. Zero matching target filings is an
   explicit interpretable result (not silent success). All-mode requires `--all`.
2. **Senate PTR (`db/load-senate-ptr.ts`)** — add the scope contract (currently
   accepts none). Member mode: only the resolved senator's filings reach
   DELETE/INSERT; don't process all years/members just because the cache is
   arranged by year. Cantwell stays Senate-only.
3. **FEC IE (`db/load-fec-ie.ts`)** — filter `membersWithFec()` BEFORE any network
   fetch; member mode fetches only the selected member/cycle; DELETE/INSERT
   restricted to that member/cycle. Missing `fec_candidate_id` for the selected
   member → **fail loud with remediation**, not a zero-result roster run.
4. **OpenSecrets (`db/load-opensecrets.ts`)** — member mode opens ONLY the
   selected member's cached HTML for the cycle; validate cache filename identity
   == resolved canonical target; DELETE/INSERT only that member/cycle/source.
   Remains a pure parser (no network).
5. **Bills (`db/load-bill-summaries.ts`)** — member mode: regex backfill queries
   only the selected member's NULL votes; GovTrack resolves only that member's
   unresolved vote URLs; summary/title work limited to distinct bills referenced
   by the target's votes. Shared `bill_summaries` rows may upsert (keyed by bill)
   but the worklist originates only from the target. **No global NULL-title
   refill in member mode** (`refillTitles` becomes target-scoped or skipped).

### C. Timing-safe onboarding

- `pipeline/run-patterns.ts --member <slug>` filters the parked pair out before
  `detect()`, `writeHits()`, DELETE, `writeAndScore()`, `scorePattern()`.
  Implementation: a `SAFE_DETECTORS` view of the registry excluding
  `SCORED_PATTERNS`, or an explicit skip in `runForMember`. Existing timing
  `pattern_hits` rows remain **byte/row-equivalent** after an onboarding-safe run.
- `score-theme-gaps.ts` untouched (separate ADR-0002 path; already member-scoped,
  fail-loud, writes a JSON artifact — not `pattern_hits`).

### D. Docs & skills (only after CLI is real)

`agents/pipeline.ts` help/dispatch · direct-loader `parseArgs`/help ·
`db/LOADER-INPUT-MAP.md` · `AGENTS.md` (member-scoped execution rule) · the most
appropriate ADR (or a narrow new ADR for ingestion boundaries) · `STATUS.md` ·
skills `civiclens-onboard-member`, `civiclens-opensecrets-harvest`,
`civiclens-core` cross-refs. Skill edits follow skill-authoring rules with a
behavioral pressure test, not prose-only.

### E. Tests (fixtures + temp DuckDB; never the live DB)

1. Each affected parser accepts one canonical target.
2. No selector fails closed (usage text, non-zero), never means all.
3. `--all` is explicit.
4. Unknown/ambiguous member fails before network or mutation.
5. **Two-member fixture:** load member A leaves every member-B row exactly
   unchanged in every affected table (row-hash snapshots, not counts).
6. Network mocks: FEC and bill APIs called only for member A.
7. Cache readers open/process only the intended target where format permits;
   unrelated files never reach writes.
8. PFD member mode ignores unrelated unmatched filers.
9. Senate member mode cannot write another senator's filings.
10. OpenSecrets member mode cannot rewrite another cached member-cycle.
11. Bills member mode cannot update another member's votes / no global refill.
12. Failed target parse/fetch leaves preexisting target rows intact (txn).
13. Default `run-patterns --member` never calls the timing scorer; timing rows
    untouched (byte/row-equivalent).
14. (opt-in mode removed — n/a; assert run-patterns has no timing path instead.)
15. `score-theme-gaps` member behavior unchanged.
16. CLI help + skill examples use commands that actually parse.
17. `resolveMember` fixture-injected test passes (fixes baseline red).

## File-by-file plan

| File | Change |
|---|---|
| `lib/ingest-scope.ts` (new) | `IngestScope` union + `parseScopeArgs` + `resolveScope` (uses resolveMember) |
| `lib/resolve-member.ts` | add injectable `{ index?, aliasMap? }` (fixes baseline test) |
| `db/load-pfd.ts` | accept `scope` + `conn?`; filter to target filings; txn per filing |
| `db/load-senate-ptr.ts` | add `scope` + `conn?`; target-only writes; txn |
| `db/load-fec-ie.ts` | `scope` + `conn?`; filter before fetch; fail-loud missing FEC id |
| `db/load-opensecrets.ts` | `scope` + `conn?`; single-file open; filename↔canonical check |
| `db/load-bill-summaries.ts` | `scope` + `conn?`; target-scoped worklist; no global refill in member mode |
| `pipeline/run-patterns.ts` | exclude parked timing pair from member path |
| `agents/pipeline.ts` | dispatch new `--member/--bioguide/--all` to each loader; help text |
| docs/skills (D) | update after CLI verified |
| tests (E) | new `*.test.ts` + fixtures + temp-DB harness |

## Risks / rollback / exclusions

- **Risk:** signature churn across many loaders. **Mitigation:** optional-param
  seam keeps prod call sites unchanged; land loader-by-loader, run tests each.
- **Risk:** accidentally changing all-mode semantics. **Mitigation:** row-hash
  snapshot tests assert all-mode output identical to pre-change.
- **Risk:** `render/build.ts` or vault regen relies on prior broad behavior.
  **Mitigation:** audited — not affected; verify in gate.
- **Rollback:** all work on `sandbox/member-scope`; single local commit only.
  Revert = `git reset`/branch delete. No push/PR/merge.
- **Excluded:** Phase 2 live onboarding; publish; district-loader rewrites
  (already scoped); `score-theme-gaps` redesign; recipient worklist.

## Baseline (recorded, read-only)

- git: `98cd865`, clean, 0 ahead/behind origin/main.
- `npm test`: 149 pass / 1 fail — `resolve-member.test.ts:39` (test-seam, see A).
- `tsc --noEmit`: 3 pre-existing `TS5097` errors in `lib/*.test.ts`.
- `validate:corpus`: PASS (empty corpus 0/0).
- guard: recipient-trade BLOCKED (consumed-fail); timing pair registered/clear.
- No DuckDB, no legislators cache in this worktree.

## Verification commands (Phase 1 gate)

```
tsx --test <new + affected>.test.ts     # targeted
npm test                                # full — must be 150/150 (fixes the red)
npm run verify:baseline
npm run validate:corpus
npx tsc --noEmit                        # must be == baseline (3 TS5097), no new
git diff --check
git status --short
```

Plus per-file review + adversarial pass (undefined→all, net-before-resolve,
DELETE missing member/cycle, member bills→global refill, timing reached before
filter, skill/CLI drift). Live DB unchanged (none exists here — record that).
Commit locally only after all pass. No push/PR.
