# Handoff — IE render fix shipped, OCR rotation found, Senate harvest closed

*Written 2026-07-29 (work done 2026-07-28). Branch `docs/backfill-diagnostics-2026-07-28`.*

## Read first

- **Repo is private and nothing is published.** The user made it private on
  2026-07-28 (*"i don't want anyone to have the project"*). GitHub Pages is off;
  the site is offline and that is expected, not a bug. **Do not push, deploy, or
  suggest publishing unless the user raises it.** `render/build.ts` writes
  `site/`; `public/` is the committed launch artifact and was NOT touched.
- **Nothing is committed.** All the work below is uncommitted on the branch.
  See "State" at the bottom for the exact file list.
- **The parked timing detectors stay parked.** `trade-vote-alignment` and
  `spousal-trade-timing` remain `registered`/unconsumed (ADR 0003). Nothing here
  went near them.

## What shipped

### 1. IE `MAX(cycle)` render bug — FIXED and verified

**The bug.** `render/build.ts latestIeCycle()` picked `MAX(cycle)` from
`super_pac_ie` and rendered only that cycle. FEC opens each new cycle with
minimum-threshold Schedule E rows ($2–$10), so the just-opened 2026 cycle
structurally outranked the cycle holding the real money.

**Severity was worse than the original ticket said** — it reported 7+ members;
the real count is **15**, and the largest was not Frankel:

| member | was rendered | actual all-cycle | hidden |
|---|---|---|---|
| `steven-horsford` | $6,142 | $2,853,281 | **$2,847,139** |
| `ilhan-omar` | $3,795 | $614,389 | $610,594 |
| `dan-goldman` | $1,073 | $151,936 | $150,863 |
| `lois-frankel` | **$10** | $147,390 | $147,380 |
| `mike-johnson` | **$2** | $13,470 | $13,468 |

**The fix.** Render *every* cycle with data, newest first — no ranking heuristic,
nothing hidden. New module `render/ie-cycles.ts` holds the pure logic
(`orderIeCycles`, `ieCycleLabel`); `build.ts` keeps the DB/network glue. This
follows the existing split where `member-sections.ts` / `empty-shells.ts` hold
testable pure helpers.

**Key structural fact for whoever touches this next:** `renderOutsideSpending()`
does **not** read `super_pac_ie`. The DB supplies only a cycle *number*; every
rendered dollar comes from `fetchSuperPacIE()` (`lib/fec-ie.ts`), a live FEC
fetcher backed by a JSON file cache under
`data/caches/pfd-cache/fec-ie/<CAND>/<cycle>-funders3.json`. Both cycles were
already cached (58 files for 2024, 39 for 2026), so **the fix required no
network access**.

**Ordering is by cycle, deliberately not by spend.** Summed dollars are not a
total order (ties at $10 are plausible), and a magnitude rank would silently
promote an old cycle over the live one. `ORDER BY cycle DESC` after `GROUP BY
cycle` is already total — this satisfies the render-path determinism invariant.

**Verified:**
- 5 new tests in `render/ie-cycles.test.ts`, written *before* the implementation
  and confirmed failing (missing module) first. **208/208 total**, tsc clean.
- `verify:baseline` exit 0, linkage 80.3%.
- Frankel now shows 2026 $10 **and** 2024 $40.9K/$106.5K.
- Horsford's $2.84M renders.
- `dan-crenshaw` **not regressed** — his 2026 ($1.07M/$408.6K) legitimately
  dominates 2024 ($1.4K) and still leads.
- Double-render byte-identical (timestamp line stripped). Full site builds.

**One plan criterion deliberately not met.** The plan said a single-cycle member
should render byte-identically. That was wrong: the section markup changed for
everyone (per-cycle `<h3>`, `<div class="ie-cycle">` wrapper, `h3`→`h4`
demotion, lede reworded to "by election cycle"). Pelosi's diff is **exactly**
those markup lines — every dollar figure, committee name, and filing count
unchanged. The *data* invariant holds; the byte invariant could not survive an
intentional restructure. Verified by rendering her from `git show HEAD:` and
diffing the section.

### 2. PFD OCR — the codebase's conclusion is WRONG (finding, not a fix)

`skills/pfd-fetcher/extract.ts:482` logs *"scanned table — needs commercial
OCR"* and discards the result. **That is wrong: the scans are rotated 90°.**
Tesseract reports it itself — `--psm 0` returns `Orientation in degrees: 270 /
Rotate: 90`.

Rotating before OCR takes a khanna page from **337 bytes of noise** to **1,089
bytes** containing `Periodic Transaction Report`, `FULL ASSET NAME`, `AMOUNT OF
TRANSACTION`. A data page reached 1,420 bytes with real column headers.

**Why nobody found it.** The files are 1-bit CCITT fax scans at 200 ppi native;
`ocrPdf` rasterizes at `-r 250`, upsampling a bilevel image. Every tuning knob
was a dead end — 400 DPI, psm 4 (produced *zero* bytes), psm 11, native-res
extraction via `pdfimages`. **Rotation was the only variable that mattered.**

**Direction is +90, not −90.** At −90 the text is mirrored (`dX3 OTZ` is
`AAPL...EXP` reversed) and looks *almost* plausible — worth pinning in a comment.

**NOT finished — do not treat as solved.** A spot check found 3 mccaul files
still yield 0 bytes after +90, so orientation is likely per-file. The next step
is **per-page orientation detection via `--psm 0`** rather than a hardcoded +90.
And readable headers do **not** guarantee `extractPTR_OCR()` (the psm-6
pipe-grid parser) can parse the rows — that is still unproven.

Full detail: `docs/2026-07-28-pfd-ocr-rotation-finding.md`.

Separately, the OCR **trigger** at `extract.ts:467` (`!text.trim()`) is an
independent bug: ~5 files contain 51–83 bytes of junk which is truthy, so OCR is
silently skipped. Also note `extract.ts` is year-dir scoped with no member
filter and overwrites existing `.json`, so a naive re-run re-OCRs every other
member too.

**Blocked side-quest:** the user asked for a ChatGPT consult on the OCR
approach. A Sonnet subagent (per the standing browser-harness delegation rule)
could not connect — Chrome needs a manual **Allow** click at `chrome://inspect`
for CDP. The empirical probe above answered the question anyway, so this is now
optional.

### 3. Senate PTR harvest — all 11 are genuine nulls

All 11 previously-uncached senators filed **zero PTRs for 2022–2026**, 0 errors:
Klobuchar, Sanders, Schumer, Booker, Warren, Cornyn, Hawley, Murkowski, Paul,
Cruz, Tuberville.

**A uniform zero is the exact signature of a broken `getSession()`**, so it was
ruled out with a positive control: `Sheldon Whitehouse` returned **30 PTRs (1
new, 29 cached)** through the same code path in the same session. The efdsearch
CSRF scrape, disclaimer POST, and session cookie all work. **The zeros are
substantive.**

This matches the House base rate — 23 of 26 House PTR-zeros were verified
non-filers against the House Clerk index. Zero trades is a fact about the
member, not a pipeline gap. **Do not "fix" these senators.**

**Side effect:** the control found 1 genuinely new Whitehouse filing, loaded via
`--bioguide W000802`. `pfd_transactions` 5,078 → **5,084**; his themed trades
80 → **85**, band unchanged (`ranked`). Gates green after.

Full detail incl. per-senator table: `docs/2026-07-28-senate-ptr-harvest-outcomes.md`.

## Durable gotchas (cost time this session)

- **`--member <slug>` does NOT work on the loaders.** `lib/ingest-scope.ts`
  resolves via the legislator *name* index, not hyphenated slugs. Use
  `--bioguide <id>`. (`lois-frankel` → unresolved; `F000462` → fine.)
- **`npx tsx -e` fails on this repo** — *"Top-level await is currently not
  supported with the cjs output format"*. Write a `.ts` file and run it. A file
  placed *outside* the repo also fails (no inherited `"type": "module"`) — wrap
  in `async function main(){…}; main();`.
- **Renders go to `site/`, not `public/`.** `public/` is the committed artifact.
- **`site/` is untracked**, so there is no committed baseline to diff a render
  against. To compare pre/post, restore the old file via
  `git show HEAD:render/build.ts` and re-render — do **not** try `git stash` with
  untracked new files in the set (it fails on the pathspec and leaves you
  guessing whether anything moved).
- **ImageMagick `convert` is NOT installed.** Use Python PIL for rotation.
- **`render/skeleton.golden.test.ts` hashes fixture slots, not real query
  output** — it will *not* catch a determinism regression in a real render path.
  Verify by double-rendering an actual member.

## State

Branch `docs/backfill-diagnostics-2026-07-28`, one commit ahead of `main`
(`785dd90`, docs only). **Everything below is uncommitted:**

```
 M render/build.ts                                  (IE both-cycle fix)
 M docs/HANDOFF-frankel-fec-ie-2026-07-28.md        (OUTCOME section, not mine)
?? render/ie-cycles.ts                              (new, pure logic)
?? render/ie-cycles.test.ts                         (new, 5 tests)
?? docs/2026-07-28-pfd-ocr-rotation-finding.md      (new)
?? docs/2026-07-28-senate-ptr-harvest-outcomes.md   (new)
```

Pre-existing untracked, **left alone by design**:
`data/recipient_ticker.worklist.tsv`,
`docs/HANDOFF-confirmatory-governance-2026-07-22.md`,
`docs/superpowers/specs/2026-07-28-receipts-distribution-design.md`.

Gates at handoff: **208/208 tests**, `verify:baseline` exit 0, linkage 80.3%,
tsc clean, `pfd_transactions` 5,084.

Backups:
- `~/backups/civiclens-2026-07-28-pre-ticker-backfill.duckdb` (sha `e5353300…`)
- `~/backups/civiclens-2026-07-28-pre-senate-harvest.duckdb` (sha `40b23172…`)

## Next, in order of value

1. **Commit the IE fix.** It is verified and sitting uncommitted.
2. **Finish the OCR work** — per-page `--psm 0` orientation, re-probe the 3
   zero-byte mccaul files, then find out whether `extractPTR_OCR` can parse
   rotated output. Fix the `!text.trim()` trigger separately. If rotated OCR
   still yields 0 transactions, *that* is when "needs commercial OCR" becomes a
   supported conclusion — and the finding doc should be updated to say so.
3. **OpenSecrets harvest, 11 members** — still the largest untouched gap.
   `dan-goldman` and `lois-frankel` are **published members with zero
   donor-sector data**. Browser-harness Cloudflare harvest via a Sonnet
   subagent; skill: `civiclens-opensecrets-harvest`. (Note this data is
   substrate-only — it must never be republished as a site section.)
4. **Optional:** port the `usableDonors()` non-empty guard into
   `db/load-fec-ie.ts`. It still deletes unconditionally before insert, so a
   silent-empty FEC response wipes a member/cycle. Frankel had 0 rows so nothing
   was at risk this time; blast radius roster-wide is 305 aggregates / 6,985
   filings.
