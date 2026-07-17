/**
 * Pattern Discovery v2 — detector registry.
 *
 * Phase 1: trade-vote-alignment, spousal-trade-timing.
 * Phase 2: donor-sector-vote-alignment (OpenSecrets donor-industry substrate +
 * donor_industry_theme crosswalk).
 *
 * district-contract-trade-alignment is BUILT but GATED — its permutation null
 * baseline failed (p=0.48: theme-level district-contract × trade overlap is
 * base-rate coupling, not district-specific; see the verdict section in
 * docs/2026-07-15-district-contracts-detector.md). Do not register it without
 * a discriminating edge (recipient-name → ticker is the v2 candidate).
 *
 * Add detectors here as they land — run-patterns.ts iterates this array.
 */

import type { PatternDetector } from './types.js';
import { tradeVoteAlignment } from './trade-vote-alignment.js';
import { spousalTradeTiming } from './spousal-trade-timing.js';
import { donorSectorVoteAlignment } from './donor-sector-vote-alignment.js';

export const DETECTORS: PatternDetector[] = [
  tradeVoteAlignment,
  spousalTradeTiming,
  donorSectorVoteAlignment,
];
