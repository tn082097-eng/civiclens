# Uniform Member Skeleton (Issue #7) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every member page renders the same ordered section scaffold (stable `<h2 id="sec-*">` anchors). Absence becomes explicit empty-state copy, never section omission — and Lane 1 receipts finally render on member pages.

**Architecture:** Introduce a `render/member-sections.ts` module that owns the ordered section registry (`MEMBER_SECTION_IDS`), a `sectionShell()` helper, a `reservedStub()` helper, and a pure `assembleMemberBody(slots)` function that joins section HTML in registry order and throws if any slot is missing. `buildMemberPage` keeps its data-fetching, builds a `slots` record from existing block strings (plus new receipts + always-on empty shells + reserved stubs), and delegates final ordering to `assembleMemberBody`. A new `render/load-artifacts.ts` provides `loadThemeGapsOrSentinel()`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `node:test` + `node:assert/strict` run via `tsx --test` (glob `render/*.test.ts` in `package.json`), DuckDB (unchanged), ADR 0001.

## Global Constraints

- **ADR 0001:** member-page HTML is deterministic; no LLM on the render/ship path.
- **Section order (13 slots):** `sec-identity`, `sec-glance`, `sec-receipts`, `sec-coherence`, `sec-money-votes`, `sec-timeline`, `sec-trades`, `sec-donors`, `sec-revolving`, `sec-outside-spending`, `sec-peers`, `sec-patterns`, `sec-cosponsor`. Each id appears **exactly once**.
- **Reserved stubs:** `sec-coherence` and `sec-money-votes` render `Not computed yet.` until their lanes ship (Lane 3 / Issue #6 Task 9 replace only their own stub).
- **Neutral empty copy:** no "suspicious"/"clean"/"guilty"; absence is stated as data.
- **Links:** every `href` goes through `safeUrl()` / `memberHref()` (existing helpers); receipts internal hrefs are unchanged here (PR1 follow-up is out of scope).
- **Parity bar held constant:** `npm test` green AND `npm run validate:corpus` reports `32 / 1126 / 47678 / 3240 / 182`.
- **Import specifiers use `.js`** (e.g. `from './build.js'`) even for `.ts` sources — match existing files.

---

## Task 1: Section registry + shell + pure assembler

**Files:**
- Create: `render/member-sections.ts`
- Test: `render/member-sections.test.ts`

**Interfaces:**
- Produces:
  - `MEMBER_SECTION_IDS: readonly string[]` — the 13 ids above, in order.
  - `sectionShell(id: string, title: string, body: string): string` → `<h2 id="${id}">${escaped title}</h2>\n${body}`
  - `reservedStub(id: string, title: string): string` → `sectionShell(id, title, '<p class="muted">Not computed yet.</p>')`
  - `assembleMemberBody(slots: Record<string, string>): string` — joins `slots[id]` for each id in `MEMBER_SECTION_IDS`, in order, separated by `\n`. Throws `Error("missing section slot: <id>")` if any registry id has no entry.

- [ ] **Step 1: Write the failing test**

Create `render/member-sections.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMBER_SECTION_IDS, sectionShell, reservedStub, assembleMemberBody } from './member-sections.js';

test('registry lists the 13 sections in fixed order', () => {
  assert.deepEqual([...MEMBER_SECTION_IDS], [
    'sec-identity', 'sec-glance', 'sec-receipts', 'sec-coherence', 'sec-money-votes',
    'sec-timeline', 'sec-trades', 'sec-donors', 'sec-revolving', 'sec-outside-spending',
    'sec-peers', 'sec-patterns', 'sec-cosponsor',
  ]);
});

test('sectionShell emits an h2 with the id and escapes the title', () => {
  const html = sectionShell('sec-donors', 'Top donors & peers', '<p>x</p>');
  assert.match(html, /<h2 id="sec-donors">Top donors &amp; peers<\/h2>/);
  assert.ok(html.includes('<p>x</p>'));
});

test('reservedStub renders the not-computed-yet empty state', () => {
  const html = reservedStub('sec-money-votes', 'Money & votes');
  assert.match(html, /id="sec-money-votes"/);
  assert.match(html, /not computed yet/i);
});

test('assembleMemberBody emits each section id exactly once, in order', () => {
  const slots: Record<string, string> = {};
  for (const id of MEMBER_SECTION_IDS) slots[id] = `<h2 id="${id}">t</h2>`;
  const body = assembleMemberBody(slots);
  for (const id of MEMBER_SECTION_IDS) {
    const matches = body.match(new RegExp(`id="${id}"`, 'g')) ?? [];
    assert.equal(matches.length, 1, `${id} appears once`);
  }
  assert.ok(body.indexOf('sec-identity') < body.indexOf('sec-cosponsor'), 'order preserved');
});

test('assembleMemberBody throws when a slot is missing', () => {
  const slots: Record<string, string> = {};
  for (const id of MEMBER_SECTION_IDS) slots[id] = 'x';
  delete slots['sec-peers'];
  assert.throws(() => assembleMemberBody(slots), /missing section slot: sec-peers/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test render/member-sections.test.ts`
Expected: FAIL — `Cannot find module './member-sections.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `render/member-sections.ts`:

```typescript
// Ordered section scaffold for every member page (Issue #7).
// Absence is explicit empty-state copy, never section omission.
import { esc } from './build.js';

export const MEMBER_SECTION_IDS = [
  'sec-identity', 'sec-glance', 'sec-receipts', 'sec-coherence', 'sec-money-votes',
  'sec-timeline', 'sec-trades', 'sec-donors', 'sec-revolving', 'sec-outside-spending',
  'sec-peers', 'sec-patterns', 'sec-cosponsor',
] as const;

export function sectionShell(id: string, title: string, body: string): string {
  return `<h2 id="${id}">${esc(title)}</h2>\n${body}`;
}

export function reservedStub(id: string, title: string): string {
  return sectionShell(id, title, '<p class="muted">Not computed yet.</p>');
}

export function assembleMemberBody(slots: Record<string, string>): string {
  return MEMBER_SECTION_IDS.map((id) => {
    const slot = slots[id];
    if (slot === undefined) throw new Error(`missing section slot: ${id}`);
    return slot;
  }).join('\n');
}
```

If `esc` is not exported from `build.ts`, add `export` to its declaration in `render/build.ts` (it is used by `member-sections.ts`). Confirm first: `grep -n 'function esc' render/build.ts` — if it reads `function esc`, change to `export function esc`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test render/member-sections.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add render/member-sections.ts render/member-sections.test.ts render/build.ts
git commit -m "feat(render): member-page section registry + pure assembler (#7)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Receipts artifact loader + sentinel

**Files:**
- Create: `render/load-artifacts.ts`
- Test: `render/load-artifacts.test.ts`

**Interfaces:**
- Consumes: `ThemeGapReceiptsSchema`, `ThemeGapReceipts` from `../lib/schemas.js`.
- Produces: `loadThemeGapsOrSentinel(memberId: string): ThemeGapReceipts` — reads `pipeline/artifacts/<memberId>.theme-gaps.json`, parses with `ThemeGapReceiptsSchema`; on missing/unparseable file returns a valid zero sentinel (`band: 'insufficient-data'`, empty `receipts`, zero coverage) so `renderReceiptsSection` always renders its explicit empty state.

- [ ] **Step 1: Confirm the repo-root path export**

Run: `grep -nE "export const (REPO_ROOT|ROOT|repoRoot)" lib/paths.ts`
Use whichever constant names the repo root in the implementation below (the plan assumes `REPO_ROOT`; substitute the real name if different).

- [ ] **Step 2: Write the failing test**

Create `render/load-artifacts.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadThemeGapsOrSentinel } from './load-artifacts.js';

test('missing artifact returns a valid empty sentinel', () => {
  const a = loadThemeGapsOrSentinel('definitely-no-such-member-xyz');
  assert.equal(a.memberId, 'definitely-no-such-member-xyz');
  assert.equal(a.receipts.length, 0);
  assert.equal(a.band, 'insufficient-data');
  assert.equal(a.coverage.votesTotal, 0);
  assert.equal(a.tradeCount, 0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test render/load-artifacts.test.ts`
Expected: FAIL — `Cannot find module './load-artifacts.js'`.

- [ ] **Step 4: Write minimal implementation**

Create `render/load-artifacts.ts` (substitute the real repo-root constant from Step 1):

```typescript
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../lib/paths.js';
import { ThemeGapReceiptsSchema, type ThemeGapReceipts } from '../lib/schemas.js';

export function loadThemeGapsOrSentinel(memberId: string): ThemeGapReceipts {
  const path = resolve(REPO_ROOT, 'pipeline', 'artifacts', `${memberId}.theme-gaps.json`);
  try {
    return ThemeGapReceiptsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return {
      memberId,
      tradeCount: 0,
      disclosedTradeCount: 0,
      band: 'insufficient-data',
      nPerm: 10000,
      windowDays: 90,
      coverage: { votesTotal: 0, votesBillLinked: 0 },
      receipts: [],
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test render/load-artifacts.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Add `id="sec-receipts"` to the receipts section**

In `render/build.ts`, `renderReceiptsSection` has three `return` sites each starting with `<section class="receipts"><h2>Trade–vote timing</h2>`. Change all three opening tags to:

```
<section class="receipts" id="sec-receipts"><h2>Trade–vote timing</h2>
```

Run: `grep -c 'id="sec-receipts"' render/build.ts`
Expected: `3`.

- [ ] **Step 7: Confirm existing receipts tests still pass**

Run: `npx tsx --test render/receipts.test.ts`
Expected: PASS (5 tests — the id addition does not change matched copy).

- [ ] **Step 8: Commit**

```bash
git add render/load-artifacts.ts render/load-artifacts.test.ts render/build.ts
git commit -m "feat(render): theme-gaps sentinel loader + sec-receipts id (#7)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Always-on empty shells for revolving + outside-spending

**Files:**
- Create: `render/empty-shells.ts`
- Test: `render/empty-shells.test.ts`
- Modify: `render/build.ts` (use the new shells; details land in Task 5)

**Interfaces:**
- Consumes: `sectionShell` from `./member-sections.js`.
- Produces:
  - `revolvingEmptyShell(): string` → `sectionShell('sec-revolving', 'Revolving door — former staff now lobbying', '<p class="muted">No disclosed revolving-door lobbyist ties in corpus.</p>')`
  - `outsideSpendingEmptyShell(reason: 'no-fec-id' | 'no-ie'): string` → `sec-outside-spending` shell with `Outside spending unavailable — no FEC candidate id on file.` for `no-fec-id`, or `No independent-expenditure spending found for this cycle.` for `no-ie`.

- [ ] **Step 1: Write the failing test**

Create `render/empty-shells.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revolvingEmptyShell, outsideSpendingEmptyShell } from './empty-shells.js';

test('revolving empty shell is present with neutral copy and the id', () => {
  const html = revolvingEmptyShell();
  assert.match(html, /id="sec-revolving"/);
  assert.match(html, /no disclosed revolving-door lobbyist ties/i);
  assert.doesNotMatch(html, /suspicious|clean|guilty/i);
});

test('outside-spending shell distinguishes unavailable from empty', () => {
  assert.match(outsideSpendingEmptyShell('no-fec-id'), /id="sec-outside-spending"/);
  assert.match(outsideSpendingEmptyShell('no-fec-id'), /unavailable — no FEC candidate id/i);
  assert.match(outsideSpendingEmptyShell('no-ie'), /no independent-expenditure spending/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test render/empty-shells.test.ts`
Expected: FAIL — `Cannot find module './empty-shells.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `render/empty-shells.ts`:

```typescript
import { sectionShell } from './member-sections.js';

export function revolvingEmptyShell(): string {
  return sectionShell(
    'sec-revolving',
    'Revolving door — former staff now lobbying',
    '<p class="muted">No disclosed revolving-door lobbyist ties in corpus.</p>',
  );
}

export function outsideSpendingEmptyShell(reason: 'no-fec-id' | 'no-ie'): string {
  const body = reason === 'no-fec-id'
    ? '<p class="muted">Outside spending unavailable — no FEC candidate id on file.</p>'
    : '<p class="muted">No independent-expenditure spending found for this cycle.</p>';
  return sectionShell('sec-outside-spending', 'Outside spending', body);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test render/empty-shells.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add render/empty-shells.ts render/empty-shells.test.ts
git commit -m "feat(render): always-on empty shells for revolving + outside-spending (#7)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Wire the registry into `buildMemberPage`

**Files:**
- Modify: `render/build.ts` — `buildMemberPage` (L1406–1664) and `renderOutsideSpending` (L1345).

**Interfaces:**
- Consumes: `assembleMemberBody`, `MEMBER_SECTION_IDS`, `reservedStub`, `sectionShell` (Task 1); `loadThemeGapsOrSentinel` (Task 2); `revolvingEmptyShell`, `outsideSpendingEmptyShell` (Task 3).
- Produces: a member page whose body is built solely by `assembleMemberBody(slots)`.

- [ ] **Step 1: Add imports at the top of `render/build.ts`**

After the existing import block, add:

```typescript
import { assembleMemberBody, reservedStub, sectionShell } from './member-sections.js';
import { loadThemeGapsOrSentinel } from './load-artifacts.js';
import { revolvingEmptyShell, outsideSpendingEmptyShell } from './empty-shells.js';
```

- [ ] **Step 2: Make `renderOutsideSpending` return an always-on shell**

In `render/build.ts`, `renderOutsideSpending` currently begins:

```typescript
async function renderOutsideSpending(m: MemberDetail, cycle: number): Promise<string> {
  if (!m.fec_candidate_id) return '';
```

Change the early return to:

```typescript
async function renderOutsideSpending(m: MemberDetail, cycle: number): Promise<string> {
  if (!m.fec_candidate_id) return outsideSpendingEmptyShell('no-fec-id');
```

Then find every other `return ''` inside `renderOutsideSpending` (the no-IE path) and replace with `return outsideSpendingEmptyShell('no-ie');`. Confirm: `grep -nA40 'async function renderOutsideSpending' render/build.ts | grep -n "return ''"` should return nothing after editing.

- [ ] **Step 3: Build the `slots` record and replace the hand-rolled `body`**

In `buildMemberPage`, the existing block variables stay (`meta`, `bio`, `tradeActivityBlock`, `glanceBlock`, `timelineBlock`, `suspiciousTradesBlock`/the trades-tabs markup, `donorsBlock`, `peersBlock`, `outsideSpendingBlock`, `cosponsorBlock`, `patternsBlock`). Replace the `revolvingBlock` definition (L1459, the `revolving.length === 0 ? '' : ...` ternary) so it is always populated:

```typescript
  const revolvingBlock = revolving.length === 0
    ? revolvingEmptyShell()
    : sectionShell('sec-revolving', `Revolving door — former staff now lobbying (${revolving.length})`,
        `<p class="lede">Registered federal lobbyists whose disclosed former government role names ${esc(m.name)} or a committee they sit on. Recency reflects each lobbyist's most recent disclosure filing — not a judgment.</p>\n` +
        revolving.map(c => { /* unchanged card-rendering body from the existing map */ }).join(''));
```

Keep the existing per-card `.map(...)` body verbatim — only the wrapping changed from a bare `<h2 id="sec-revolving">...` to `sectionShell(...)`. Remove the now-duplicate inline `<h2 id="sec-revolving">` heading that was inside the old template.

Load receipts before assembling:

```typescript
  const receiptsBlock = renderReceiptsSection(loadThemeGapsOrSentinel(m.member_id));
```

Then replace the entire `const body = \`...\`;` template (L1608–1659) with a slots record + assembler:

```typescript
  const identityBlock = `<h2 id="sec-identity">${esc(m.name)}</h2>\n${meta}\n${bio}\n${tradeActivityBlock}`;
  const glanceSection = sectionShell('sec-glance', 'Activity at a glance', glanceBlock);
  const timelineSection = sectionShell('sec-timeline', 'Timeline',
    `<p class="lede" style="margin-bottom:8px;">Votes (circles, top row) and trades (diamonds, bottom row) plotted on the same axis. Hover for detail. One dot per month — most significant vote shown (Nay preferred over Yea).</p>\n${timelineBlock}`);
  const tradesSection = sectionShell('sec-trades', 'Trades & bills', tradesInner); // tradesInner = the existing tabs markup (lede + section-tabs + panels + showTab script), minus its old <h2>
  const donorsSection = sectionShell('sec-donors', 'Top donors (lifetime, 4-cycle FEC union)', donorsBlock);
  const peersSection = sectionShell('sec-peers', 'Shared-donor peers in corpus', peersBlock);
  const patternsSection = sectionShell('sec-patterns', 'Patterns', patternsBlock);
  const cosponsorSection = sectionShell('sec-cosponsor', 'Co-sponsorship', cosponsorBlock);

  const body = assembleMemberBody({
    'sec-identity': identityBlock,
    'sec-glance': glanceSection,
    'sec-receipts': receiptsBlock,
    'sec-coherence': reservedStub('sec-coherence', 'Per-theme coherence'),
    'sec-money-votes': reservedStub('sec-money-votes', 'Money & votes'),
    'sec-timeline': timelineSection,
    'sec-trades': tradesSection,
    'sec-donors': donorsSection,
    'sec-revolving': revolvingBlock,
    'sec-outside-spending': outsideSpendingBlock,
    'sec-peers': peersSection,
    'sec-patterns': patternsSection,
    'sec-cosponsor': cosponsorSection,
  }) + '\n<p style="margin-top: 32px;"><a class="row-link" href="../index.html">← back to corpus</a></p>';
```

Extract `tradesInner` by taking the existing trades markup (the `<p class="lede">…</p>`, `<div class="section-tabs">…`, both `<div class="tab-panel">…` blocks, and the `<script>showTab…</script>`) exactly as written today but **without** the leading `<h2 id="sec-trades">Trades &amp; bills</h2>` line (the shell now supplies the heading). `patternsBlock`, `glanceBlock`, etc. that already embed their own `<h2>` must have that inner `<h2>` removed so the shell heading is not duplicated — confirm in Step 4's grep that every `sec-*` id appears once.

- [ ] **Step 4: Verify single-render structure on a real member**

Run: `npx tsx render/build.ts && for id in sec-identity sec-glance sec-receipts sec-coherence sec-money-votes sec-timeline sec-trades sec-donors sec-revolving sec-outside-spending sec-peers sec-patterns sec-cosponsor; do echo -n "$id: "; grep -c "id=\"$id\"" site/members/nancy-pelosi.html; done`
Expected: every id prints `1`.

- [ ] **Step 5: Commit**

```bash
git add render/build.ts
git commit -m "feat(render): assemble member body from uniform section registry (#7)

Wires Lane 1 receipts, always-on revolving/outside-spending shells, and
reserved coherence/money-votes stubs through assembleMemberBody.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Golden determinism test

**Files:**
- Test: `render/skeleton.golden.test.ts`

**Interfaces:**
- Consumes: `assembleMemberBody`, `MEMBER_SECTION_IDS` (Task 1).

- [ ] **Step 1: Write the failing test**

Create `render/skeleton.golden.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MEMBER_SECTION_IDS, assembleMemberBody } from './member-sections.js';

function fixtureSlots(): Record<string, string> {
  const slots: Record<string, string> = {};
  for (const id of MEMBER_SECTION_IDS) slots[id] = `<h2 id="${id}">${id}</h2><p>body</p>`;
  return slots;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

test('assembleMemberBody is byte-stable across repeated renders', () => {
  assert.equal(hash(assembleMemberBody(fixtureSlots())), hash(assembleMemberBody(fixtureSlots())));
});

test('every registry id appears exactly once in assembled output', () => {
  const body = assembleMemberBody(fixtureSlots());
  for (const id of MEMBER_SECTION_IDS) {
    assert.equal((body.match(new RegExp(`id="${id}"`, 'g')) ?? []).length, 1, `${id} once`);
  }
});
```

- [ ] **Step 2: Run test to verify it passes (no production code needed)**

Run: `npx tsx --test render/skeleton.golden.test.ts`
Expected: PASS (2 tests). If the "exactly once" test fails, a section slot string contains a stray duplicate id — fix the offending block in Task 4.

- [ ] **Step 3: Run the full render test suite**

Run: `npm test`
Expected: PASS — all `render/*.test.ts`, `agents/*.test.ts`, `pipeline/patterns/*.test.ts` green.

- [ ] **Step 4: Commit**

```bash
git add render/skeleton.golden.test.ts
git commit -m "test(render): golden determinism + id-once for member skeleton (#7)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Publish artifacts for the 32 members + parity verify

**Files:**
- Generate: `pipeline/artifacts/<slug>.theme-gaps.json` for the 32 publish members (data output, gitignored or committed per existing artifact convention — match what `pipeline/artifacts/` currently does).

**Interfaces:**
- Consumes: `pipeline/score-theme-gaps.ts` (writes `pipeline/artifacts/<member>.theme-gaps.json`); `loadThemeGapsOrSentinel` (Task 2) reads them.

- [ ] **Step 1: List the publish set**

Run: `npx tsx -e "import {getDb} from './db/init.js'; const db=await getDb(); const r=await db.all('SELECT member_id FROM members ORDER BY member_id'); console.log(r.map((x:any)=>x.member_id).join(' ')); process.exit(0)"`
Expected: ~32 slugs. (If a dedicated publish-set list exists, use it instead.)

- [ ] **Step 2: Batch-generate theme-gaps artifacts**

Run (substitute the real slug list from Step 1):

```bash
for slug in $(npx tsx -e "import {getDb} from './db/init.js'; const db=await getDb(); const r=await db.all('SELECT member_id FROM members ORDER BY member_id'); process.stdout.write(r.map((x:any)=>x.member_id).join(' ')); process.exit(0)"); do
  npx tsx pipeline/score-theme-gaps.ts --member "$slug" || echo "SKIP $slug";
done
```

Expected: one `pipeline/artifacts/<slug>.theme-gaps.json` per member (some may legitimately be insufficient-data — that is valid output, not failure).

- [ ] **Step 3: Confirm artifacts parse and render non-sentinel where data exists**

Run: `npx tsx -e "import {loadThemeGapsOrSentinel} from './render/load-artifacts.js'; const a=loadThemeGapsOrSentinel('nancy-pelosi'); console.log(a.disclosedTradeCount, a.receipts.length); process.exit(0)"`
Expected: non-zero `disclosedTradeCount` for nancy-pelosi (proves a real artifact loaded, not the zero sentinel).

- [ ] **Step 4: Full rebuild + corpus parity check**

Run: `npx tsx render/build.ts && npm run validate:corpus`
Expected: parity bar `32 / 1126 / 47678 / 3240 / 182` — unchanged from before this plan.

- [ ] **Step 5: Final full test run**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(render): publish theme-gaps artifacts for the 32-member set (#7)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** registry (Task 1 / 7a) · empty shells (Task 3 / 7b) · receipts wired (Tasks 2+4 / 7c) · golden determinism (Task 5 / 7d) · publish artifacts (Task 6 / 7e). Reserved `sec-coherence`/`sec-money-votes` stubs (Task 4) match the roadmap's "Not computed yet" contract; Lane 3 and Issue #6 Task 9 replace only their own stub.
- **Type consistency:** `loadThemeGapsOrSentinel` returns `ThemeGapReceipts` consumed directly by `renderReceiptsSection(a: ThemeGapReceipts)`. Sentinel satisfies `ThemeGapReceiptsSchema` (verified field-by-field against `lib/schemas.ts:271–283`).
- **Risk note:** Task 4 is the one byte-sensitive refactor; the golden + parity gates (Tasks 5–6) guard against drift. If `esc` / `REPO_ROOT` export names differ, Steps explicitly direct confirming the real names before writing.
- **Out of scope (parked in roadmap):** receipts internal-href `safeUrl` hardening (PR1 follow-up), Lane 3 content, Issue #6 backend, batch-concurrency mutex.
