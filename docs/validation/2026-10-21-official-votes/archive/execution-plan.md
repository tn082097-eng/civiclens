# Execution plan — full-window official vote-source validation (2026-10-21)

Lead: Claude Code (claude-opus-5-5), serial source-acquisition + integration owner.
Final acceptance: controlling Codex session. Authority: `scope.md` (this dir), `AGENTS.md`.
Written 2026-10-21T23:23Z, before any agent dispatch or network call.

## 1. Frozen scope

| Item | Frozen value |
|---|---|
| Candidate | `e3eb78956c36f1a4a275a8907d2f01f10f2ce6ba`, branch `codex/full-window-validation`, worktree `/home/captainanime/Developer/civiclens-full-window-validation` |
| asOf | `2026-10-21` |
| Window | `2022-10-21` .. `2026-10-21` inclusive, exactly 48 calendar months (`adapter.subtract_months` / `coverageWindow`) |
| Order | House acquisition → House offline replay + isolated persistence → **only then** Senate acquisition → Senate replay + persistence |
| Source consumers | `tools/congress-collector/acquire_window.py` (→ `house_discovery.py` / `adapter.py`; `senate_adapter.py`). No GovTrack, no synthetic inventory, no `--fixture-map`, no `--max-rolls`, no `--rolls-json` |
| Endpoints | `clerk.house.gov` (MemberVotes listing + `/evs/<yr>/rollNNN.xml`), `www.senate.gov` (LIS vote_menu + vote XML). Nothing else |
| Parser | pinned `unitedstates/congress@8184bcb` via `lib/collector-bridge.ts` `runCollectorBridge` (`unshare -rn`, isolated cwd/HOME/TMPDIR); runtime `tools/congress-collector/.runtime` (lock sha `e5de05c0…`, vendor sha `c9b17dc4…`) |
| Identity | `fixtures/votes/identity/legislators-d5af3d2-voting-terms.json` sha `582e5b3e…`, commit `d5af3d2`, floor `2019-01-03` |
| Targets | House `H001047`, `A000370`; Senate `S000033`, `W000817` (snapshot terms span the window — verified by lead, independently re-audited by identity worker). Reference target = first of each pair |
| Completeness semantics | Current-day completeness = listing snapshot at recorded capture time; not a promise that no later roll appears |

## 2. Out of scope (hard)
No git commit/push/merge, publication, render, OCR, detector/confirmatory run, member pipeline, six-stratum replay, JS/Python dependency install, dependency-file edits, env/secret files, production `getDb()` call, writes outside this checkout or `/tmp`, other worktrees, `data/`/cache/`public/`, NoService, personal memory.

## 3. Owners and write sets (disjoint)

| Owner | Model / dispatch | Writes ONLY | Network | DB |
|---|---|---|---|---|
| Lead (me) | claude-opus-5-5 | `execution-plan.md`, `agents.json`, `progress.json`, `checks/**`, `house-<run>/**`, `senate-<run>/**`, `final-report.md` | Yes, only acquire_window.py to the two official hosts, after §5 preflight | Only temp DuckDB under `checks/`/run dirs, via the worker harness invoked serially by me |
| W1 source/preflight auditor | Haiku, Agent tool, background | `workers/source-audit.md` | No | No |
| W2 replay-harness worker | Haiku, Agent tool, background | `workers/replay/**`, `workers/replay-report.md` | No | No (may typecheck only; lead runs it) |
| W3 identity/snapshot auditor | Haiku, Agent tool, background | `workers/identity-audit.md` | No | No |

No agent edits another writer's files. The lead does not edit `workers/**`; if the harness needs a fix, the lead sends the finding back to W2 (SendMessage) or records the defect and returns it to Codex.

## 4. Steps and terminal conditions

1. Plan (this file) → `agents.json`, `progress.json` checkpoint `plan_written`.
2. Dispatch W1, W2, W3 (record true model/agent IDs/results in `agents.json`; quota failure recorded as such).
3. Lead preflight (`checks/preflight-*.txt`): runtime.json vs lock/vendor hashes (`resolveCollectorRuntime`), `unshare -rn` lo-only, identity snapshot hash, offline unit suites for collector (python unittest) and official-vote TS tests, protected-file hashes vs `protected-before.json`, confirm no `data/civiclens.duckdb` in this worktree.
4. Review W1 source audit. Blocking findings stop acquisition.
5. **House acquisition** (serial, one run): `python3 -I -B tools/congress-collector/acquire_window.py --chamber house --as-of 2026-10-21 --months 48 --output artifacts/full-window-validation-2026-10-21/house-<UTCstamp>-<rand>` with isolated cwd/HOME/TMPDIR under `/tmp`; stdout/stderr/exit/start/end saved to `checks/house-acquire-<run>.json`.
6. Inspect W2 harness (lead code read) + offline controls (§6). Then invoke harness serially on the House run: loadWindowRun → runCollectorBridge (once, shared) → independent failure census (bridge failures, voter-mapping failures, canonical roll keys) → per target `normalizeMemberVotes` coverage result → serial `planVoteBatch`/`applyVoteBatch` into a **new** temp DuckDB under the run dir → reference target snapshot hash unchanged after second load. Counts + SHA256s persisted.
7. Only if step 6 passes: **Senate** acquisition (fresh dir `senate-<UTCstamp>-<rand>`), then same harness for Senate.
8. Protected-hash recheck, `final-report.md`, one bounded self-assessment, handoff to Codex.

**Terminal SUCCESS**: both chambers `window-run.json status=complete`, loadWindowRun accepts, bridge census has zero failures (or failures are fully enumerated and normalization still accepted by the strict path — not expected), all four targets normalize with `coverage.outcome=ok`, temp-DB loads succeed and reference targets unchanged, protected hashes unchanged.
**Terminal FAILURE**: any stop in §7 with preserved evidence, written diagnosis and exact next action for Codex.

## 5. Preflight gates before any network
- Plan written; ≥2 workers actually dispatched (provenance in `agents.json`).
- Runtime install finished (`runtime.json` present, hashes match lock/vendor).
- `unshare -rn` available, namespace has only `lo`.
- Offline suites green or failures recorded and judged non-blocking with reason.
- Protected hashes match `protected-before.json`.
- W1 report has no blocking finding (or lead records why it's non-blocking).

## 6. Harness controls (lead-run, offline, before real invocation)
- Static: harness imports no `getDb`/`DB_PATH`-opening call, no `fetchOfficialMemberVotes` live mode, no `fetch`/http modules, no `--max-rolls`/fixture path; DB path is a newly created file under the run dir.
- Negative controls: (a) run dir with `window-run.json status != complete` → harness exits non-zero; (b) a copy with one response body byte-altered → non-zero (`response_body_mismatch`); (c) DB target path that already exists → refuse; (d) `data/civiclens.duckdb` path → refuse. Controls operate on `/tmp` copies only.
- Runtime check: harness run under `unshare -rn` as well (whole node process offline), so no network is possible from the harness.

## 7. Failure stops (stop dependent work, record, diagnose once)
- Discovery failure / `window-run.json status ∈ {failed, incomplete}` → stop. Record per-outcome counts and failing keys; diagnose (transient HTTP vs source change vs code). At most one new attempt in a NEW dir, and only if diagnosis shows transient failure and nothing in contracts changes; otherwise return blocker to Codex. Never reuse, patch or delete the failed dir.
- Runtime/netns failure → stop, return to Codex.
- loadWindowRun rejection → stop; record code/message.
- Bridge failure(s) or voter-mapping failure(s) → census recorded; no contract change; the strict normalizer outcome for each target is recorded as-is (failure is a result).
- Identity unsuitability of a target → only replace via written identity check (W3 + lead).
- Temp-DB write failure or reference-target drift → stop.
- Any protected hash change → stop everything, report immediately.
- House not proved → Senate is NOT acquired.

## 8. Progress reporting
`progress.json` is rewritten at every checkpoint: `{phase, status, updated_at, checkpoints[], running_processes[], blockers[]}`.
