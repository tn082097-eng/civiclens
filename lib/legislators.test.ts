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
