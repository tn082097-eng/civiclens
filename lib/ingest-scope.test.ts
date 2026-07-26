/**
 * Shared ingestion-scope contract (Phase 1A). Proves the CLI parser fails closed,
 * that --all is explicit, and that a member selector resolves to exactly one
 * canonical target (by bioguide) BEFORE any loader touches the network or DB.
 *
 * Uses the fixture legislator index (no legislators-cache dependency) and an
 * injected member lookup (no live DB).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildIndex, buildAliasMap } from './legislators.js';
import { parseScopeArgs, resolveScope, ScopeError, type MemberRow } from './ingest-scope.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '__fixtures__', 'legislators-fixture.yaml');
const idx = buildIndex([FIXTURE]);
const aliases = buildAliasMap(idx);

// Injected DB lookup: bioguide -> the members row (or undefined for a brand-new member).
const DB: Record<string, MemberRow> = {
  S000033: { memberId: 'bernie-sanders', chamber: 'senate' },
  R000001: { memberId: 'robert-smith-ca', chamber: 'house' },
};
const memberLookup = (bio: string): MemberRow | undefined => DB[bio];

const deps = { index: idx, aliasMap: aliases, memberLookup };

// ─── parseScopeArgs: fail closed, explicit --all, mutual exclusion ───────────

test('no selector fails closed (never means all)', () => {
  assert.throws(() => parseScopeArgs([]), ScopeError);
  assert.throws(() => parseScopeArgs(['--dry-run']), ScopeError);
});

test('--all is explicit', () => {
  assert.deepEqual(parseScopeArgs(['--all']), { kind: 'all' });
});

test('--member captures the selector', () => {
  assert.deepEqual(parseScopeArgs(['--member', 'bernie-sanders']), {
    kind: 'member', selector: 'bernie-sanders', by: 'member',
  });
});

test('--bioguide captures the id', () => {
  assert.deepEqual(parseScopeArgs(['--bioguide', 'S000033']), {
    kind: 'member', selector: 'S000033', by: 'bioguide',
  });
});

test('--member and --all together fails', () => {
  assert.throws(() => parseScopeArgs(['--member', 'x', '--all']), ScopeError);
  assert.throws(() => parseScopeArgs(['--all', '--bioguide', 'S000033']), ScopeError);
});

test('--member without a value fails', () => {
  assert.throws(() => parseScopeArgs(['--member']), ScopeError);
});

test('repeated --member is ambiguous and fails (no silent last-wins)', () => {
  assert.throws(() => parseScopeArgs(['--member', 'a', '--member', 'b']), /more than once/i);
});

test('repeated --bioguide is ambiguous and fails', () => {
  assert.throws(() => parseScopeArgs(['--bioguide', 'A000001', '--bioguide', 'B000002']), /more than once/i);
});

// ─── resolveScope: exactly one canonical target, by bioguide ─────────────────

test('resolveScope(all) passes through', async () => {
  assert.deepEqual(await resolveScope({ kind: 'all' }, deps), { kind: 'all' });
});

test('resolveScope resolves a slug/name to one canonical member', async () => {
  const r = await resolveScope({ kind: 'member', selector: 'Bernard Sanders', by: 'member' }, deps);
  assert.deepEqual(r, {
    kind: 'member', slug: 'bernie-sanders', bioguideId: 'S000033',
    memberId: 'bernie-sanders', chamber: 'senate',
  });
});

test('resolveScope resolves by bioguide directly', async () => {
  const r = await resolveScope({ kind: 'member', selector: 'S000033', by: 'bioguide' }, deps);
  assert.equal(r.kind, 'member');
  assert.equal((r as any).bioguideId, 'S000033');
  assert.equal((r as any).chamber, 'senate');
});

test('unknown member fails before work', async () => {
  await assert.rejects(
    resolveScope({ kind: 'member', selector: 'Nobody McNobody', by: 'member' }, deps),
    ScopeError,
  );
});

test('ambiguous member fails before work', async () => {
  await assert.rejects(
    resolveScope({ kind: 'member', selector: 'Robert Smith', by: 'member' }, deps),
    /ambiguous/i,
  );
});

test('resolved-but-not-in-DB member fails loud (member must exist first)', async () => {
  // R000001 resolves in the index but map it to a missing DB row here.
  const missingDbDeps = { index: idx, aliasMap: aliases, memberLookup: () => undefined };
  await assert.rejects(
    resolveScope({ kind: 'member', selector: 'S000033', by: 'bioguide' }, missingDbDeps),
    /not in the members table|does not exist/i,
  );
});
