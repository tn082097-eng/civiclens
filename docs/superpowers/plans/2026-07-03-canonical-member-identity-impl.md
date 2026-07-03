# Canonical Member Identity (#7 Substrate) Implementation Plan — Reconciled

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

> **Reconciled 2026-07-03 (post-audit).** The working tree already holds a mostly-complete
> uncommitted implementation. This plan **closes gaps against that code**; it is not a
> clean-room build. See the spec's "Reconciliation addendum" — it governs. Do NOT
> re-create files that exist; refactor them.

**Goal:** Finish the deterministic, offline member-identity resolver already present in the
working tree — add its missing tests, fix the slug-threading bug, replace the member-scoped
alias seeding with a standalone bioguide-keyed full-YAML projection, and tighten
normalization — so one person always maps to one Bioguide and the existing slug (e.g.
`bernie-sanders`) is preserved, with ambiguity rejected, never guessed.

**Architecture:** `lib/legislators.ts` builds a `bioguide → LegislatorIdentity` index and the
`alias → Set<bioguide>` map from local YAML. `lib/resolve-member.ts` resolves a raw name to a
bioguide (pure core) and then to a slug that **prefers the existing DB row's `member_id`**
(async wrapper). `db/load-member-aliases.ts` seeds `member_aliases` (keyed on `bioguide_id`)
and backfills `members`. `skills/researcher/fetch.ts` gates ingestion on the resolver and now
threads the resolved slug through to `agents/researcher.ts`.

**Tech Stack:** TypeScript + tsx (`tsx --test`, `node:test`), DuckDB (`@duckdb/node-api`),
`js-yaml`. All deps installed.

## Global Constraints

- **No network for identity.** Resolver + index read the local cache
  `data/caches/legislators-cache/legislators-{current,historical}.yaml` (via `LEGISLATORS_CACHE`
  from `lib/paths.ts`) only.
- **No stub data — fail loudly.** Aliases derived only from YAML fields. No fabricated
  bioguides/aliases/members.
- **Never guess, never coerce.** No fuzzy / edit-distance / probabilistic fallback. Multiple
  matches → reject, never first-match. No surname-only alias.
- **Preserve existing slugs.** For a bioguide already in `members`, the resolver returns that
  row's `member_id`; `first-last` is derived only for brand-new members. Do NOT rename
  `bernie-sanders`.
- **`member_aliases` is keyed on `bioguide_id`.** Identity keyed on identity.
- **`bioguide_id UNIQUE` stays** (live DB verified clean: 57/57 backfilled, 0 dups). Seeder
  asserts fail-loud on any duplicate bioguide; no FK-rewrite reconcile.
- **Deterministic across runs.** Same input → same output; no reliance on network, wall clock,
  or map-iteration order for results.
- **Scope fence.** Touches ONLY: `lib/legislators.ts`, `lib/resolve-member.ts`,
  `db/schema.sql`, `db/load-member-aliases.ts`, `db/load-from-tasks.ts` (revert one hook),
  `skills/researcher/fetch.ts`, `agents/researcher.ts`, `package.json`, and test/fixture files.
  No votes/money-vote/renderer changes, no other loaders, no FK dedup.

## File Structure

- `lib/legislators.ts` — **Modify.** Extract pure `buildIndex(paths)`; fix `normalizeName`
  (drop single-letter initials, drop last-only alias); add `buildAliasMap(index)`.
- `lib/legislators.test.ts` — **Create.** Index + normalization + alias-map tests vs fixture.
- `lib/__fixtures__/legislators-fixture.yaml` — **Create.** Sanders + a genuine ambiguous pair.
- `lib/resolve-member.ts` — **Modify.** Extract pure `resolveIdentity(...)`; make slug lookup
  injectable; remove `seedAliasesForMember`.
- `lib/resolve-member.test.ts` — **Create.** Resolver behavior + slug preservation.
- `db/schema.sql` — **Modify.** Re-key `member_aliases` to `(alias_norm, bioguide_id)`.
- `db/load-member-aliases.ts` — **Create.** Standalone seeder: full YAML alias projection +
  members backfill + fail-loud dup-bioguide assert.
- `db/load-from-tasks.ts` — **Modify.** Revert the `seedAliasesForMember` import + call.
- `skills/researcher/fetch.ts` — **Modify.** Add `resolvedSlug` to `LiveFetchResult`; set +
  return it.
- `agents/researcher.ts` — **Modify.** Consume `live.resolvedSlug` (typed; drop `as any`).
- `package.json` — **Modify.** Widen `test` glob to include `lib/*.test.ts`.

---

### Task 1: Testable index + normalization fix (`lib/legislators.ts`)

**Files:**
- Modify: `lib/legislators.ts`
- Create: `lib/__fixtures__/legislators-fixture.yaml`
- Create: `lib/legislators.test.ts`
- Modify: `package.json` (test glob)

**Interfaces:**
- Produces:
  - `interface LegislatorIdentity { bioguide; officialFull; first; last; nickname: string|null; fec: string[]; chamber: 'House'|'Senate'; state; district: string|null; termStart; termEnd }` (already exists — unchanged).
  - `function buildIndex(paths: string[]): Map<string, LegislatorIdentity>` — pure, reads given files, historical-then-current order (current wins).
  - `function buildAliasMap(index: Map<string, LegislatorIdentity>): Map<string, Set<string>>` — normalized alias → set of bioguides.
  - `function normalizeName(s: string): string` — **exported now.**
  - `function getLegislatorIndex(): Map<string, LegislatorIdentity>` — memoized, default cache paths (kept).
  - `function getAllAliases(): Map<string, Set<string>>` — memoized wrapper over `buildAliasMap(getLegislatorIndex())` (kept for `resolve-member.ts`).
  - `function generateAliasesFor(leg): string[]` (kept, minus the last-only line).

- [ ] **Step 1: Create the fixture** `lib/__fixtures__/legislators-fixture.yaml`

```yaml
- id:
    bioguide: S000033
    fec: [H8VT01016, S4VT00033]
  name:
    first: Bernard
    last: Sanders
    nickname: Bernie
    official_full: Bernard Sanders
  terms:
    - { type: rep, start: '1991-01-03', end: '1993-01-03', state: VT, district: 0 }
    - { type: sen, start: '2025-01-03', end: '2031-01-03', state: VT }
- id:
    bioguide: R000001
    fec: [H0AA00001]
  name:
    first: Robert
    last: Smith
    official_full: Robert Smith
  terms:
    - { type: rep, start: '2015-01-03', end: '2027-01-03', state: CA, district: 12 }
- id:
    bioguide: R000002
    fec: [H0BB00002]
  name:
    first: Robert
    last: Smith
    official_full: Robert Smith
  terms:
    - { type: rep, start: '2015-01-03', end: '2027-01-03', state: TX, district: 4 }
```

> The two `Robert Smith` records share every alias form → a genuine collision the resolver
> must reject as ambiguous (this is what the current fixtureless code cannot test).

- [ ] **Step 2: Widen the test glob** in `package.json`.

Change:
```json
"test": "tsx --test pipeline/patterns/*.test.ts render/*.test.ts agents/*.test.ts",
```
to:
```json
"test": "tsx --test pipeline/patterns/*.test.ts render/*.test.ts agents/*.test.ts lib/*.test.ts",
```

- [ ] **Step 3: Write the failing test** `lib/legislators.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildIndex, buildAliasMap, normalizeName } from './legislators.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '__fixtures__', 'legislators-fixture.yaml');

test('buildIndex keys by bioguide and derives chamber/terms', () => {
  const idx = buildIndex([FIXTURE]);
  const s = idx.get('S000033');
  assert.ok(s, 'Sanders present');
  assert.equal(s!.chamber, 'Senate');          // last term type = sen
  assert.equal(s!.nickname, 'Bernie');
  assert.equal(s!.officialFull, 'Bernard Sanders');
  assert.deepEqual(s!.fec, ['H8VT01016', 'S4VT00033']);
  assert.equal(s!.termStart, '1991-01-03');      // first term start
  assert.equal(s!.termEnd, '2031-01-03');        // last term end
  assert.equal(s!.state, 'VT');
});

test('normalizeName lowercases, drops punctuation and single-letter initials', () => {
  assert.equal(normalizeName('Bernard I. Sanders'), 'bernard sanders');
  assert.equal(normalizeName('Sanders, Bernard'), 'sanders bernard');
  assert.equal(normalizeName('  Bernie   Sanders '), 'bernie sanders');
});

test('buildAliasMap yields nickname/official/comma forms → one bioguide', () => {
  const map = buildAliasMap(buildIndex([FIXTURE]));
  for (const alias of ['bernard sanders', 'bernie sanders', 'sanders bernard', 'sanders bernie']) {
    assert.deepEqual([...(map.get(alias) ?? [])], ['S000033'], `alias "${alias}"`);
  }
});

test('buildAliasMap records a genuine collision as two bioguides in one set', () => {
  const map = buildAliasMap(buildIndex([FIXTURE]));
  assert.deepEqual([...(map.get('robert smith') ?? [])].sort(), ['R000001', 'R000002']);
});

test('no surname-only alias is emitted', () => {
  const map = buildAliasMap(buildIndex([FIXTURE]));
  assert.equal(map.get('sanders'), undefined);
  assert.equal(map.get('smith'), undefined);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx tsx --test lib/legislators.test.ts`
Expected: FAIL — `buildIndex`/`buildAliasMap` not exported; `normalizeName` not exported;
`sanders` alias still present (last-only not yet removed).

- [ ] **Step 5: Refactor** `lib/legislators.ts`

Replace the current `getLegislatorIndex`, `generateAliasesFor`, `normalizeName`, `getAllAliases`
with this (identity interface and imports unchanged):

```ts
const DEFAULT_FILES = [
  join(LEGISLATORS_CACHE, 'legislators-historical.yaml'),
  join(LEGISLATORS_CACHE, 'legislators-current.yaml'),
];

/** Build a bioguide → identity index from the given YAML files, in order.
 *  Later files win on bioguide collision (pass historical before current). Pure. */
export function buildIndex(paths: string[]): Map<string, LegislatorIdentity> {
  const map = new Map<string, LegislatorIdentity>();
  for (const file of paths) {
    let data: any[];
    try { data = parseYaml(readFileSync(file, 'utf-8')) as any[]; }
    catch { continue; }  // one of current/historical may be absent
    for (const p of data ?? []) {
      const bio = p?.id?.bioguide;
      if (!bio) continue;
      const name = p.name ?? {};
      const terms: any[] = p.terms ?? [];
      const lastTerm = terms.at(-1) ?? {};
      const firstTerm = terms[0] ?? {};
      const chamber: 'House' | 'Senate' =
        String(lastTerm.type).toLowerCase().startsWith('sen') ? 'Senate' : 'House';
      map.set(bio, {
        bioguide: bio,
        officialFull: name.official_full ?? `${name.first ?? ''} ${name.last ?? ''}`.trim(),
        first: name.first ?? '',
        last: name.last ?? '',
        nickname: name.nickname ?? null,
        fec: Array.isArray(p.id?.fec) ? p.id.fec : [],
        chamber,
        state: lastTerm.state ?? '',
        district: lastTerm.district === undefined || lastTerm.district === null
          ? null : String(lastTerm.district),
        termStart: firstTerm.start ?? '',
        termEnd: lastTerm.end ?? '',
      });
    }
  }
  return map;
}

let identityIndex: Map<string, LegislatorIdentity> | null = null;
export function getLegislatorIndex(): Map<string, LegislatorIdentity> {
  if (!identityIndex) identityIndex = buildIndex(DEFAULT_FILES);
  return identityIndex;
}

/** Lowercase; commas/periods/quotes → spaces (handles "Last, First" and "F. Last");
 *  collapse whitespace; drop single-letter tokens (middle initials). */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,'"]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1)
    .join(' ')
    .trim();
}

/** All normalized alias forms for one legislator. No surname-only form (ambiguity hazard). */
export function generateAliasesFor(leg: LegislatorIdentity): string[] {
  const forms = new Set<string>();
  const add = (s: string) => { const n = normalizeName(s); if (n) forms.add(n); };
  if (leg.officialFull) add(leg.officialFull);
  if (leg.first && leg.last) { add(`${leg.first} ${leg.last}`); add(`${leg.last}, ${leg.first}`); }
  if (leg.nickname && leg.last) { add(`${leg.nickname} ${leg.last}`); add(`${leg.last}, ${leg.nickname}`); }
  return [...forms];
}

/** normalized alias → set of bioguides. A Set so collisions are detectable, not overwritten. Pure. */
export function buildAliasMap(index: Map<string, LegislatorIdentity>): Map<string, Set<string>> {
  const aliasMap = new Map<string, Set<string>>();
  for (const leg of index.values()) {
    for (const a of generateAliasesFor(leg)) {
      let set = aliasMap.get(a);
      if (!set) { set = new Set(); aliasMap.set(a, set); }
      set.add(leg.bioguide);
    }
  }
  return aliasMap;
}

let aliasCache: Map<string, Set<string>> | null = null;
export function getAllAliases(): Map<string, Set<string>> {
  if (!aliasCache) aliasCache = buildAliasMap(getLegislatorIndex());
  return aliasCache;
}
```

> Note: the old file loaded historical-then-current with "current wins" via last-write; the
> `map.set` order above preserves that (current is the second file). The old `normalizeName`
> kept initials and there was a `last`-only alias line — both removed here.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx tsx --test lib/legislators.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add lib/legislators.ts lib/legislators.test.ts lib/__fixtures__/legislators-fixture.yaml package.json
git commit -m "feat(identity): testable YAML index + normalization fix

Extract pure buildIndex/buildAliasMap; drop middle initials and the
surname-only alias; add fixture + tests.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Pure resolver core + slug preservation (`lib/resolve-member.ts`)

**Files:**
- Modify: `lib/resolve-member.ts`
- Create: `lib/resolve-member.test.ts`

**Interfaces:**
- Consumes: `getLegislatorIndex`, `getAllAliases`, `normalizeName`, `LegislatorIdentity` (`lib/legislators.ts`); `getDb` (`db/init.ts`).
- Produces:
  - `type ResolveResult = { ok: true; bioguide: string; slug: string } | { ok: false; reason: 'unresolved' } | { ok: false; reason: 'ambiguous'; candidates: string[] }` (unchanged).
  - `type IdentityResult = { ok: true; bioguide: string } | { ok: false; reason: 'unresolved' } | { ok: false; reason: 'ambiguous'; candidates: string[] }`
  - `function resolveIdentity(input: { name?: string; bioguide?: string }, index: Map<string, LegislatorIdentity>, aliasMap: Map<string, Set<string>>): IdentityResult` — pure.
  - `function deriveSlug(full: string): string` (kept, exported).
  - `function resolveMember(raw, opts?: { slugLookup?: (bioguide: string) => string | undefined }): Promise<ResolveResult>` — async; `opts.slugLookup` overrides the DB lookup (for tests).
- Removes: `seedAliasesForMember` (superseded by the standalone seeder in Task 3).

- [ ] **Step 1: Write the failing test** `lib/resolve-member.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildIndex, buildAliasMap } from './legislators.ts';
import { resolveIdentity, resolveMember, deriveSlug } from './resolve-member.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '__fixtures__', 'legislators-fixture.yaml');
const idx = buildIndex([FIXTURE]);
const aliases = buildAliasMap(idx);
const id = (raw: any) => resolveIdentity(raw, idx, aliases);

test('exact first-last resolves', () => {
  assert.deepEqual(id({ name: 'Bernard Sanders' }), { ok: true, bioguide: 'S000033' });
});
test('nickname resolves to the same person', () => {
  assert.deepEqual(id({ name: 'Bernie Sanders' }), { ok: true, bioguide: 'S000033' });
});
test('comma form resolves', () => {
  assert.deepEqual(id({ name: 'Sanders, Bernard' }), { ok: true, bioguide: 'S000033' });
});
test('middle initial is ignored', () => {
  assert.deepEqual(id({ name: 'Bernard I. Sanders' }), { ok: true, bioguide: 'S000033' });
});
test('raw bioguide short-circuits', () => {
  assert.deepEqual(id({ bioguide: 'R000001' }), { ok: true, bioguide: 'R000001' });
});
test('unknown name is unresolved, never guessed', () => {
  assert.deepEqual(id({ name: 'Nobody McNobody' }), { ok: false, reason: 'unresolved' });
});
test('a colliding alias is ambiguous, not first-match', () => {
  const r = id({ name: 'Robert Smith' });
  assert.equal(r.ok, false);
  assert.equal((r as any).reason, 'ambiguous');
  assert.deepEqual((r as any).candidates.sort(), ['R000001', 'R000002']);
});

test('resolveMember preserves an existing DB slug', async () => {
  const r = await resolveMember({ name: 'Bernard Sanders' }, {
    slugLookup: (bio) => (bio === 'S000033' ? 'bernie-sanders' : undefined),
  });
  assert.deepEqual(r, { ok: true, bioguide: 'S000033', slug: 'bernie-sanders' });
});
test('resolveMember derives first-last for a member with no DB row', async () => {
  const r = await resolveMember({ name: 'Robert Smith' }, { slugLookup: () => undefined });
  // ambiguous → still rejected before slug derivation
  assert.equal(r.ok, false);
});
test('deriveSlug is first-last, punctuation collapsed', () => {
  assert.equal(deriveSlug('Bernard Sanders'), 'bernard-sanders');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test lib/resolve-member.test.ts`
Expected: FAIL — `resolveIdentity`/`deriveSlug` not exported; `resolveMember` signature lacks `opts`.

- [ ] **Step 3: Refactor** `lib/resolve-member.ts`

Replace the file body with (imports adjusted — drop `generateAliasesFor`; keep `getLegislatorIndex`, `getAllAliases`, `normalizeName`, `getDb`):

```ts
import { getLegislatorIndex, getAllAliases, normalizeName, type LegislatorIdentity } from './legislators.js';
import { getDb } from '../db/init.js';

export type ResolveResult =
  | { ok: true; bioguide: string; slug: string }
  | { ok: false; reason: 'unresolved' }
  | { ok: false; reason: 'ambiguous'; candidates: string[] };

export type IdentityResult =
  | { ok: true; bioguide: string }
  | { ok: false; reason: 'unresolved' }
  | { ok: false; reason: 'ambiguous'; candidates: string[] };

/** Pure name/bioguide → bioguide. Exact only; >1 → ambiguous; 0 → unresolved. No guessing. */
export function resolveIdentity(
  input: { name?: string; bioguide?: string },
  index: Map<string, LegislatorIdentity>,
  aliasMap: Map<string, Set<string>>,
): IdentityResult {
  if (input.bioguide && index.has(input.bioguide)) {
    return { ok: true, bioguide: input.bioguide };
  }
  if (input.name) {
    const hits = aliasMap.get(normalizeName(input.name));
    if (hits && hits.size > 1) return { ok: false, reason: 'ambiguous', candidates: [...hits] };
    if (hits && hits.size === 1) return { ok: true, bioguide: [...hits][0] };
  }
  return { ok: false, reason: 'unresolved' };
}

export function deriveSlug(full: string): string {
  return full
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const slugCache = new Map<string, string>();

async function dbSlugLookup(bioguide: string): Promise<string | undefined> {
  try {
    const conn = await getDb();
    const row = await conn.run(`SELECT member_id FROM members WHERE bioguide_id = ? LIMIT 1`, [bioguide]);
    const rows = await row.getRowObjects();
    if (rows.length > 0) return String((rows[0] as any).member_id);
  } catch { /* DB not ready — derive instead */ }
  return undefined;
}

/** Resolve a raw name/bioguide to {bioguide, slug}. Slug prefers the existing DB member_id
 *  (never rename bernie-sanders); derives first-last only for a brand-new member.
 *  `opts.slugLookup` overrides the DB lookup for deterministic tests. */
export async function resolveMember(
  raw: string | { name?: string; bioguide?: string },
  opts?: { slugLookup?: (bioguide: string) => string | undefined },
): Promise<ResolveResult> {
  const input = typeof raw === 'string' ? { name: raw } : raw;
  const ident = resolveIdentity(input, getLegislatorIndex(), getAllAliases());
  if (!ident.ok) return ident;

  const bio = ident.bioguide;
  let slug = slugCache.get(bio);
  if (!slug) {
    slug = opts?.slugLookup ? opts.slugLookup(bio) : await dbSlugLookup(bio);
  }
  if (!slug) {
    const leg = getLegislatorIndex().get(bio)!;
    slug = deriveSlug(leg.officialFull || `${leg.first} ${leg.last}`);
  }
  slugCache.set(bio, slug);
  return { ok: true, bioguide: bio, slug };
}
```

> `seedAliasesForMember` is intentionally removed. Task 3 reverts its only caller.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test lib/resolve-member.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Run the whole lib suite**

Run: `npx tsx --test lib/*.test.ts`
Expected: PASS (all lib tests green).

- [ ] **Step 6: Commit**

```bash
git add lib/resolve-member.ts lib/resolve-member.test.ts
git commit -m "feat(identity): pure resolver core + injectable slug lookup

resolveIdentity is pure/testable; resolveMember preserves the existing DB
slug and derives first-last only for new members. Drop seedAliasesForMember.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Bioguide-keyed alias table + standalone seeder (`db/schema.sql`, `db/load-member-aliases.ts`, `db/load-from-tasks.ts`)

**Files:**
- Modify: `db/schema.sql` (re-key `member_aliases`)
- Create: `db/load-member-aliases.ts`
- Modify: `db/load-from-tasks.ts` (revert the `seedAliasesForMember` hook)

**Interfaces:**
- Consumes: `getLegislatorIndex`, `getAllAliases` (`lib/legislators.ts`); `getDb`, `applySchema` (`db/init.ts`).
- Produces: `member_aliases(alias_norm TEXT, bioguide_id TEXT, PK(alias_norm,bioguide_id))`; a `main()` CLI seeder.

- [ ] **Step 1: Re-key `member_aliases` in** `db/schema.sql`

Replace the current `member_aliases` block (the one with `member_id`, `source`, `created_at`,
FK, and `idx_member_aliases_member`) with:

```sql
-- ─── Member aliases (deterministic projection of the resolver, from YAML) ─────
-- Normalized name variants → bioguide (identity keyed on identity). A given
-- alias_norm may appear against >1 bioguide: that row-level duplication IS the
-- ambiguity signal. member_id is reachable via JOIN members USING (bioguide_id).
DROP TABLE IF EXISTS member_aliases;
CREATE TABLE IF NOT EXISTS member_aliases (
  alias_norm   TEXT NOT NULL,
  bioguide_id  TEXT NOT NULL,
  PRIMARY KEY (alias_norm, bioguide_id)
);
```

Leave the `ALTER TABLE members ADD COLUMN IF NOT EXISTS term_start/term_end` and
`CREATE UNIQUE INDEX IF NOT EXISTS idx_members_bioguide_id` lines as they are.

> `DROP TABLE IF EXISTS` is safe: the live table is empty (0 rows, verified).

- [ ] **Step 2: Apply the schema and confirm the re-keyed table**

Run:
```bash
npx tsx -e "import {applySchema,getDb} from './db/init.ts'; (async()=>{ await applySchema(); const c=await getDb(); const r=await c.run(\"SELECT column_name FROM information_schema.columns WHERE table_name='member_aliases' ORDER BY 1\"); console.log('cols:', JSON.stringify(await r.getRows())); process.exit(0); })();"
```
Expected: `cols: [["alias_norm"],["bioguide_id"]]` (no `member_id`/`source`/`created_at`).

- [ ] **Step 3: Implement the seeder** `db/load-member-aliases.ts`

```ts
import { getDb, applySchema } from './init.js';
import { getLegislatorIndex, getAllAliases } from '../lib/legislators.js';

async function main() {
  await applySchema();
  const conn = await getDb();
  const index = getLegislatorIndex();
  const aliasMap = getAllAliases();

  // 1. Seed the full alias projection (DELETE-then-insert, idempotent).
  await conn.run('DELETE FROM member_aliases');
  let rows = 0;
  for (const [alias, bios] of aliasMap) {
    for (const bio of bios) {
      await conn.run('INSERT INTO member_aliases VALUES (?, ?)', [alias, bio]);
      rows++;
    }
  }
  console.log(`seeded ${rows} alias rows across ${aliasMap.size} distinct names`);

  // 2. Backfill members: bioguide-derived term_start/end, chamber, state, district.
  //    Keyed by the member row's existing bioguide_id (already 57/57 populated).
  //    Does NOT touch member_id (slug) — preservation is the resolver's job.
  const mrows = (await (await conn.run(
    'SELECT member_id, bioguide_id FROM members WHERE bioguide_id IS NOT NULL',
  )).getRowObjects()) as Array<{ member_id: string; bioguide_id: string }>;

  // Fail-loud: a duplicate bioguide would violate one-person-one-row.
  const seen = new Map<string, string>();
  for (const m of mrows) {
    const prev = seen.get(m.bioguide_id);
    if (prev) {
      console.error(`ABORT: duplicate bioguide ${m.bioguide_id} on member rows "${prev}" and "${m.member_id}". Identity is not 1:1 — refusing to backfill.`);
      process.exit(1);
    }
    seen.set(m.bioguide_id, m.member_id);
  }

  let filled = 0;
  for (const m of mrows) {
    const leg = index.get(m.bioguide_id);
    if (!leg) { console.warn(`no YAML identity for bioguide ${m.bioguide_id} (${m.member_id})`); continue; }
    await conn.run(
      `UPDATE members SET term_start = ?, term_end = ?, chamber = ?, state = ?, district = ? WHERE member_id = ?`,
      [leg.termStart || null, leg.termEnd || null, leg.chamber, leg.state || null, leg.district, m.member_id],
    );
    filled++;
  }
  console.log(`backfilled ${filled} member rows from YAML`);
  process.exit(0);
}

main();
```

- [ ] **Step 4: Revert the per-member alias hook in** `db/load-from-tasks.ts`

Remove the import line:
```ts
import { seedAliasesForMember } from '../lib/resolve-member.js';
```
and remove the block:
```ts
  // Seed deterministic aliases from YAML for this bioguide (idempotent)
  if (d.bioguideId) {
    try {
      await seedAliasesForMember(memberId, d.bioguideId);
    } catch (e) {
      // non-fatal during load
    }
  }
```

- [ ] **Step 5: Back up the DB, then run the seeder**

Run:
```bash
cp data/civiclens.duckdb data/civiclens.duckdb.bak-pre-identity && npx tsx db/load-member-aliases.ts
```
Expected: `seeded <N> alias rows across <M> distinct names`, then `backfilled 57 member rows from YAML`. No `ABORT`.

- [ ] **Step 6: Verify the projection + that ambiguity is queryable**

Run:
```bash
npx tsx -e "import {getDb} from './db/init.ts'; (async()=>{ const c=await getDb(); const n=async(q,l)=>{const r=await c.run(q);console.log(l,JSON.stringify((await r.getRows()).map(x=>x.map(v=>typeof v==='bigint'?Number(v):v))));}; await n('SELECT COUNT(*) FROM member_aliases','alias_rows:'); await n(\"SELECT bioguide_id FROM member_aliases WHERE alias_norm='bernie sanders'\",'bernie->:'); await n('SELECT COUNT(*) FROM (SELECT alias_norm FROM member_aliases GROUP BY 1 HAVING COUNT(*)>1)','ambiguous_names:'); process.exit(0); })();"
```
Expected: `alias_rows:` > 0; `bernie->: [["S000033"]]`; `ambiguous_names:` a number (collisions across all of Congress are now inspectable — this is the substrate's payoff).

- [ ] **Step 7: Commit**

```bash
git add db/schema.sql db/load-member-aliases.ts db/load-from-tasks.ts
git commit -m "feat(identity): bioguide-keyed alias seeder + members backfill

Re-key member_aliases on bioguide_id; standalone full-YAML projection with
a fail-loud dup-bioguide assert; backfill term/chamber/state/district.
Revert superseded per-member seedAliasesForMember hook.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Thread the resolved slug (`skills/researcher/fetch.ts`, `agents/researcher.ts`)

**Files:**
- Modify: `skills/researcher/fetch.ts` (`LiveFetchResult` + `fetchPolitician`)
- Modify: `agents/researcher.ts` (consume typed `resolvedSlug`)

**Interfaces:**
- Consumes: `resolveMember` result (`resolved.slug`).
- Produces: `LiveFetchResult.resolvedSlug: string`; researcher uses it as the member `id`.

This is the bug fix: `resolvedSlug` is read by `researcher.ts` but never set, so slug
preservation currently never takes effect.

- [ ] **Step 1: Add `resolvedSlug` to `LiveFetchResult`** in `skills/researcher/fetch.ts`
(inside the interface at ~line 713, e.g. right after `bioguideId`):

```ts
  resolvedSlug: string;
```

- [ ] **Step 2: Capture the slug** in `fetchPolitician`. After:

```ts
  const bioguideId = resolved.bioguide;
```

add:

```ts
  const resolvedSlug = resolved.slug;
```

- [ ] **Step 3: Return it.** In the final `return { ... }` object (~line 903), add `resolvedSlug`
next to `bioguideId`:

```ts
    bioguideId,
    resolvedSlug,
```

- [ ] **Step 4: Consume it typed** in `agents/researcher.ts`. Replace:

```ts
  const id = (live as any).resolvedSlug ??
    name.toLowerCase()
      .replace(/['']/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
```

with:

```ts
  // Deterministic resolver owns the slug (preserves existing DB member_id).
  const id = live.resolvedSlug;
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors in `fetch.ts` / `researcher.ts` (`resolvedSlug` now typed on the result).

- [ ] **Step 6: Smoke test the seam** (resolve a known + unknown name)

Run:
```bash
npx tsx -e "import {resolveMember} from './lib/resolve-member.ts'; (async()=>{ console.log(await resolveMember('Bernie Sanders')); console.log(await resolveMember('Ghost McNobody')); process.exit(0); })();"
```
Expected: first `{ ok: true, bioguide: 'S000033', slug: 'bernie-sanders' }` (slug preserved from
the live DB row); second `{ ok: false, reason: 'unresolved' }`.

- [ ] **Step 7: Commit**

```bash
git add skills/researcher/fetch.ts agents/researcher.ts
git commit -m "fix(researcher): thread resolved slug so preservation takes effect

resolvedSlug was read but never set; type it on LiveFetchResult, set it from
resolveMember, and use it as the member id (no more raw re-slugify).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Full-suite + end-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS, including the new `lib/*.test.ts`.

- [ ] **Step 2: Confirm bernie-sanders is preserved end-to-end**

Run:
```bash
npx tsx -e "import {getDb} from './db/init.ts'; import {resolveMember} from './lib/resolve-member.ts'; (async()=>{ const r=await resolveMember('Bernard Sanders'); console.log('resolve:', r); const c=await getDb(); const q=await c.run(\"SELECT member_id, bioguide_id FROM members WHERE member_id ILIKE '%sanders%'\"); console.log('rows:', JSON.stringify(await q.getRows())); process.exit(0); })();"
```
Expected: `resolve:` slug `bernie-sanders`; exactly one `sanders` row `["bernie-sanders","S000033"]` (no rename, no dup).

- [ ] **Step 3: Confirm no duplicate bioguides remain**

Run:
```bash
npx tsx -e "import {getDb} from './db/init.ts'; (async()=>{ const c=await getDb(); const r=await c.run('SELECT bioguide_id, COUNT(*) n FROM members WHERE bioguide_id IS NOT NULL GROUP BY 1 HAVING n>1'); console.log('dup bioguides:', JSON.stringify(await r.getRows())); process.exit(0); })();"
```
Expected: `dup bioguides: []`.

- [ ] **Step 4: No commit** (verification-only). If any step fails, fix in the owning task and
re-run.

---

## Self-Review

**Spec coverage (reconciled):**
- Deterministic offline index → Task 1 (`buildIndex`). ✓
- Alias generation, drop-initials normalization, no surname-only → Task 1. ✓
- Ambiguity-rejecting pure resolver → Task 2 (`resolveIdentity`). ✓
- Slug preservation (existing DB slug wins, derive for new) → Task 2 (`resolveMember`). ✓
- `member_aliases` keyed on bioguide + full-YAML seeder + backfill + dup assert → Task 3. ✓
- `bioguide_id UNIQUE` immediate (verified clean) → schema unchanged, asserted in Task 3. ✓
- Slug-threading bug fix (the real defect) → Task 4. ✓
- End-to-end determinism + preservation + no dups → Task 5. ✓

**Placeholder scan:** every code step carries complete code; no TBD/TODO.

**Type consistency:** `LegislatorIdentity`, `ResolveResult`, `IdentityResult`, `buildIndex`,
`buildAliasMap`, `normalizeName`, `resolveIdentity`, `resolveMember`, `deriveSlug`,
`resolvedSlug`, and the `member_aliases(alias_norm, bioguide_id)` columns are consistent across
Tasks 1→5.
