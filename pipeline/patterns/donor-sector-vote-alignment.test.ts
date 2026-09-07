import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDonorThemeCitation } from './donor-sector-vote-alignment.js';

test('donor evidence publishes one CivicLens theme summary without raw industry labels', () => {
  const citations = buildDonorThemeCitation('jane-doe', 'Banks & Finance', [
    { industry: 'Hedge Funds', total: 1_500_000 },
    { industry: 'Private Equity & Investment Firms', total: 980_146 },
    { industry: 'Commercial Banks', total: 300_000 },
  ]);

  assert.deepEqual(citations, [{
    kind: 'donor',
    id: 'jane-doe|Banks & Finance',
    label: 'Banks & Finance — 3 contributing industries ($2,780,146)',
  }]);
  assert.doesNotMatch(JSON.stringify(citations), /Hedge Funds|Private Equity|Commercial Banks/);
});

test('donor evidence uses a singular industry label', () => {
  assert.deepEqual(
    buildDonorThemeCitation('jane-doe', 'Energy', [
      { industry: 'Oil & Gas', total: 125_000 },
    ]),
    [{
      kind: 'donor',
      id: 'jane-doe|Energy',
      label: 'Energy — 1 contributing industry ($125,000)',
    }],
  );
});
