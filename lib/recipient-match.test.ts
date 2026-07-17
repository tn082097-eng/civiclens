import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normCorpName, buildNameIndex, matchTicker } from './recipient-match.js';

test('normCorpName strips punctuation, suffixes, whitespace', () => {
  assert.equal(normCorpName('NICE SYSTEMS INC'), 'NICE');
  assert.equal(normCorpName('Stryker Corporation'), 'STRYKER');
  assert.equal(normCorpName('(RC) 2 PHARMA CONNECT L.L.C.'), 'RC 2 PHARMA CONNECT L L C');
  assert.equal(normCorpName('GENERAL ELECTRIC COMPANY'), 'GENERAL ELECTRIC');
});

test('normCorpName is the probe norm — suffix list is a single global pass', () => {
  // HOLDINGS, GROUP, TECHNOLOGIES all stripped in one pass
  assert.equal(normCorpName('FRONTIER TECHNOLOGY INC'), 'FRONTIER');
});

test('buildNameIndex: first title wins per normalized name (probe setdefault)', () => {
  const idx = buildNameIndex([
    { ticker: 'aaa', title: 'ACME CORP' },
    { ticker: 'BBB', title: 'ACME INC' },
  ]);
  assert.equal(idx.get('ACME'), 'AAA'); // first wins, uppercased
});

test('matchTicker: own name first, then parent', () => {
  const idx = new Map([['NICE', 'NICE'], ['STRYKER', 'SYK']]);
  assert.deepEqual(matchTicker('NICE SYSTEMS INC', null, idx), { ticker: 'NICE', basis: 'own-name' });
  assert.deepEqual(matchTicker('HOWMEDICA OSTEONICS CORP', 'STRYKER CORPORATION', idx), { ticker: 'SYK', basis: 'parent-name' });
  assert.equal(matchTicker('HUDSON TECHNOLOGIES COMPANY', null, idx), null);
});

test('suffix-collision trap survives as candidate-only (documented, not fixed)', () => {
  // ULCC (Frontier Airlines) vs FRONTIER TECHNOLOGY INC — same normalized name.
  // The matcher MUST return the collision; the confirm table is the fix.
  const idx = buildNameIndex([{ ticker: 'ULCC', title: 'Frontier Group Holdings, Inc.' }]);
  assert.deepEqual(matchTicker('FRONTIER TECHNOLOGY INC', null, idx), { ticker: 'ULCC', basis: 'own-name' });
});
