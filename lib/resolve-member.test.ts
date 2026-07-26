import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildIndex, buildAliasMap } from './legislators.js';
import { resolveIdentity, resolveMember, deriveSlug } from './resolve-member.js';

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
    index: idx,
    aliasMap: aliases,
    slugLookup: (bio) => (bio === 'S000033' ? 'bernie-sanders' : undefined),
  });
  assert.deepEqual(r, { ok: true, bioguide: 'S000033', slug: 'bernie-sanders' });
});
test('resolveMember derives first-last for a member with no DB row', async () => {
  const r = await resolveMember({ name: 'Robert Smith' }, {
    index: idx,
    aliasMap: aliases,
    slugLookup: () => undefined,
  });
  // ambiguous → still rejected before slug derivation
  assert.equal(r.ok, false);
});
test('resolveMember derives a slug from the injected index when no DB row', async () => {
  const r = await resolveMember({ name: 'Bernard Sanders' }, {
    index: idx,
    aliasMap: aliases,
    slugLookup: () => undefined, // brand-new member, no DB slug
  });
  assert.deepEqual(r, { ok: true, bioguide: 'S000033', slug: 'bernard-sanders' });
});
test('resolveMember rejects an unknown name via the injected index', async () => {
  const r = await resolveMember({ name: 'Nobody McNobody' }, { index: idx, aliasMap: aliases });
  assert.deepEqual(r, { ok: false, reason: 'unresolved' });
});
test('deriveSlug is first-last, punctuation collapsed', () => {
  assert.equal(deriveSlug('Bernard Sanders'), 'bernard-sanders');
});
