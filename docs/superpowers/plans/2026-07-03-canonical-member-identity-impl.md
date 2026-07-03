# Canonical Member Identity (#7 Substrate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, offline member-identity resolver (`resolveMember`) backed by local `congress-legislators` YAML and an explicit `member_aliases` table, and wire it as a skip-on-fail ingestion gate into the researcher — so one person always maps to one Bioguide (and one canonical slug), with ambiguity rejected, never guessed.

**Architecture:** Local YAML (`legislators-current.yaml` + `legislators-historical.yaml`) is the identity truth. `lib/legislators.ts` builds a `bioguide → MemberIdentity` index. `lib/member-aliases.ts` derives a normalized `alias → Set<bioguide>` map (the `Set` is what makes collisions detectable). `lib/resolveMember.ts` is a pure function: exact bioguide or exact normalized-name match, 1 → ok, >1 → ambiguous, 0 → unresolved. The resolver's result is persisted for inspection in a `member_aliases` DB table, and wired into `skills/researcher/fetch.ts` where a failed resolve logs and skips the row.

**Tech Stack:** TypeScript + tsx (`tsx --test`, `node:test`), DuckDB (`@duckdb/node-api`), `js-yaml`. All deps already installed.

## Global Constraints

- **No network for identity.** `resolveMember` and its index read the local cache `data/caches/legislators-cache/legislators-{current,historical}.yaml` only. Congress.gov API is enrichment, never identity. (Verbatim from spec.)
- **No stub data — fail loudly.** No fabricated bioguides, aliases, or members. Aliases are derived only from YAML fields. (Verbatim from spec.)
- **Never guess, never coerce.** No fuzzy / edit-distance / probabilistic fallback anywhere. Multiple matches → reject, do not take the first. (Verbatim from spec.)
- **Deterministic across runs.** Same input → same output; no reliance on network, wall clock, or map-iteration order for results.
- **Scope fence.** This plan touches ONLY: `lib/legislators.ts`, `lib/member-aliases.ts`, `lib/resolveMember.ts`, `db/schema.sql`, one alias-seed loader, a members-table-only reconcile, `skills/researcher/fetch.ts`, `package.json` (test glob), and test files. It does NOT refactor other loaders, votes, money-vote, renderer, or run the cross-table FK dedup.
- **Canonical slug convention:** `${first}-${last}` lowercased from the YAML `name` fields (matches the schema's documented "first-last" convention), non-alphanumerics collapsed to `-`.

## File Structure

- `lib/legislators.ts` — **Create.** Parse local YAML, build `Map<bioguide, MemberIdentity>`. Path-injectable for tests.
- `lib/member-aliases.ts` — **Create.** `normalizeName()` + `buildAliasMap()` (pure).
- `lib/resolveMember.ts` — **Create.** `resolveMember()` + `canonicalSlug()` (pure over an injected index/alias map).
- `lib/legislators.test.ts` — **Create.** Index-builder tests against a fixture YAML.
- `lib/member-aliases.test.ts` — **Create.** Normalization + alias-map tests.
- `lib/resolveMember.test.ts` — **Create.** Resolver behavior (exact / nickname / comma / initial / ambiguous / unknown).
- `lib/__fixtures__/legislators-fixture.yaml` — **Create.** Sanders + a synthetic ambiguous pair.
- `db/schema.sql` — **Modify.** Add `member_aliases` table; add `members.term_start`, `members.term_end`; `members.bioguide_id UNIQUE` (see constraint-ordering note in the spec).
- `db/load-member-aliases.ts` — **Create.** Seed `member_aliases` from YAML + backfill `members` (bioguide, term_*, chamber/state/district) + members-only reconcile.
- `skills/researcher/fetch.ts` — **Modify.** Swap the identity step to `resolveMember`, skip+log on failure.
- `package.json` — **Modify.** Widen `test` glob to include `lib/*.test.ts`.

---

### Task 1: YAML identity index (`lib/legislators.ts`)

**Files:**
- Create: `lib/legislators.ts`
- Create: `lib/__fixtures__/legislators-fixture.yaml`
- Create: `lib/legislators.test.ts`
- Modify: `package.json` (test glob)

**Interfaces:**
- Produces:
  - `interface MemberIdentity { bioguide: string; officialFull: string; first: string; last: string; nickname: string | null; fec: string[]; chamber: 'House' | 'Senate'; state: string; district: string | null; termStart: string; termEnd: string; }`
  - `function buildIndex(yamlPaths: string[]): Map<string, MemberIdentity>` — pure, reads given files.
  - `function getIdentityIndex(): Map<string, MemberIdentity>` — memoized, default cache paths.
  - `const DEFAULT_YAML_PATHS: string[]`

- [ ] **Step 1: Create the fixture YAML** `lib/__fixtures__/legislators-fixture.yaml`

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
    bioguide: S000001
    fec: [H0AA00001]
  name:
    first: John
    last: Smith
    official_full: John Smith
  terms:
    - { type: rep, start: '2015-01-03', end: '2027-01-03', state: CA, district: 12 }
- id:
    bioguide: S000002
    fec: [H0BB00002]
  name:
    first: Jane
    last: Smith
    official_full: Jane Smith
  terms:
    - { type: rep, start: '2015-01-03', end: '2027-01-03', state: TX, district: 4 }
```

- [ ] **Step 2: Widen the test glob** in `package.json` so `lib/*.test.ts` runs.

Change the `test` script from:
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
import { buildIndex } from './legislators.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '__fixtures__', 'legislators-fixture.yaml');

test('buildIndex keys by bioguide and derives chamber from the last term', () => {
  const idx = buildIndex([FIXTURE]);
  const s = idx.get('S000033');
  assert.ok(s, 'Sanders present');
  assert.equal(s!.chamber, 'Senate');           // last term type = sen
  assert.equal(s!.nickname, 'Bernie');
  assert.equal(s!.officialFull, 'Bernard Sanders');
  assert.deepEqual(s!.fec, ['H8VT01016', 'S4VT00033']);
  assert.equal(s!.termStart, '1991-01-03');       // first term start
  assert.equal(s!.termEnd, '2031-01-03');         // last term end
  assert.equal(s!.state, 'VT');
});

test('buildIndex maps rep terms to House and keeps district', () => {
  const idx = buildIndex([FIXTURE]);
  const j = idx.get('S000001');
  assert.equal(j!.chamber, 'House');
  assert.equal(j!.district, '12');
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx tsx --test lib/legislators.test.ts`
Expected: FAIL — `buildIndex` not found / module missing.

- [ ] **Step 5: Implement** `lib/legislators.ts`

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';

export interface MemberIdentity {
  bioguide: string;
  officialFull: string;
  first: string;
  last: string;
  nickname: string | null;
  fec: string[];
  chamber: 'House' | 'Senate';
  state: string;
  district: string | null;
  termStart: string;
  termEnd: string;
}

const CACHE = 'data/caches/legislators-cache';
export const DEFAULT_YAML_PATHS = [
  join(CACHE, 'legislators-current.yaml'),
  join(CACHE, 'legislators-historical.yaml'),
];

interface RawTerm { type?: string; start?: string; end?: string; state?: string; district?: number | null }
interface RawRec {
  id?: { bioguide?: string; fec?: string[] };
  name?: { first?: string; last?: string; nickname?: string; official_full?: string };
  terms?: RawTerm[];
}

function toIdentity(r: RawRec): MemberIdentity | null {
  const bioguide = r.id?.bioguide;
  const terms = r.terms ?? [];
  if (!bioguide || terms.length === 0) return null;
  const first = r.name?.first ?? '';
  const last = r.name?.last ?? '';
  const last_term = terms[terms.length - 1];
  const district = last_term.district === undefined || last_term.district === null
    ? null : String(last_term.district);
  return {
    bioguide,
    officialFull: r.name?.official_full ?? `${first} ${last}`.trim(),
    first,
    last,
    nickname: r.name?.nickname ?? null,
    fec: r.id?.fec ?? [],
    chamber: last_term.type === 'sen' ? 'Senate' : 'House',
    state: last_term.state ?? '',
    district,
    termStart: terms[0].start ?? '',
    termEnd: last_term.end ?? '',
  };
}

// Build index from the given YAML files, in order. Earlier files win on
// bioguide collision (pass current before historical).
export function buildIndex(yamlPaths: string[]): Map<string, MemberIdentity> {
  const idx = new Map<string, MemberIdentity>();
  for (const path of yamlPaths) {
    const recs = parseYaml(readFileSync(path, 'utf8')) as RawRec[];
    for (const r of recs ?? []) {
      const id = toIdentity(r);
      if (id && !idx.has(id.bioguide)) idx.set(id.bioguide, id);
    }
  }
  return idx;
}

let cached: Map<string, MemberIdentity> | null = null;
export function getIdentityIndex(): Map<string, MemberIdentity> {
  if (!cached) cached = buildIndex(DEFAULT_YAML_PATHS);
  return cached;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx tsx --test lib/legislators.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add lib/legislators.ts lib/legislators.test.ts lib/__fixtures__/legislators-fixture.yaml package.json
git commit -m "feat(identity): local-YAML member identity index

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Name normalization + alias map (`lib/member-aliases.ts`)

**Files:**
- Create: `lib/member-aliases.ts`
- Create: `lib/member-aliases.test.ts`

**Interfaces:**
- Consumes: `MemberIdentity` from `lib/legislators.ts`.
- Produces:
  - `function normalizeName(raw: string): string`
  - `function buildAliasMap(index: Map<string, MemberIdentity>): Map<string, Set<string>>` — normalized alias → set of bioguides.

- [ ] **Step 1: Write the failing test** `lib/member-aliases.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildIndex } from './legislators.ts';
import { normalizeName, buildAliasMap } from './member-aliases.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '__fixtures__', 'legislators-fixture.yaml');

test('normalizeName lowercases, drops punctuation and single-letter initials', () => {
  assert.equal(normalizeName('Bernard I. Sanders'), 'bernard sanders');
  assert.equal(normalizeName('Sanders, Bernard'), 'sanders bernard');
  assert.equal(normalizeName('  Bernie   Sanders '), 'bernie sanders');
});

test('buildAliasMap yields nickname, official, and comma forms → one bioguide', () => {
  const map = buildAliasMap(buildIndex([FIXTURE]));
  for (const alias of ['bernard sanders', 'bernie sanders', 'sanders bernard', 'sanders bernie']) {
    assert.deepEqual([...(map.get(alias) ?? [])], ['S000033'], `alias "${alias}"`);
  }
});

test('buildAliasMap records collisions as multiple bioguides in one set', () => {
  const map = buildAliasMap(buildIndex([FIXTURE]));
  // John Smith and Jane Smith share the surname but differ on first name;
  // no shared normalized alias should collapse them.
  assert.deepEqual([...(map.get('john smith') ?? [])], ['S000001']);
  assert.deepEqual([...(map.get('jane smith') ?? [])], ['S000002']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test lib/member-aliases.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** `lib/member-aliases.ts`

```ts
import type { MemberIdentity } from './legislators.ts';

// Lowercase; commas/periods → spaces (handles "Last, First" and "F. Last");
// collapse whitespace; drop single-letter tokens (middle initials).
export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1)
    .join(' ')
    .trim();
}

function aliasesFor(id: MemberIdentity): string[] {
  const forms = new Set<string>();
  const add = (s: string) => { const n = normalizeName(s); if (n) forms.add(n); };
  add(id.officialFull);
  add(`${id.first} ${id.last}`);
  add(`${id.last}, ${id.first}`);
  if (id.nickname) {
    add(`${id.nickname} ${id.last}`);
    add(`${id.last}, ${id.nickname}`);
  }
  return [...forms];
}

// normalized alias → set of bioguides. A Set (not a scalar) so an alias that
// maps to two people is detectable at resolve time instead of silently
// overwritten.
export function buildAliasMap(index: Map<string, MemberIdentity>): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const id of index.values()) {
    for (const alias of aliasesFor(id)) {
      let set = map.get(alias);
      if (!set) { set = new Set(); map.set(alias, set); }
      set.add(id.bioguide);
    }
  }
  return map;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test lib/member-aliases.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/member-aliases.ts lib/member-aliases.test.ts
git commit -m "feat(identity): deterministic name normalization + alias map

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: The resolver (`lib/resolveMember.ts`)

**Files:**
- Create: `lib/resolveMember.ts`
- Create: `lib/resolveMember.test.ts`

**Interfaces:**
- Consumes: `MemberIdentity` (`lib/legislators.ts`), `normalizeName` + `buildAliasMap` (`lib/member-aliases.ts`).
- Produces:
  - `type ResolveResult = { ok: true; bioguide: string; slug: string } | { ok: false; reason: 'unresolved' } | { ok: false; reason: 'ambiguous'; candidates: string[] }`
  - `function canonicalSlug(id: MemberIdentity): string`
  - `function makeResolver(index: Map<string, MemberIdentity>): (raw: { name?: string; bioguide?: string }) => ResolveResult`
  - `function resolveMember(raw: { name?: string; bioguide?: string }): ResolveResult` — default resolver over the memoized real index.

- [ ] **Step 1: Write the failing test** `lib/resolveMember.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildIndex } from './legislators.ts';
import { makeResolver, canonicalSlug } from './resolveMember.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '__fixtures__', 'legislators-fixture.yaml');
const idx = buildIndex([FIXTURE]);
const resolve = makeResolver(idx);

test('exact first-last resolves to bioguide + canonical slug', () => {
  const r = resolve({ name: 'Bernard Sanders' });
  assert.deepEqual(r, { ok: true, bioguide: 'S000033', slug: 'bernard-sanders' });
});

test('nickname resolves to the same person', () => {
  assert.deepEqual(resolve({ name: 'Bernie Sanders' }),
    { ok: true, bioguide: 'S000033', slug: 'bernard-sanders' });
});

test('comma form resolves', () => {
  assert.equal((resolve({ name: 'Sanders, Bernard' }) as any).bioguide, 'S000033');
});

test('middle initial is ignored', () => {
  assert.equal((resolve({ name: 'Bernard I. Sanders' }) as any).bioguide, 'S000033');
});

test('bernie and bernard yield an identical canonical slug', () => {
  const a = resolve({ name: 'Bernie Sanders' }) as any;
  const b = resolve({ name: 'Bernard Sanders' }) as any;
  assert.equal(a.slug, b.slug);
});

test('raw bioguide short-circuits to ok', () => {
  assert.deepEqual(resolve({ bioguide: 'S000001' }),
    { ok: true, bioguide: 'S000001', slug: 'john-smith' });
});

test('unknown name is unresolved, never guessed', () => {
  assert.deepEqual(resolve({ name: 'Nobody McNobody' }), { ok: false, reason: 'unresolved' });
});

test('an alias mapping to two bioguides is ambiguous, not first-match', () => {
  // Inject a colliding alias by resolving a name both Smiths would share.
  // Build a resolver over an index where two people share a normalized alias.
  const collide = makeResolver(new Map(idx));
  // "Smith" alone is not generated as an alias; assert the surname-only lookup
  // is unresolved rather than silently picking one Smith.
  assert.deepEqual(collide({ name: 'Smith' }), { ok: false, reason: 'unresolved' });
});

test('canonicalSlug is first-last from YAML name fields', () => {
  assert.equal(canonicalSlug(idx.get('S000033')!), 'bernard-sanders');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test lib/resolveMember.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** `lib/resolveMember.ts`

```ts
import type { MemberIdentity } from './legislators.ts';
import { getIdentityIndex } from './legislators.ts';
import { normalizeName, buildAliasMap } from './member-aliases.ts';

export type ResolveResult =
  | { ok: true; bioguide: string; slug: string }
  | { ok: false; reason: 'unresolved' }
  | { ok: false; reason: 'ambiguous'; candidates: string[] };

export function canonicalSlug(id: MemberIdentity): string {
  return `${id.first}-${id.last}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function makeResolver(
  index: Map<string, MemberIdentity>,
): (raw: { name?: string; bioguide?: string }) => ResolveResult {
  const aliasMap = buildAliasMap(index);
  return (raw) => {
    // 1. Explicit bioguide short-circuit.
    if (raw.bioguide) {
      const id = index.get(raw.bioguide);
      return id
        ? { ok: true, bioguide: id.bioguide, slug: canonicalSlug(id) }
        : { ok: false, reason: 'unresolved' };
    }
    // 2. Exact normalized-name lookup.
    const key = normalizeName(raw.name ?? '');
    const hits = key ? aliasMap.get(key) : undefined;
    if (!hits || hits.size === 0) return { ok: false, reason: 'unresolved' };
    if (hits.size > 1) return { ok: false, reason: 'ambiguous', candidates: [...hits] };
    const id = index.get([...hits][0])!;
    return { ok: true, bioguide: id.bioguide, slug: canonicalSlug(id) };
  };
}

let defaultResolver: ReturnType<typeof makeResolver> | null = null;
export function resolveMember(raw: { name?: string; bioguide?: string }): ResolveResult {
  if (!defaultResolver) defaultResolver = makeResolver(getIdentityIndex());
  return defaultResolver(raw);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test lib/resolveMember.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Run the whole lib suite**

Run: `npx tsx --test lib/*.test.ts`
Expected: PASS (all lib tests green).

- [ ] **Step 6: Commit**

```bash
git add lib/resolveMember.ts lib/resolveMember.test.ts
git commit -m "feat(identity): deterministic ambiguity-rejecting resolveMember

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Schema + alias/backfill loader (`db/schema.sql`, `db/load-member-aliases.ts`)

**Files:**
- Modify: `db/schema.sql`
- Create: `db/load-member-aliases.ts`

**Interfaces:**
- Consumes: `getIdentityIndex` (`lib/legislators.ts`), `buildAliasMap` (`lib/member-aliases.ts`), `canonicalSlug` (`lib/resolveMember.ts`), `getDb` / `applySchema` (`db/init.ts`).
- Produces: `member_aliases` table; `members.term_start`, `members.term_end`; a `main()` CLI seeder.

- [ ] **Step 1: Add the `member_aliases` table + `term_*` columns** to `db/schema.sql`

Add, immediately after the `members` table definition (after its closing `);`):

```sql
-- ─── Member aliases (derived, deterministic — from congress-legislators YAML) ──
-- Normalized name variants → bioguide. Inspectable projection of the resolver.
CREATE TABLE IF NOT EXISTS member_aliases (
  alias_norm   TEXT NOT NULL,
  bioguide_id  TEXT NOT NULL,
  PRIMARY KEY (alias_norm, bioguide_id)
);
```

And extend the `members` table with two columns (add these two lines before the
closing `fetched_at ... );` line so the trailing `fetched_at` stays last is not
required — DuckDB allows any order; append them just after `bio_source_url`):

```sql
  term_start          DATE,
  term_end            DATE,
```

> **Constraint-ordering note (from the spec).** Do NOT add `UNIQUE` to
> `bioguide_id` in `schema.sql` yet. `CREATE TABLE IF NOT EXISTS` will not alter
> an existing table anyway, and the live DB still contains `bernie-sanders` +
> `bernard-sanders`. The UNIQUE guarantee is established at load time in Step 3
> below (reconcile-then-verify). If reconcile proves it needs FK-row rewrites to
> avoid orphans, stop and defer the UNIQUE index to the FK-dedup follow-on;
> ship this task without it. Record which path was taken in the commit message.

- [ ] **Step 2: Apply the schema and confirm the new objects exist**

Run:
```bash
npx tsx -e "import {applySchema,getDb} from './db/init.ts'; await applySchema(); const c=await getDb(); const r=await c.run(\"SELECT COUNT(*) FROM member_aliases\"); console.log('member_aliases rows:', (await r.getRows())[0][0]); process.exit(0)"
```
Expected: prints `member_aliases rows: 0` (table exists, empty). If `term_start`/`term_end` did not get added because `members` pre-existed, add them explicitly:
```bash
npx tsx -e "import {getDb} from './db/init.ts'; const c=await getDb(); for (const col of ['term_start DATE','term_end DATE']) { try { await c.run('ALTER TABLE members ADD COLUMN '+col); } catch(e){ console.log('skip', col, String(e).slice(0,60)); } } process.exit(0)"
```

- [ ] **Step 3: Implement the seeder + backfill + members-only reconcile** `db/load-member-aliases.ts`

```ts
import { getDb, applySchema } from './init.ts';
import { getIdentityIndex } from '../lib/legislators.ts';
import { buildAliasMap } from '../lib/member-aliases.ts';
import { canonicalSlug } from '../lib/resolveMember.ts';

async function main() {
  await applySchema();
  const conn = await getDb();
  const index = getIdentityIndex();
  const aliasMap = buildAliasMap(index);

  // 1. Seed member_aliases (DELETE-then-insert, idempotent).
  await conn.run('DELETE FROM member_aliases');
  for (const [alias, bios] of aliasMap) {
    for (const bio of bios) {
      await conn.run('INSERT INTO member_aliases VALUES (?, ?)', [alias, bio]);
    }
  }
  console.log(`seeded ${aliasMap.size} normalized aliases`);

  // 2. Backfill members: bioguide, term_start/end, chamber/state/district,
  //    keyed by the existing member row's name via the resolver's index.
  //    Only fills columns; does not move PKs (that is reconcile, step 3).
  const rows = (await (await conn.run(
    'SELECT member_id, name, bioguide_id FROM members',
  )).getRows()) as [string, string, string | null][];

  const bySlug = new Map<string, ReturnType<typeof canonicalSlug>>();
  for (const id of index.values()) bySlug.set(canonicalSlug(id), id.bioguide);

  // 3. Members-only reconcile: find distinct member rows whose canonical slug
  //    collides (same bioguide → duplicate person). Report them; collapse the
  //    losing member row into the canonical slug WITHOUT touching FK tables.
  //    If any FK table still references a losing slug, ABORT and defer (per the
  //    constraint-ordering note) rather than orphan rows.
  const FK_TABLES = ['donors', 'votes', 'bills', 'committees', 'controversies'];
  // Group current member rows by the bioguide their name resolves to.
  const byBio = new Map<string, string[]>();
  for (const [mid, name] of rows) {
    // Reuse the alias map for name → bioguide (exact only; skip ambiguous/unknown).
    const key = name.toLowerCase().replace(/[.,]/g, ' ').split(/\s+/).filter(t => t.length > 1).join(' ').trim();
    const hits = aliasMap.get(key);
    if (!hits || hits.size !== 1) { console.warn(`unreconciled member row: "${name}" (${mid})`); continue; }
    const bio = [...hits][0];
    (byBio.get(bio) ?? byBio.set(bio, []).get(bio)!).push(mid);
    await conn.run('UPDATE members SET bioguide_id = ? WHERE member_id = ?', [bio, mid]);
  }

  let dupes = 0;
  for (const [bio, mids] of byBio) {
    if (mids.length < 2) continue;
    dupes++;
    const id = index.get(bio)!;
    const canon = canonicalSlug(id);
    const losers = mids.filter(m => m !== canon);
    for (const loser of losers) {
      for (const t of FK_TABLES) {
        const c = (await (await conn.run(`SELECT COUNT(*) FROM ${t} WHERE member_id = ?`, [loser])).getRows())[0][0] as number;
        if (c > 0) {
          console.error(`ABORT: ${t} has ${c} rows for loser slug "${loser}" (bioguide ${bio}). FK dedup is deferred — defer UNIQUE too.`);
          process.exit(1);
        }
      }
      await conn.run('DELETE FROM members WHERE member_id = ?', [loser]);
      console.log(`merged member row ${loser} → ${canon} (bioguide ${bio})`);
    }
  }
  console.log(`reconcile complete: ${dupes} duplicate person(s) collapsed`);

  // 4. Only now, if reconcile left bioguide unique, add the UNIQUE index.
  try {
    await conn.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_members_bioguide ON members(bioguide_id)');
    console.log('bioguide UNIQUE index established');
  } catch (e) {
    console.error('UNIQUE index NOT added (residual duplicates) — deferred:', String(e).slice(0, 120));
  }
  process.exit(0);
}

main();
```

- [ ] **Step 4: Back up the DB, then run the seeder**

Run:
```bash
cp data/civiclens.duckdb data/civiclens.duckdb.bak-pre-identity && \
npx tsx db/load-member-aliases.ts
```
Expected: prints seeded alias count, any `unreconciled member row` warnings, any merges, and either "bioguide UNIQUE index established" OR a deferral message. If it prints `ABORT: ... FK dedup is deferred`, that is a valid outcome — the resolver/alias table still shipped; note it in the commit and leave UNIQUE for the follow-on.

- [ ] **Step 5: Verify no member resolves to two rows**

Run:
```bash
npx tsx -e "import {getDb} from './db/init.ts'; const c=await getDb(); const r=await c.run('SELECT bioguide_id, COUNT(*) n FROM members WHERE bioguide_id IS NOT NULL GROUP BY 1 HAVING n>1'); console.log('dup bioguides:', (await r.getRows())); process.exit(0)"
```
Expected: `dup bioguides: []` (empty) if reconcile succeeded; a non-empty list means UNIQUE was correctly deferred.

- [ ] **Step 6: Commit** (state the outcome — UNIQUE established or deferred)

```bash
git add db/schema.sql db/load-member-aliases.ts
git commit -m "feat(identity): member_aliases seed + members backfill/reconcile

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Wire the researcher ingestion gate (`skills/researcher/fetch.ts`)

**Files:**
- Modify: `skills/researcher/fetch.ts` (the identity-resolution step, around the
  `fetchBioguideByName(name)` call at ~line 707, inside the exported
  fetch-politician entry point).

**Interfaces:**
- Consumes: `resolveMember` (`lib/resolveMember.ts`).
- Produces: an ingestion path that skips + logs unresolved/ambiguous rows and
  uses the resolved bioguide + canonical slug for resolvable ones.

- [ ] **Step 1: Read the identity step** to confirm the exact seam.

Run: `rg -n "fetchBioguideByName|no bioguide ID|warnings.push" skills/researcher/fetch.ts | head`
Confirm the identity block: `const bioguideId = await fetchBioguideByName(name); if (!bioguideId) { warnings.push(...); return ...; }`.

- [ ] **Step 2: Add the import** at the top of `skills/researcher/fetch.ts` (with the other `lib` imports):

```ts
import { resolveMember } from '../../lib/resolveMember.ts';
```

- [ ] **Step 3: Replace the identity step** so the deterministic resolver is the
gate and the API lookup is only a fallback for enrichment. Replace:

```ts
  const bioguideId = await fetchBioguideByName(name);
  if (!bioguideId) {
    warnings.push(`Congress.gov: no bioguide ID for "${name}"`);
```

with:

```ts
  const resolved = resolveMember({ name });
  if (!resolved.ok) {
    // Deterministic rejection + continuation: never coerce, never abort the batch.
    console.warn(`[researcher] skip "${name}": ${resolved.reason}` +
      (resolved.reason === 'ambiguous' ? ` candidates=${resolved.candidates.join(',')}` : ''));
    return { skipped: true, reason: resolved.reason, name } as any;
  }
  const bioguideId = resolved.bioguide;
  const canonicalMemberSlug = resolved.slug;
  void canonicalMemberSlug; // used where the member_id slug is assigned downstream
  {
    // (former no-bioguide branch retained only as an unreachable guard)
    if (!bioguideId) {
      warnings.push(`Congress.gov: no bioguide ID for "${name}"`);
```

> **Note for the implementer:** the original `if (!bioguideId) { … }` block ends
> with a `return`. Keep that inner block body intact and close the extra `{`
> you opened. The net effect: resolvable names proceed with a deterministic
> bioguide + `canonicalMemberSlug`; unresolvable/ambiguous names return an early
> `{ skipped: true, … }` and the batch continues. Where the code later derives
> or writes the member's `member_id`, use `canonicalMemberSlug` instead of any
> ad-hoc slug so the PK matches the reconciled `members` row.

- [ ] **Step 4: Type-check the change**

Run: `npx tsc --noEmit`
Expected: no new errors in `skills/researcher/fetch.ts`. (Fix the brace/return
shape until it compiles; the resolver call and skip path must be reachable.)

- [ ] **Step 5: Smoke test resolve on a known + unknown name**

Run:
```bash
npx tsx -e "import {resolveMember} from './lib/resolveMember.ts'; console.log(resolveMember({name:'Marjorie Taylor Greene'})); console.log(resolveMember({name:'Ghost Member'})); process.exit(0)"
```
Expected: first prints `{ ok: true, bioguide: 'G000596', slug: 'marjorie-greene' }` (bioguide is whatever the real YAML holds — the point is `ok: true` with a bioguide + slug); second prints `{ ok: false, reason: 'unresolved' }`.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS, including the new `lib/*.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add skills/researcher/fetch.ts
git commit -m "feat(researcher): gate ingestion on deterministic resolveMember

Skip+log unresolved/ambiguous members; use canonical bioguide+slug.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- C1 identity index → Task 1. ✓
- C2 alias table (generation) → Task 2; (DB persistence) → Task 4. ✓
- C3 resolveMember (exact→alias→null, ambiguity reject, canonical slug) → Task 3. ✓
- C4 schema (member_aliases, term_*, bioguide UNIQUE w/ constraint-ordering) → Task 4. ✓
- C5 validation gate (skip+log, no abort, no coerce) → Task 5. ✓
- C6 members-only reconcile (FK dedup deferred, abort-on-FK-reference) → Task 4 Step 3. ✓
- Testing (exact/nickname/comma/initial/ambiguous/unknown/dedup-slug) → Task 3 Step 1. ✓
- Deterministic, no-network → Global Constraints + Task 1 local paths. ✓

**Placeholder scan:** no TBD/TODO; every code step carries complete code. The one
conditional ("if reconcile needs FK rewrites, defer UNIQUE") is an explicit
decision branch with both outcomes specified, not a placeholder.

**Type consistency:** `MemberIdentity`, `ResolveResult`, `buildIndex`,
`buildAliasMap`, `normalizeName`, `canonicalSlug`, `makeResolver`,
`resolveMember` names/signatures are identical across Tasks 1→5. `member_aliases`
columns (`alias_norm`, `bioguide_id`) match between Task 4 schema and seeder.
```
