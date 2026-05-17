/**
 * Pattern Discovery v2 — detector registry.
 *
 * Phase 1: two detectors with real substrate. donor-sector-vote-alignment is
 * deferred to Phase 2 (no donor-sector / bill-subject data ingested yet);
 * district-contracts-vote-alignment is Phase 2 (USAspending, source-first).
 * Add detectors here as they land — run-patterns.ts iterates this array.
 */

import type { PatternDetector } from './types.js';
import { tradeVoteAlignment } from './trade-vote-alignment.js';
import { spousalTradeTiming } from './spousal-trade-timing.js';

export const DETECTORS: PatternDetector[] = [
  tradeVoteAlignment,
  spousalTradeTiming,
];
