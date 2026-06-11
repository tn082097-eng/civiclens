# PR 1: XSS Hardening in render/build.ts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the `javascript:` URL and inline-`<script>` JSON injection gaps in the static-site generator, with hostile-payload tests and a byte-identical corpus render as proof of no regression.

**Architecture:** Three small helpers (`safeJson`, `safeUrl`, `memberHref`) added next to the existing `esc()` in `render/build.ts` (single-file pattern, exported for tests — the file has an `import.meta.url` main-guard at line 2128 and no top-level DB connection, so importing it is side-effect-free). Helpers are applied at 4 JSON embed sites, 10 external-URL href sites, and 3 internal member-link sites. Spec: `docs/superpowers/specs/2026-06-10-phase2-closeout-design.md` (PR 1 section).

**Tech Stack:** TypeScript via `tsx`, `node:test` + `node:assert` (matches `pipeline/patterns/*.test.ts`), DuckDB-backed static render.

**Branch:** all work on `fix/render-xss-hardening` off `main`. Do not push or merge without user sign-off.

---

### Task 0: Branch + determinism baseline

The whole PR's regression gate is a byte-diff of `site/`. That only works if the build is deterministic, so prove it first.

**Files:** none modified.

- [ ] **Step 1: Create the branch**

```bash
cd ~/Developer/civiclens
git checkout -b fix/render-xss-hardening
```

- [ ] **Step 2 (amended 2026-06-10): Fix the nexus ORDER BY tie**

Execution found two pre-existing nondeterminism sources on `main`:
1. `layout()` embeds a minute-precision `generated YYYY-MM-DD HH:MMZ` footer timestamp in every page — builds straddling a minute boundary differ. Product-intentional; the gate normalizes it (see hash function below).
2. `db/queries/trade-bill-nexus.sql` ORDER BY is not total: same-day duplicate trades (same member/ticker/asset/bill, e.g. Pelosi's two 2022-05-24 MSFT trades) tie on all eight sort keys and swap arbitrarily, reordering `nexus.html` rows run-to-run.

Fix the SQL (the footer timestamp is NOT changed in this PR):

```sql
ORDER BY days_before_vote ASC, member_name ASC, tx_date DESC,
         member_id ASC, vote_id ASC, ticker ASC, asset ASC, bill_id ASC,
         tx_type ASC, amount_band ASC, trade_source_url ASC;
```

(`tx_type`/`amount_band`/`trade_source_url` are the trade-level distinguishers; every other rendered column is functionally determined by keys already in the sort.)

Commit:
```bash
git add db/queries/trade-bill-nexus.sql
git commit -m "fix(queries): total ordering in trade-bill-nexus (same-day duplicate trades tied)"
```

- [ ] **Step 3: Build twice across a minute boundary and confirm timestamp-normalized hashes match**

All hashing in this plan uses this normalization (define it as a shell function per session):

```bash
hashsite() {
  for f in $(find site -name '*.html' | sort); do
    sed 's/generated [0-9-]* [0-9:]*Z/generated TIMESTAMP/' "$f" | sha256sum | sed "s|-|$f|"
  done
}
npx tsx render/build.ts
hashsite > /tmp/site-run1.txt
sleep 61   # force a minute-boundary crossing so the normalization is actually exercised
npx tsx render/build.ts
hashsite > /tmp/site-run2.txt
diff /tmp/site-run1.txt /tmp/site-run2.txt && echo DETERMINISTIC
```

Expected: `DETERMINISTIC`. If the diff is non-empty, **stop** and report — there is a further nondeterminism source beyond the two identified above.

- [ ] **Step 4: Keep run1 as the baseline**

```bash
cp /tmp/site-run1.txt /tmp/site-before.txt
```

---

### Task 1: `safeJson` helper (TDD)

**Files:**
- Create: `render/_safe.test.ts`
- Modify: `render/build.ts` (insert after `esc()`, which ends at line 56)
- Modify: `package.json:7` (test glob)

- [ ] **Step 1: Add the new test path to the test script**

In `package.json`, change:

```json
"test": "tsx --test pipeline/patterns/*.test.ts"
```

to:

```json
"test": "tsx --test pipeline/patterns/*.test.ts render/*.test.ts"
```

- [ ] **Step 2: Write the failing tests**

Create `render/_safe.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeJson } from './build.js';

test('safeJson neutralizes </script> breakout', () => {
  const out = safeJson({ x: '</script><script>alert(1)</script>' });
  assert.ok(!out.includes('<'), 'no literal < may survive');
  assert.ok(!out.includes('>'), 'no literal > may survive');
  // Must still parse back to the original value
  assert.deepEqual(JSON.parse(out), { x: '</script><script>alert(1)</script>' });
});

test('safeJson neutralizes HTML-comment open', () => {
  const out = safeJson({ x: '<!-- sneaky' });
  assert.ok(!out.includes('<!--'));
  assert.deepEqual(JSON.parse(out), { x: '<!-- sneaky' });
});

test('safeJson escapes U+2028/U+2029 line separators', () => {
  const out = safeJson({ x: 'a\u2028b\u2029c' });
  assert.ok(!out.includes('\u2028'), 'no raw U+2028');
  assert.ok(!out.includes('\u2029'), 'no raw U+2029');
  assert.deepEqual(JSON.parse(out), { x: 'a\u2028b\u2029c' });
});

test('safeJson is identity for clean data', () => {
  assert.equal(safeJson({ a: 1, b: 'x' }), '{"a":1,"b":"x"}');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `build.js` does not export `safeJson` (the new test file fails to import; the existing pattern tests stay green).

- [ ] **Step 4: Implement `safeJson` in `render/build.ts`**

Insert directly after the `esc()` function (after line 56), inside the existing `HTML helpers (XSS-safe)` section. Note the replacement strings are written with doubled backslashes because they appear inside string literals:

```ts
/**
 * JSON.stringify for embedding inside an inline <script> block.
 * Escapes <, >, and U+2028/U+2029 so the payload can never close the
 * script element, open an HTML comment, or break JS string parsing.
 * Output remains valid JSON (JSON.parse round-trips).
 */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all safeJson tests green; pattern tests still green).

- [ ] **Step 6: Commit**

```bash
git add render/_safe.test.ts render/build.ts package.json
git commit -m "feat(render): add safeJson helper for inline script embeds"
```

---

### Task 2: `safeUrl` + `memberHref` helpers (TDD)

**Files:**
- Modify: `render/_safe.test.ts`
- Modify: `render/build.ts` (insert after `safeJson`)

- [ ] **Step 1: Write the failing tests**

Append to `render/_safe.test.ts` (extend the existing import line to `import { esc, safeJson, safeUrl, memberHref } from './build.js';` — Step 3 adds `export` to `esc`, which is currently module-private):

```ts
test('safeUrl allows http/https absolute URLs unchanged', () => {
  assert.equal(safeUrl('https://www.fec.gov/data/x'), 'https://www.fec.gov/data/x');
  assert.equal(safeUrl('http://clerk.house.gov/y'), 'http://clerk.house.gov/y');
});

test('safeUrl allows same-page anchors', () => {
  assert.equal(safeUrl('#sec-trades'), '#sec-trades');
});

test('safeUrl rejects dangerous or malformed schemes', () => {
  assert.equal(safeUrl('javascript:alert(1)'), '#');
  assert.equal(safeUrl('JaVaScRiPt:alert(1)'), '#');
  assert.equal(safeUrl('data:text/html,<script>alert(1)</script>'), '#');
  assert.equal(safeUrl('vbscript:msgbox(1)'), '#');
  assert.equal(safeUrl('//evil.example.com/x'), '#');           // protocol-relative
  assert.equal(safeUrl(' javascript:alert(1)'), '#');           // leading space
  assert.equal(safeUrl('java\nscript:alert(1)'), '#');          // embedded newline
});

test('safeUrl falls back on null/undefined/empty', () => {
  assert.equal(safeUrl(null), '#');
  assert.equal(safeUrl(undefined), '#');
  assert.equal(safeUrl(''), '#');
});

test('safeUrl passes # fallback values through', () => {
  // call sites use `x ?? '#'`; '#' itself must survive
  assert.equal(safeUrl('#'), '#');
});

test('memberHref builds .html links only from clean slugs', () => {
  assert.equal(memberHref('nancy-pelosi'), 'nancy-pelosi.html');
  assert.equal(memberHref('mtg-greene14', 'members/'), 'members/mtg-greene14.html');
  assert.equal(memberHref('../../etc/passwd'), '#');
  assert.equal(memberHref('a"onmouseover="x'), '#');
  assert.equal(memberHref(null), '#');
});

test('esc(safeUrl(x)) pairing neutralizes attribute breakout in a valid URL', () => {
  // an http URL is allowed through safeUrl; esc must still neutralize the quote
  const out = esc(safeUrl('https://example.com/"><img src=x onerror=alert(1)>'));
  assert.ok(!out.includes('"'), 'no raw double-quote may reach the attribute');
  assert.ok(!out.includes('<') && !out.includes('>'), 'no raw angle brackets');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `safeUrl`/`memberHref` not exported.

- [ ] **Step 3: Implement both helpers in `render/build.ts`**

First, export the existing `esc` for the pairing test — change `function esc(s: unknown): string {` (line 44) to `export function esc(s: unknown): string {`. No call sites change.

Then insert directly after `safeJson`:

```ts
/**
 * URL allowlist for href attributes fed by external data (source_url etc.).
 * Permits absolute http/https and same-page #anchors; everything else
 * (javascript:, data:, vbscript:, protocol-relative //, garbage) collapses
 * to the fallback. esc() at the call site still handles attribute quoting:
 * the pattern is always href="${esc(safeUrl(x))}".
 */
export function safeUrl(url: unknown, fallback = '#'): string {
  if (url === null || url === undefined) return fallback;
  const s = String(url);
  if (/^#[\w-]*$/.test(s)) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return fallback;
}

/** Internal member-page link from a DB slug. Anything but [a-z0-9-] collapses to '#'. */
export function memberHref(id: unknown, prefix = ''): string {
  const s = String(id ?? '');
  return /^[a-z0-9-]+$/.test(s) ? `${prefix}${s}.html` : '#';
}
```

Note `safeUrl` deliberately does **not** trim: a leading space already fails both regexes, which is the correct (reject) behavior for attacker-shaped input.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add render/_safe.test.ts render/build.ts
git commit -m "feat(render): add safeUrl allowlist and memberHref slug guard"
```

---

### Task 3: Apply `safeJson` at the 4 inline-script embed sites

**Files:**
- Modify: `render/build.ts:748,1599,1835,1851`

- [ ] **Step 1: Convert each embed**

Line 748 (timeline data):
```ts
const dataJson = safeJson({ votes, trades });
```

Line 1599 (network graph):
```ts
const graphJson = safeJson({ nodes, edges });
```

Line 1835 (nexus graph):
```ts
const nexusJson = safeJson(nexusObj);
```

Line 1851 (inline theme map, inside the `graphScript` template literal):
```ts
const THEME = ${safeJson(themeColors)};
```

Also delete the now-misleading comment above line 748 ("escaping is redundant but applied defensively by the client-side escHtml()") and replace with:
```ts
// safeJson prevents </script> breakout; client-side escHtml() still guards DOM writes.
```

- [ ] **Step 2: Verify no raw embed stringify remains**

Run: `rg -n 'JSON\.stringify' render/build.ts`
Expected: zero matches (all four sites converted; `safeJson` owns the only stringify).

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add render/build.ts
git commit -m "fix(render): route all inline script embeds through safeJson"
```

---

### Task 4: Apply `safeUrl` at the 10 external-URL href sites

**Files:**
- Modify: `render/build.ts` — lines 455, 466, 469, 1367, 1391, 1434, 1479, 1516, 1784, 1793 (line numbers are pre-Task-1; they shift by the ~30 inserted helper lines — locate by the quoted snippets, `rg -n 'esc\((closestHref|billHref)' render/build.ts` etc.)

- [ ] **Step 1: Convert each site — the uniform rewrite is `esc(X)` → `esc(safeUrl(X))` inside `href="..."`**

| Site (pre-task line) | Before | After |
|---|---|---|
| 455 | `href="${esc(t.closestJurisdiction.bill_source_url ?? t.closestJurisdiction.vote_source_url ?? '#')}"` | `href="${esc(safeUrl(t.closestJurisdiction.bill_source_url ?? t.closestJurisdiction.vote_source_url))}"` |
| 466 | `href="${esc(closestHref)}"` | `href="${esc(safeUrl(closestHref))}"` |
| 469 | `href="${esc(t.trade_source_url ?? '#')}"` | `href="${esc(safeUrl(t.trade_source_url))}"` |
| 1367 | `href="${esc(d.source_url ?? '#')}"` | `href="${esc(safeUrl(d.source_url))}"` |
| 1391 | `href="${esc(c.sourceUrl)}"` | `href="${esc(safeUrl(c.sourceUrl))}"` |
| 1434 | `href="${esc(t.trade_source_url ?? '#')}"` | `href="${esc(safeUrl(t.trade_source_url))}"` |
| 1479 | `href="${esc(billHref)}"` | `href="${esc(safeUrl(billHref))}"` |
| 1516 | `href="${esc(t.source_url ?? '#')}"` | `href="${esc(safeUrl(t.source_url))}"` |
| 1784 (inside `srcLink()`) | `href="${esc(url)}"` | `href="${esc(safeUrl(url))}"` |
| 1793 | `href="${esc(r.bill_source_url)}"` | `href="${esc(safeUrl(r.bill_source_url))}"` |

The `?? '#'` fallbacks are dropped where shown because `safeUrl` supplies the same `'#'` fallback for null/undefined.

Leave line 1231 (`href="${anchor}"`) unchanged — `anchor` comes from the hardcoded `EVIDENCE_ANCHOR` constant map, not from data. Add this one-line comment above it:
```ts
// anchor is from the EVIDENCE_ANCHOR constant map, not external data — no safeUrl needed.
```

- [ ] **Step 2: Verify coverage**

Run: `rg -n 'href="\$\{esc\(' render/build.ts | rg -v 'safeUrl|memberHref'`
Expected: only the three internal member-link sites (Task 5) remain.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add render/build.ts
git commit -m "fix(render): allowlist external URLs in href attributes via safeUrl"
```

---

### Task 5: Apply `memberHref` at the 3 internal member-link sites

**Files:**
- Modify: `render/build.ts` — pre-task lines 460, 1067, 1409

- [ ] **Step 1: Convert each site**

Line 460 (index closest-trades feed):
```ts
<td><a class="member" href="${memberHref(t.member_id, 'members/')}">${esc(t.member_name)}</a>...
```
(replaces `href="members/${esc(t.member_id)}.html"`)

Line 1067 (co-sponsorship table):
```ts
<td><a class="member" href="${memberHref(e.peer_id)}">${esc(e.peer_name)}</a>...
```
(replaces `href="${esc(e.peer_id)}.html"`)

Line 1409 (shared-donor peers table):
```ts
<td><a class="member" href="${memberHref(p.peer_id)}">${esc(p.peer_name)}</a></td>
```
(replaces `href="${esc(p.peer_id)}.html"`)

- [ ] **Step 2: Verify no unguarded dynamic hrefs remain**

Run: `rg -n 'href="\$\{' render/build.ts | rg -v 'safeUrl|memberHref|EVIDENCE_ANCHOR' ; rg -n 'href="\$\{anchor\}"' render/build.ts`
Expected: first command returns only the `${anchor}` line (covered by the constant-map comment); second confirms it's the documented one.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add render/build.ts
git commit -m "fix(render): slug-guard internal member links via memberHref"
```

---

### Task 6: Corpus byte-diff gate

**Files:** none modified.

- [ ] **Step 1: Rebuild and hash (timestamp-normalized, same `hashsite` function as Task 0)**

```bash
hashsite() {
  for f in $(find site -name '*.html' | sort); do
    sed 's/generated [0-9-]* [0-9:]*Z/generated TIMESTAMP/' "$f" | sha256sum | sed "s|-|$f|"
  done
}
npx tsx render/build.ts
hashsite > /tmp/site-after.txt
diff /tmp/site-before.txt /tmp/site-after.txt
```

Expected: **empty diff** (byte-identical). The existing corpus is clean — every real `source_url` is FEC/Congress.gov/Clerk http(s) — so neutralization should never fire.

- [ ] **Step 2: If the diff is NOT empty — investigate, don't paper over**

For each differing page, find what changed (sequential, not a one-liner — stash inside process substitution does not sequence reliably):
```bash
# rebuild the pre-change version of the differing page
git stash
npx tsx render/build.ts
cp site/members/<id>.html /tmp/page-before.html
git stash pop
npx tsx render/build.ts
diff /tmp/page-before.html site/members/<id>.html | head -40
```
Two possible causes, with different outcomes:
1. **Dirty data** (a real artifact carries a non-http URL): that is a *finding* — report it to the user with the offending row; the neutralization is correct and the diff is the new expected baseline.
2. **Helper too strict** (a legitimate URL shape rejected, e.g. an FEC URL with unusual casing): fix the helper, add a test case for that shape, re-run from Task 6 Step 1.

Do not proceed to Task 7 until the diff is either empty or each difference is explained and user-approved.

- [ ] **Step 3: Full suite one last time**

Run: `npm test && npx tsc --noEmit 2>/dev/null || npx tsc --noEmit`
Expected: tests PASS; `tsc --noEmit` clean (run it once; the `||` retry is just to show output on failure).

---

### Task 7: Wrap up — docs note + hand back for PR

**Files:**
- Modify: `docs/superpowers/specs/2026-06-10-phase2-closeout-design.md` (status line only)

- [ ] **Step 1: Mark PR 1 implemented in the spec status line**

Change the spec header `**Status:** approved (design), spec under review` to `**Status:** approved; PR 1 implemented (fix/render-xss-hardening), PRs 2–4 pending`.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-06-10-phase2-closeout-design.md
git commit -m "docs(spec): mark PR 1 implemented"
```

- [ ] **Step 3: Report to user**

Summarize: helpers added, sites converted (4 embeds / 10 external hrefs / 3 slug links), test count, byte-diff result. **Stop — pushing the branch and opening the GitHub PR is the user's call.**
