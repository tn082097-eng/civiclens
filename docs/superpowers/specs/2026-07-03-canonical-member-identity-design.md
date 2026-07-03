# Canonical Member Identity (#7 Substrate) — Design

> **Status:** approved design, pre-implementation. Spec date 2026-07-03.
> **Scope guard:** this is the *identity substrate only*. It builds the deterministic
> resolver, the alias table, and wires **one** ingestion path (the researcher). It does
> **not** refactor every loader, rewire votes/money-vote/renderer, or run the full
> cross-table FK dedup. Those are explicit follow-ons.

## Problem

CivicLens keys every per-source table on `members.member_id`, which is a lowercased
`first-last` **slug** (`bernie-sanders`). The stable federal identity — the Bioguide ID
(`S000033`) — is only a *nullable secondary column*. Nothing enforces that one person maps
to one row. The result is the project's highest-risk failure mode:

- **Duplicate rows for one person** — `bernie-sanders` and `bernard-sanders` are two slugs
  for Bioguide `S000033`.
- **Name drift** — "Bernie" vs "Bernard", "McCarthy, Kevin" vs "Kevin McCarthy".
- **Cross-source mismatch** — FEC, Congress.gov, and PFD filings spell names differently.

Every downstream signal (vote→bill linkage, money-vote detector, donor mapping) is invalid
if identity is unstable: the same person under two IDs, or two people collapsed into one.

The existing resolver, `fetchBioguideByName()` in `skills/researcher/fetch.ts`, is ~90% of
the matching logic but has three disqualifying properties: it returns a **bioguide** (not
the slug PK), it is **network-dependent** (live Congress.gov, rate-limited, non-reproducible),
and it **takes the first `.find()` match** — it cannot detect ambiguity.

## Core principle

**Bioguide is identity. Slug is a projection of it.**

- The slug stays the primary key (small blast radius — no FK migration across the corpus).
- Every slug maps 1:1 to a bioguide (`members.bioguide_id UNIQUE`).
- The resolver is **deterministic** — it reads local YAML, never the network.
- The resolver **rejects ambiguity** and **never guesses**. No probabilistic fallback.

## Identity source of truth

Local cache `data/caches/legislators-cache/legislators-current.yaml` +
`legislators-historical.yaml` (from `unitedstates/congress-legislators`). Already on disk;
current code fetches the same files over HTTP — the resolver reads the **local cache** to be
deterministic. The Congress.gov API is demoted to **enrichment only, never identity**.

Each YAML record carries everything the resolver needs (verified against the Sanders record):

- `id.bioguide` — the canonical key (`S000033`).
- `name.{first,last,nickname,official_full}` — all alias material from one record
  (`Bernard` / `Sanders` / `Bernie` / `Bernard Sanders`).
- `id.fec` — list of FEC IDs, both chambers (`[H8VT01016, S4VT00033]`).
- `terms[]` — each term has `type` (`sen`/`rep` → chamber), `start`, `end`, `state`,
  `district`. Derive: chamber = last term type; `term_start` = `terms[0].start`;
  `term_end` = `terms[-1].end`; state/district = last term.

Current file holds 536 records (whole Congress); historical file covers former members
(e.g. McCarthy).

## Architecture

```
legislators-{current,historical}.yaml   (truth, local cache)
        │
        ▼
lib/legislators.ts        index builder: bioguide → MemberIdentity
        │
        ▼
lib/member-aliases.ts     derive normalized alias → bioguide map
        │
        ▼  (persisted to)
member_aliases table      (deterministic, inspectable)
        │
        ▼
lib/resolveMember.ts      pure fn: raw → { ok, bioguide, slug } | reject
        │
        ▼
skills/researcher/fetch.ts   ingestion gate (skip+log bad rows) — ONLY wired path
```

### Component 1 — `lib/legislators.ts` (identity index)

Parse both local YAML files once, memoized per process. Expose `MemberIdentity`:

```ts
interface MemberIdentity {
  bioguide: string;
  officialFull: string;
  first: string;
  last: string;
  nickname: string | null;
  fec: string[];
  chamber: 'House' | 'Senate';
  state: string;
  district: string | null;
  termStart: string;   // ISO date
  termEnd: string;      // ISO date
}
```

`getIdentityIndex(): Map<bioguide, MemberIdentity>`. No network. Historical + current merged
(current wins on bioguide collision).

### Component 2 — `lib/member-aliases.ts` (alias generation)

Pure. For each `MemberIdentity`, emit the set of normalized alias strings that all map to
its bioguide:

- `official_full`
- `first last`
- `nickname last` (when nickname present)
- `last, first` and `last, nickname` comma forms

**Normalization** (`normalizeName`): lowercase, strip punctuation (`.`, `,` handled by form),
collapse internal whitespace, drop single-letter middle initials. Multi-word surnames kept
whole ("wasserman schultz").

Output: `Map<alias_norm, Set<bioguide>>`. A `Set` (not a single value) so collisions are
detectable rather than silently overwritten — this is what powers ambiguity rejection.

### Component 3 — `lib/resolveMember.ts` (the gate function)

Pure, no I/O beyond the memoized index. Signature:

```ts
type ResolveResult =
  | { ok: true;  bioguide: string; slug: string }
  | { ok: false; reason: 'unresolved' }
  | { ok: false; reason: 'ambiguous'; candidates: string[] };

function resolveMember(raw: { name?: string; bioguide?: string }): ResolveResult;
```

Order:
1. If `raw.bioguide` present and in the index → `ok`.
2. Normalize `raw.name`, look up in the alias map.
   - Exactly 1 distinct bioguide → `ok`.
   - >1 distinct bioguide → `{ ok: false, reason: 'ambiguous', candidates }`. **No first-match.**
   - 0 → `{ ok: false, reason: 'unresolved' }`.

No fuzzy/edit-distance/probabilistic fallback anywhere.

**Canonical slug** derived deterministically from the identity: `officialFull` → lowercase →
`first-last` (spaces to hyphens, punctuation stripped). Because both "Bernie" and "Bernard"
resolve to `S000033` → same `MemberIdentity` → same slug, the dedup is solved *structurally*
at resolve time.

### Component 4 — schema (`db/schema.sql`)

- `members.bioguide_id` → `UNIQUE`. (See "Constraint ordering" below.)
- Add `members.term_start DATE`, `members.term_end DATE`.
  (`chamber`, `state`, `district` columns already exist — backfilled from YAML.)
- New table:

```sql
CREATE TABLE IF NOT EXISTS member_aliases (
  alias_norm   TEXT NOT NULL,
  bioguide_id  TEXT NOT NULL,
  PRIMARY KEY (alias_norm, bioguide_id)
);
```

Seeded by a small loader that walks `member-aliases.ts` output. DELETE-then-insert
idempotent, matching existing loader style.

**Constraint ordering (the honest snag).** `bioguide_id UNIQUE` cannot be applied while
`bernie-sanders` + `bernard-sanders` both exist with the same (or NULL) bioguide. The full
cross-table FK dedup is **out of scope** (deferred). To let the constraint hold, this spec
does the **minimal members-table-only reconciliation**: backfill every `members.bioguide_id`
via the resolver, and where two member rows resolve to one bioguide, collapse them to the
canonical slug **in the `members` table only** (a DB backup is taken first). Rows in FK
tables (`donors`, `votes`, …) still referencing the losing slug are **not** rewritten here —
they are picked up by the deferred FK-dedup follow-on. If minimal members-only reconciliation
proves to also require touching FK rows to avoid orphans, the `UNIQUE` constraint is added in
the follow-on instead, and this spec ships the resolver + alias table + `term_*` columns
without the constraint. Implementation plan resolves which of these two it is against the
live DB.

### Component 5 — validation gate (researcher ingestion)

Wire **only** `skills/researcher/fetch.ts`. Replace the `fetchBioguideByName` identity step
with `resolveMember`. Policy on failure:

```ts
if (!resolved.ok) {
  log({ type: resolved.reason, input: rawRow, candidates: resolved.candidates ?? [] });
  skipRow();   // continue the batch — do NOT abort, do NOT coerce
}
```

- **Skip + log, never abort:** one malformed legislator must not poison ingestion.
- **Never coerce:** silently picking a match reintroduces the exact ambiguity this eliminates.
- The result: *deterministic rejection + continuation*.

## Out of scope (explicit — do NOT do in this spec)

- Full loader refactor across the repo.
- Vote pipeline / money-vote detector rewiring.
- Renderer changes.
- Full cross-table FK dedup (the bernie/bernard FK-row cascade beyond the members table).

These become valid and easy *after* identity is stable; they are separate specs.

## Testing

Deterministic unit tests (`node:test`, `npx tsx --test`) against a small fixture YAML (Sanders
+ one synthetic ambiguous pair, e.g. two "J. Smith" in different states):

- exact `first last` → resolves.
- nickname (`Bernie Sanders`) → resolves to `S000033`.
- comma form (`Sanders, Bernard`) → resolves.
- middle initial (`Bernard I. Sanders`) → resolves.
- ambiguous ("J. Smith" matching two bioguides) → `{ ok: false, reason: 'ambiguous' }`, **not**
  a first-match.
- unknown name → `{ ok: false, reason: 'unresolved' }`.
- `bernie-sanders` and `bernard-sanders` inputs → identical canonical slug.

No network in any test.

## Implementation order

1. `lib/legislators.ts` — load local YAML, build bioguide index.
2. `lib/member-aliases.ts` — generate normalized alias → bioguide map.
3. `lib/resolveMember.ts` — pure strict resolver + canonical-slug derivation + tests.
4. `db/schema.sql` — `member_aliases` table, `term_start/term_end`, `bioguide_id UNIQUE`
   (per constraint-ordering note) + alias-seed loader + members backfill/reconcile.
5. `skills/researcher/fetch.ts` — swap identity step to `resolveMember`, skip+log bad rows.

## Success condition

- The same person always resolves to the same bioguide (and canonical slug).
- No external API call is required to resolve identity.
- Ambiguous names are explicitly rejected, never inferred.
- Researcher ingestion completes end-to-end with the gate, skipping+logging unresolved rows.

## What this unlocks

- Vote→bill linkage becomes a deterministic join, not identity repair.
- The money-vote detector becomes feature extraction, not identity repair.
- All downstream signal work rests on a stable identity spine.
