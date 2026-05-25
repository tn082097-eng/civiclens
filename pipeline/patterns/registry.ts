/**
 * Pattern Discovery v2 — detector registry.
 *
 * Phase 1: trade-vote-alignment, spousal-trade-timing.
 * Phase 2: donor-sector-vote-alignment (OpenSecrets donor-industry substrate +
 * donor_industry_theme crosswalk). district-contracts-vote-alignment remains
 * Phase 2 (USAspending, source-first, not yet built).
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
