# Handoff — restore Lois Frankel's FEC independent-expenditure rows

*Written 2026-07-28. Scope: exactly one member, one loader, two cycles.*

## The gap

`lois-frankel` has **zero rows** in `super_pac_ie` and `super_pac_ie_filings`,
but independent expenditures for and against her demonstrably exist. The cached
FEC payload at
`data/caches/pfd-cache/fec-ie/H2FL14053/2024-funders3.json` holds:

| S/O | committee | amount |
|---|---|---|
| S | UNITED VETERANS ALLIANCE OF AMERICA PAC | $40,869.65 |
| S | SIERRA CLUB INDEPENDENT ACTION | $10.00 |
| O | PROTECT AMERICA PAC | $106,500.00 |

`totalSupporting = 40879.65`, `totalOpposing = 106500`, fetched 2026-06-01.
A `2026-funders3.json` also exists (~$10).

She is **one of the 10 published members**, so this is a hole in a page that is
already built.

## Why it happened (root cause is known — don't re-derive it)

`lib/fec-ie.ts:133` builds the cache filename as:

```ts
const cacheFile = cachePath(candidateId,
  `${cycle}${itemized ? '-itemized' : ''}${topFunders ? `-funders${topFunders}` : ''}.json`);
```

`db/load-fec-ie.ts:114` always calls the fetcher with `{ itemized: true }`.

Frankel's cache directory contains **only** `2024-funders3.json` and
`2026-funders3.json` — there is no `-itemized` variant. Every other candidate
directory has one. So her load takes a **cache miss → live OpenFEC fetch**, and
that fetch evidently never succeeded. The funders payload also carries
`filings: 0`, which is expected: Schedule E itemization only arrives on the
itemized call. A live call is genuinely required — you cannot satisfy this from
the existing cache.

`OPENFEC_API_KEY` is present in the repo `.env` (`lib/fec-ie.ts:57` throws
without it).

## ⚠ Before running: this loader can destroy data

`db/load-fec-ie.ts` deletes unconditionally before inserting, inside the
transaction but **after** the fetch returns:

```ts
await conn.run(`DELETE FROM super_pac_ie         WHERE member_id = ? AND cycle = ?`, [m.memberId, cycle]);
await conn.run(`DELETE FROM super_pac_ie_filings WHERE member_id = ? AND cycle = ?`, [m.memberId, cycle]);
```

There is **no non-empty guard** — no equivalent of the `usableDonors()` fix that
`db/load-from-tasks.ts` received after the identical bug destroyed 100 of
Frankel's donor rows (see `HANDOFF-…-2026-07-28`, "Bug found and fixed").

A thrown error returns early at line 117 *before* the DELETE, so hard failures
are safe. The dangerous case is a **silent empty success**: an OpenFEC transient
or rate-limit-shaped `200` returning an empty report wipes that member/cycle.

Blast radius if someone runs this roster-wide:

| table | 2024 | 2026 |
|---|---|---|
| `super_pac_ie` | 231 aggregates (36 members) | 70 (24 members) |
| `super_pac_ie_filings` | 5,466 | 1,176 |

Most exposed: `ted-cruz` (47), `steven-horsford` (25), `adam-schiff` (20),
`ilhan-omar` (17), `josh-hawley` (16).

**Rules for this task:**
- Use `--member lois-frankel`. Never `--all`.
- `--dry-run` first — it returns at line 127, before any DELETE.
- Frankel currently has **0 rows**, so for her specifically there is nothing to
  lose. The hazard matters if you widen scope; don't.

## Procedure

```bash
cd ~/Developer/civiclens

# 0. Gates + rollback point
npm run verify:baseline          # must pass first
npm test                         # expect 203/203
cp data/civiclens.duckdb ~/backups/civiclens-2026-07-28-pre-frankel-ie.duckdb

# 1. Dry run — proves the live fetch returns non-empty BEFORE any write
npx tsx agents/pipeline.ts --load-fec-ie 2024 --member lois-frankel --dry-run
```

**Decision point.** Read the dry-run output:

- Reports ~3 aggregates and a non-zero supporting/opposing total → proceed.
- Reports **0 aggregates** → **STOP.** That is the silent-empty failure mode.
  Do not re-run without `--dry-run` hoping it works; investigate the fetch
  (`lib/fec-ie.ts` logs a redacted URL at line 65). Writing on an empty return
  is exactly the bug this handoff warns about.

```bash
# 2. Real load, per cycle, one at a time
npx tsx agents/pipeline.ts --load-fec-ie 2024 --member lois-frankel
npx tsx agents/pipeline.ts --load-fec-ie 2026 --member lois-frankel --dry-run
npx tsx agents/pipeline.ts --load-fec-ie 2026 --member lois-frankel

# 3. Verify rows landed
```

Check with a small script (`npx tsx -e` fails on this repo — top-level await is
not supported under the cjs output format; write a file and run it):

```sql
SELECT cycle, count(*) FROM super_pac_ie         WHERE member_id='lois-frankel' GROUP BY 1;
SELECT cycle, count(*) FROM super_pac_ie_filings WHERE member_id='lois-frankel' GROUP BY 1;
SELECT committee_name, support_oppose, total_amount FROM super_pac_ie WHERE member_id='lois-frankel' ORDER BY total_amount DESC;
```

Expect the three committees above for 2024. Cross-check the totals against
`2024-funders3.json` — they should match, since both come from the same FEC
aggregate endpoint.

```bash
# 4. Gates again + render
npm run verify:baseline
npm test
npx tsx render/build.ts --member lois-frankel      # writes site/, NOT public/
```

Render determinism: build twice and compare, stripping the timestamp line
(`render/build.ts:403`) — otherwise the `generated <ts>Z` line guarantees a
mismatch:

```bash
grep -v "generated .*Z" site/members/lois-frankel.html | sha256sum
```

Second-member regression: this write is scoped to `member_id='lois-frankel'`, so
no other member's page should move. Rebuild one unaffected member and confirm
byte-identity.

## What NOT to do

- Do **not** run `score-theme-gaps.ts` expecting a band change. Bands are driven
  by theme-mappable **trades**, not IE. Frankel is already `ranked` (185 themed
  trades after the 2026-07-28 ticker-crosswalk backfill). IE feeds the money
  section, not the band.
- Do **not** touch the parked timing detectors. `trade-vote-alignment` and
  `spousal-trade-timing` stay `registered`/unconsumed (ADR 0003).
- Do **not** publish. The repo is private by user decision (2026-07-28) and
  `public/` is the committed launch artifact — the render above writes `site/`.
  Publishing is `civiclens-publish-gate`, separately authorized.
- Do **not** "fix" the 13 other members with zero `super_pac_ie`. Their caches
  were checked on 2026-07-28 and read `totalSupporting=0, totalOpposing=0` for
  both cycles — they are **true nulls**, exactly as `db/load-fec-ie.ts:16` says
  ("Members with no IE are normal — they are not errors"). Frankel is the only
  real gap of the 14.

## Optional follow-up (separate, not required here)

The missing non-empty guard in `db/load-fec-ie.ts` is a latent version of a bug
already fixed once elsewhere. Porting the `usableDonors()` pattern — clear rows
only when the fetch returned something — would close it, with a regression test
proving it fails against the unconditional-delete version (the way
`db/load-from-tasks.test.ts` was verified). That is a code change and deserves
its own decision; it is **not** part of this handoff.

## State at handoff time

- Branch `main`, working tree clean apart from untracked docs.
- 203/203 tests, `verify:baseline` exit 0, vote→bill linkage 80.3%.
- Backups: `~/backups/civiclens-2026-07-28-pre-ticker-backfill.duckdb`
  (sha256 `e5353300c5e81ff881b4e7582b9675a8dbd689bf3026b200420b0af5fbb181b4`).
- Nothing pushed, deployed, or published.

---

## OUTCOME — executed 2026-07-28 20:5x (same day)

**Done. Frankel's IE rows are loaded and verified.**

### Correction to the procedure above

`--member lois-frankel` **does not work.** `lib/ingest-scope.ts:142` resolves via
`resolveIdentity()` against the *legislator name index*, which contains
`"lois frankel"` / `"frankel lois"` — not the hyphenated slug. Verified:

| selector | result |
|---|---|
| `lois-frankel` | `{ok:false, reason:'unresolved'}` → Fatal |
| `"Lois Frankel"` | `F000462` ✓ |
| `F000462` | `F000462` ✓ |

Use **`--bioguide F000462`** (canonical, unambiguous). This affects every
`--member <slug>` command in the other handoffs too.

Also: `agents/pipeline.ts --load-fec-ie` prints only a terse count. Run
`db/load-fec-ie.ts` directly to get the agg/filings/$ table needed for the
decision point.

### Dry-run decision point → PROCEED

    2024: 3 agg, 342 filings, $40,879.65 S / $106,500 O
    2026: 1 agg,   1 filing,  $10 S / $0 O

Non-empty on both cycles, so the unguarded DELETE was safe. Totals match
`2024-funders3.json` to the cent. The 342 filings confirm the root-cause
analysis: Schedule E itemization only arrives on the `itemized: true` call.

### Verified result

| table | 2024 | 2026 |
|---|---|---|
| `super_pac_ie` | 3 | 1 |
| `super_pac_ie_filings` | 342 | 1 |

Committees exactly as predicted: PROTECT AMERICA PAC $106,500 (O), UNITED
VETERANS ALLIANCE OF AMERICA PAC $40,869.65 (S), SIERRA CLUB INDEPENDENT
ACTION $10 (S).

Globals: `super_pac_ie` 301 → **305**, `super_pac_ie_filings` 6,642 → **6,985**.
Pure additions; no other member lost rows. All other core tables unchanged.

Gates: `verify:baseline` exit 0 (linkage 80.3%), 203/203 tests, before and after.
Render determinism: two builds byte-identical. Second-member regression:
`dan-crenshaw` byte-identical pre/post (`27fbe4030b262ff4`).

### Known non-issue: filing sums ≈ 2× aggregates

Frankel's 4 opposing filings sum to $213,000 vs the $106,500 aggregate (exactly
2×). This is **pre-existing and roster-wide** — `ted-cruz` (+$9.1M),
`matt-gaetz` (+$2.2M), `elizabeth-warren` (exactly 2.000×) all show it. Amended
and original Schedule E filings both itemize while the aggregate endpoint
de-dupes. The aggregate is what the page displays, and it matches FEC exactly.
Not a regression; not introduced here.

## ⚠ FOLLOW-UP FOUND (not fixed — needs a decision)

**Frankel's page renders the 2026 cycle ($10) instead of 2024 ($147K).**

`render/build.ts:1423 latestIeCycle()` selects `MAX(cycle)`, then
`renderOutsideSpending()` fetches that cycle. Frankel now has a 2026 row, so her
"Outside spending" section reads *"Supporting: $10 / Opposing: $0, 2026 cycle"* —
hiding the $106,500 PROTECT AMERICA PAC opposition.

**This is pre-existing behavior, not caused by this load.** Already affects:

| member | 2024 | 2026 (displayed) |
|---|---|---|
| `jim-jordan` | $20,873 | $881 |
| `mike-johnson` | $13,468 | $2 |
| `hakeem-jeffries` | $5,680 | $10 |
| `pramila-jayapal` | $3,055 | $10 |
| `maxine-waters` | $374 | $10 |
| `frank-pallone` | $264 | $10 |

Deliberately **not** fixed here: it is shared render logic touching 7+ members
and 10 published pages — outside this handoff's one-member scope. Options are
"pick the cycle with the most spend", "show both cycles", or "prefer the last
completed cycle". Needs its own decision.

### State

Branch `docs/backfill-diagnostics-2026-07-28`. DB + `site/` are gitignored, so
no code changes and nothing to commit. Backup:
`~/backups/civiclens-2026-07-28-pre-frankel-ie.duckdb`
(sha256 `40b231725e8afaca82ba3fc20fde72bfabc6b902897b3a404ecc4cfa32dbb033`).
Nothing pushed, deployed, or published. Timing detectors untouched.
