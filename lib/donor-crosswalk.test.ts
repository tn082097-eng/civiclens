import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DONOR_INDUSTRY_THEME,
  matchDonorThemes,
} from '../db/load-sector-crosswalk.js';

// Real OpenSecrets industry strings observed in donor_industry (2024 cycle,
// 45-member roster). The crosswalk is ILIKE-based, so every string here is a
// regression tripwire: the 2026-07-15 audit found cross-theme collisions
// ('Coal mining' landed in both Energy and Materials & Mining) and Labor money
// leaking into Materials & Mining via '%mining%' matching 'Mining unions'.

test('every observed industry maps to at most one theme (no cross-theme double counting)', () => {
  const observed = [
    'Oil & gas',
    'Coal mining',
    'Metal mining & processing',
    'Non-metallic mining',
    'Mining services & equipment',
    'Mining',
    'Aluminum mining/processing',
    'Mining unions',
    'Energy-related unions (non-mining)',
    'Finance, Insurance & Real Estate',
    'Insurance',
    'Insurance companies, brokers & agents',
    'Real estate',
    'Real estate agents',
    'Real Estate developers & subdividers',
    'Other real estate services',
    'Security brokers & investment companies',
    'Investors',
    'Building operators and managers',
    'Auto dealers, new & used',
    'Nurses',
    'Psychiatrists & psychologists',
    'Construction, unclassified',
    'Construction & Public Works',
    'Residential construction',
    'Power plant construction & equipment',
    'Nuclear plant construction, equipment & svcs',
    'Entertainment Industry/Broadcast & Motion Pictures',
    'Private Equity & Investment Firms',
    'Book, newspaper & periodical publishing',
    'Defense aerospace contractors',
  ];
  for (const industry of observed) {
    const themes = matchDonorThemes(industry);
    assert.ok(
      themes.length <= 1,
      `"${industry}" maps to ${themes.length} themes: ${themes.join(', ')}`,
    );
  }
});

test('collision fixes land on the intended single theme', () => {
  assert.deepEqual(matchDonorThemes('Coal mining'), ['Energy']);
  assert.deepEqual(matchDonorThemes('Metal mining & processing'), ['Materials & Mining']);
  assert.deepEqual(matchDonorThemes('Non-metallic mining'), ['Materials & Mining']);
  assert.deepEqual(matchDonorThemes('Mining services & equipment'), ['Materials & Mining']);
  assert.deepEqual(matchDonorThemes('Mining'), ['Materials & Mining']);
  assert.deepEqual(matchDonorThemes('Finance, Insurance & Real Estate'), ['Banks & Finance']);
  assert.deepEqual(matchDonorThemes('Real estate agents'), ['Real Estate']);
  assert.deepEqual(matchDonorThemes('Other real estate services'), ['Real Estate']);
});

test('union money never maps to a tradable-industry theme', () => {
  assert.deepEqual(matchDonorThemes('Mining unions'), []);
  assert.deepEqual(matchDonorThemes('Energy-related unions (non-mining)'), []);
});

test('previously unmapped tradable industries now map', () => {
  assert.deepEqual(matchDonorThemes('Security brokers & investment companies'), ['Banks & Finance']);
  assert.deepEqual(matchDonorThemes('Investors'), ['Banks & Finance']);
  assert.deepEqual(matchDonorThemes('Building operators and managers'), ['Real Estate']);
  assert.deepEqual(matchDonorThemes('Auto dealers, new & used'), ['Transportation']);
  assert.deepEqual(matchDonorThemes('Nurses'), ['Pharma & Health']);
  assert.deepEqual(matchDonorThemes('Psychiatrists & psychologists'), ['Pharma & Health']);
  assert.deepEqual(matchDonorThemes('Construction, unclassified'), ['Industrials']);
});

test('deliberately unmapped categories stay unmapped', () => {
  for (const industry of [
    'Retired',
    'Republican/Conservative',
    'Democratic/Liberal',
    'Attorneys & law firms',
    'Schools & colleges',
    'Civil servant/public employee',
    'Lobbyists & Public Relations',
    'Crop production & basic processing', // Agribusiness — no Agriculture theme in the 12
  ]) {
    assert.deepEqual(matchDonorThemes(industry), [], industry);
  }
});

test('crosswalk patterns are well-formed (non-empty, known themes)', () => {
  const THEMES = new Set([
    'Banks & Finance', 'Defense & Aerospace', 'Energy', 'Industrials',
    'Materials & Mining', 'Media & Telecom', 'Payments', 'Pharma & Health',
    'Real Estate', 'Retail & Consumer', 'Tech & Semiconductors', 'Transportation',
  ]);
  for (const { pattern, theme } of DONOR_INDUSTRY_THEME) {
    assert.ok(pattern.length > 0);
    assert.ok(THEMES.has(theme), `unknown theme "${theme}" for pattern "${pattern}"`);
  }
});
