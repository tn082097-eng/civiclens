import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAICS_THEME, matchNaicsTheme } from '../db/load-sector-crosswalk.js';

// Every NAICS code observed in the frozen probe rollups (NJ-05 + GA-14,
// SOURCES.md §USAspending) is a regression tripwire: each must resolve via
// longest-prefix-wins to exactly the intended theme — or to null, which is
// load-bearing (unmapped-by-construction families stay out of the theme space).

test('observed probe codes resolve to the intended theme', () => {
  const expected: Record<string, string | null> = {
    '221122': 'Energy',                 // Electric Power Distribution
    '236220': null,                     // Commercial Building Construction — unmapped
    '311615': null,                     // Poultry Processing — unmapped (no food ticker in trade space)
    '326299': null,                     // Other Rubber Product Mfg — unmapped
    '331315': 'Materials & Mining',     // Aluminum Sheet/Plate/Foil
    '332992': 'Defense & Aerospace',    // Small Arms Ammunition Mfg
    '334412': 'Tech & Semiconductors',  // Bare Printed Circuit Boards
    '334510': 'Pharma & Health',        // Electromedical Apparatus — longest-prefix override
    '334512': 'Tech & Semiconductors',  // Automatic Environmental Controls
    '334513': 'Tech & Semiconductors',  // Industrial Process Instruments
    '334516': 'Tech & Semiconductors',  // Analytical Lab Instruments
    '334519': 'Tech & Semiconductors',  // Other Measuring Devices
    '335931': 'Industrials',            // Current-Carrying Wiring Devices
    '335999': 'Industrials',            // Misc Electrical Equipment
    '336413': 'Defense & Aerospace',    // Other Aircraft Parts
    '339112': 'Pharma & Health',        // Surgical & Medical Instruments
    '339113': 'Pharma & Health',        // Surgical Appliances & Supplies
    '423450': 'Pharma & Health',        // Medical/Dental/Hospital Wholesalers
    '481212': 'Transportation',         // Nonscheduled Chartered Freight Air
    '512290': 'Media & Telecom',        // Other Sound Recording
    '541310': null,                     // Architectural Services — unmapped
    '541330': null,                     // Engineering Services — unmapped
    '541714': null,                     // R&D Biotechnology — unmapped
    '541715': null,                     // R&D Phys/Eng/Life Sciences — unmapped
    '561210': null,                     // Facilities Support Services — unmapped
    '562910': null,                     // Remediation Services — unmapped
    '622110': 'Pharma & Health',        // General Hospitals
    '623110': 'Pharma & Health',        // Nursing Care Facilities
  };
  for (const [code, theme] of Object.entries(expected)) {
    assert.equal(
      matchNaicsTheme(code), theme,
      `${code} expected ${theme ?? 'null (unmapped)'}, got ${matchNaicsTheme(code)}`,
    );
  }
});

test('longest prefix wins over shorter overlapping prefixes', () => {
  // 334510 (Pharma & Health) sits inside 3345 (Tech & Semiconductors): the
  // 6-digit override must beat the 4-digit family for exactly that code.
  assert.equal(matchNaicsTheme('334510'), 'Pharma & Health');
  assert.equal(matchNaicsTheme('334511'), 'Tech & Semiconductors');
  assert.equal(matchNaicsTheme('334519'), 'Tech & Semiconductors');
});

test('seeded prefixes are unique (PRIMARY KEY invariant, pre-DB)', () => {
  const prefixes = NAICS_THEME.map((r) => r.prefix);
  assert.equal(new Set(prefixes).size, prefixes.length);
});

test('every seeded theme is one of the existing crosswalk themes', () => {
  const known = new Set([
    'Energy', 'Pharma & Health', 'Banks & Finance', 'Payments',
    'Defense & Aerospace', 'Tech & Semiconductors', 'Media & Telecom',
    'Retail & Consumer', 'Transportation', 'Industrials',
    'Materials & Mining', 'Real Estate',
  ]);
  for (const { prefix, theme } of NAICS_THEME) {
    assert.ok(known.has(theme), `prefix ${prefix} maps to unknown theme "${theme}"`);
  }
});
