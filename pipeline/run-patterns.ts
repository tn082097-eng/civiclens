/**
 * Pattern Discovery v2 — detection pass.
 *
 * Runs AFTER the agent pipeline (not an agent). Reads DuckDB, runs each
 * registered detector for one member or the whole roster, and upserts results
 * into pattern_hits. Site rebuild reads from there.
 *
 *   npx tsx pipeline/run-patterns.ts --member marjorie-taylor-greene
 *   npx tsx pipeline/run-patterns.ts --all
 *
 * Re-running is idempotent per (detector, member): a detector's prior hits for
 * that member are cleared before its fresh hits are written, so tuning a
 * threshold and re-running just replaces that detector's rows.
 */

import type { DuckDBConnection } from '@duckdb/node-api';
import { getDb } from '../db/init.js';
import { listMembers } from '../db/queries.js';
import { DETECTORS } from './patterns/registry.js';
import type { PatternDetector } from './patterns/types.js';
import type { PatternHit } from './patterns/types.js';
import { SCORED_PATTERNS, scorePattern, type ScoreResult } from './score-anomaly.js';
import { warnIfUnconsumed } from './patterns/_confirmatory-guard.js';

/**
 * The parked timing pair. run-patterns is a ROUTINE onboarding path and must
 * never run, write, DELETE, or score these — a new member must not receive first
 * timing p-values as an onboarding side effect (ADR 0003 governs their one-shot
 * confirmatory run; scoring lives solely in score-anomaly.ts / *-baseline.ts).
 * These are exactly SCORED_PATTERNS; kept as a named constant for the guard.
 */
export const PARKED_TIMING_PATTERNS = SCORED_PATTERNS;

/**
 * The detectors run-patterns is allowed to run — the registry MINUS the parked
 * timing pair. We filter (not delete from the registry) so score-anomaly and the
 * baseline runners still see the full set. Filtering here means the parked
 * detectors' detect()/writeHits()/DELETE/writeAndScore()/scorePattern() are
 * never reached from this entrypoint.
 */
export function onboardingSafeDetectors(
  candidates: PatternDetector[] = DETECTORS,
): PatternDetector[] {
  const parked = new Set<string>(PARKED_TIMING_PATTERNS as readonly string[]);
  return candidates.filter(d => !parked.has(d.name));
}

/** Signature of the inline scorer (real one is scorePattern; tests inject a stub). */
type Scorer = (pattern: string, member: string) => Promise<ScoreResult | null>;

async function writeHits(
  pattern: string,
  member: string,
  hits: PatternHit[],
  conn: DuckDBConnection,
): Promise<void> {
  // Clear this detector's prior hits for this member, then insert fresh.
  // This DELETE-then-INSERT is the idempotency mechanism (pattern_hits has no
  // PK by design — DuckDB index-delete bug, db/schema.sql). It drops the stat
  // columns, so writeAndScore re-scores immediately for SCORED_PATTERNS to
  // avoid stranding previously-scored stats as NULL on a re-run.
  await conn.run('DELETE FROM pattern_hits WHERE pattern = ? AND member = ?', [
    pattern,
    member,
  ]);
  for (const h of hits) {
    await conn.run(
      `INSERT INTO pattern_hits
         (pattern, member, finding, intensity, citing_json, dates_json, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        h.pattern,
        h.member,
        h.finding,
        h.intensity,
        JSON.stringify(h.citing),
        JSON.stringify(h.dates),
        h.detectedAt,
      ],
    );
  }
}

/**
 * Orchestration contract: write a detector's hits, then — for a SCORED_PATTERNS
 * detector with at least one hit — re-score inline so the freshly re-inserted
 * rows carry their stat columns. Because writeHits DELETE-then-INSERTs without
 * stats, skipping this step would silently NULL previously-scored stats on a
 * re-run (the wipeout bug). Returns the scorer's result (for the log line) or
 * null when no scoring applies.
 *
 * A scorer failure propagates — it is never swallowed into "0 hits".
 */
export async function writeAndScore(
  pattern: string,
  member: string,
  hits: PatternHit[],
  deps: { conn?: DuckDBConnection; scorer?: Scorer } = {},
): Promise<ScoreResult | null> {
  const conn = deps.conn ?? (await getDb());
  const scorer = deps.scorer ?? scorePattern;
  await writeHits(pattern, member, hits, conn);
  if (
    hits.length > 0 &&
    (SCORED_PATTERNS as readonly string[]).includes(pattern)
  ) {
    return scorer(pattern, member);
  }
  return null;
}

/**
 * PRIVATE raw execution loop. Runs whatever detectors it is handed — writing +
 * scoring each. It is intentionally NOT exported: nothing outside this module
 * may run an arbitrary, unfiltered detector list (that is the timing bypass we
 * are closing). The ONLY way in from outside is
 * runOnboardingDetectorsForMember, which filters the parked pair first.
 */
async function runDetectorLoop(
  member: string,
  detectors: PatternDetector[],
  deps: { conn?: DuckDBConnection; scorer?: Scorer } = {},
): Promise<number> {
  let total = 0;
  for (const det of detectors) {
    let hits: PatternHit[];
    try {
      hits = await det.detect(member);
    } catch (e) {
      // A detector failing must not silently produce zero — surface loudly.
      console.error(`  ✗ ${det.name} threw for ${member}:`, (e as Error).message);
      throw e;
    }
    const score = await writeAndScore(det.name, member, hits, deps);
    total += hits.length;
    const summary = hits.length
      ? hits.map(h => `${h.intensity.toFixed(2)}`).join(',')
      : '—';
    const scoreNote = score
      ? ` p=${score.pValue.toFixed(4)} z=${score.zScore.toFixed(2)} [${score.nullModel}]`
      : '';
    console.log(`  ${det.name}: ${hits.length} hit(s) [${summary}]${scoreNote}`);
  }
  return total;
}

/**
 * The onboarding safety boundary. Accepts an UNFILTERED candidate detector list
 * and INTERNALLY excludes the parked timing pair (trade-vote-alignment,
 * spousal-trade-timing) BEFORE any detect(), DB mutation, or scoring — so even a
 * caller that hands in the parked detectors cannot make them run, write, delete,
 * or score. Defaults to the full registry. This is the ONLY exported way to run
 * detectors for a member; the raw loop stays private. Timing scoring lives
 * solely in score-anomaly.ts / *-baseline.ts (ADR 0003).
 */
export async function runOnboardingDetectorsForMember(
  member: string,
  candidates: PatternDetector[] = DETECTORS,
  deps: { conn?: DuckDBConnection; scorer?: Scorer } = {},
): Promise<number> {
  const safe = onboardingSafeDetectors(candidates);
  return runDetectorLoop(member, safe, deps);
}

/** Production onboarding path: full registry in, parked pair filtered internally. */
async function runForMember(member: string): Promise<number> {
  return runOnboardingDetectorsForMember(member);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const memberIdx = args.indexOf('--member');
  const all = args.includes('--all');

  if (!all && memberIdx === -1) {
    console.error('usage: run-patterns.ts --member <slug> | --all');
    process.exit(2);
  }

  let members: string[];
  if (all) {
    members = (await listMembers()).map(m => m.member_id);
  } else {
    const slug = args[memberIdx + 1];
    if (!slug) {
      console.error('--member requires a slug');
      process.exit(2);
    }
    members = [slug];
  }

  // Timing-safe by default: the parked timing pair is filtered out of this
  // path entirely (onboardingSafeDetectors), so no timing detect/write/score
  // ever runs here — a new member never gets first timing p-values as an
  // onboarding side effect. Timing scoring lives solely in score-anomaly.ts and
  // the *-baseline.ts confirmatory runners (ADR 0003). The advisory below makes
  // that explicit if the pair is still unconsumed.
  warnIfUnconsumed([...PARKED_TIMING_PATTERNS]);
  const detectors = onboardingSafeDetectors();
  console.log(
    `(onboarding-safe: running ${detectors.length} detector(s); ` +
    `parked timing pair [${[...PARKED_TIMING_PATTERNS].join(', ')}] excluded — ` +
    `use score-anomaly.ts for those.)`,
  );

  let grandTotal = 0;
  for (const m of members) {
    console.log(`▸ ${m}`);
    grandTotal += await runForMember(m);
  }
  console.log(
    `\nDone. ${grandTotal} hit(s) across ${members.length} member(s), ` +
      `${detectors.length} detector(s).`,
  );
  process.exit(0);
}

// Entry-point guard (repo convention): only run the CLI when invoked directly,
// so importing this module for its exports (e.g. writeAndScore in tests) does
// not trigger main()/process.exit.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
