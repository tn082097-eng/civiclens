/**
 * patternIntensityClass — render-time visual weight tier, with the scored-null
 * cap (spec docs/2026-07-20-timing-detectors-scoring.md: flags at p >= 0.05 are
 * capped at the lowest tier; DB intensity is untouched). Pure fn, no DB.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { patternIntensityClass } from './build.js';

test('patternIntensityClass: scored-null cap and existing tiers', () => {
  // Scored but not significant -> capped low regardless of intensity.
  assert.equal(patternIntensityClass(0.9, 0.2), 'intensity-low', 'p>=0.05 caps a high-intensity flag');
  assert.equal(patternIntensityClass(0.9, 0.05), 'intensity-low', 'boundary p=0.05 caps (spec: p >= 0.05)');

  // Scored and significant -> substrate-driven tier survives.
  assert.equal(patternIntensityClass(0.9, 0.01), 'intensity-high', 'significant flag keeps its weight');

  // Unscored (NULL/undefined p) -> existing behavior untouched.
  assert.equal(patternIntensityClass(0.9, null), 'intensity-high', 'null p_value = unscored, existing tier');
  assert.equal(patternIntensityClass(0.9, undefined), 'intensity-high', 'undefined p_value = unscored, existing tier');

  // Cap never RAISES weight: a low-intensity significant flag stays low.
  assert.equal(patternIntensityClass(0.05, 0.01), 'intensity-low', 'cap does not raise weight');

  // Existing thresholds intact for unscored rows.
  assert.equal(patternIntensityClass(0.7, null), 'intensity-medium', 'medium tier boundary');
  assert.equal(patternIntensityClass(0.6, null), 'intensity-medium', 'medium tier lower boundary');
  assert.equal(patternIntensityClass(0.59, null), 'intensity-low', 'below medium = low');
});
