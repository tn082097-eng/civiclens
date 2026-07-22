/**
 * Rigor pillar: score the live timing detectors with a pre-registered null model.
 *   npx tsx pipeline/score-anomaly.ts --member pramila-jayapal
 *   npx tsx pipeline/score-anomaly.ts --member marjorie-taylor-greene --pattern spousal-trade-timing
 *   npx tsx pipeline/score-anomaly.ts --all --pattern trade-vote-alignment
 *
 * Generalized over both live detectors (trade-vote-alignment, spousal-trade-timing).
 * Calendar-randomization null for low-volume members; volume-preserving date
 * shuffle for basket traders. Substrate comes from the shared spine in
 * patterns/_substrate.ts ("one spine, no drift" — the observed statistic and
 * every permutation draw see the SAME trades/votes population). Updates the
 * member's row in pattern_hits in place (the row itself is created by
 * run-patterns; this scorer never invents rows).
 *
 * Governing spec: docs/2026-07-20-timing-detectors-scoring.md.
 */
import { getDb } from '../db/init.js';
import { countNexus, type Trade, type NexusVote } from './patterns/_nexus.js';
import { permutationTest, calendarDraw, volumeShuffleDraw } from './patterns/_permutation.js';
import { mulberry32, seedFrom } from './patterns/_rng.js';
import { tradeVoteSubstrate, spousalSubstrate } from './patterns/_substrate.js';

const WINDOW_DAYS = 14;
const N_PERM = 10_000;
const BASKET_TRADE_THRESHOLD = 50; // >= this many trades -> volume-shuffle null

/** The two live descriptive detectors this scorer covers (spec Scope). */
export const SCORED_PATTERNS = ['trade-vote-alignment', 'spousal-trade-timing'] as const;

export interface ScoreResult {
  nullModel: 'calendar' | 'volume-shuffle';
  observed: number;
  expected: number;
  pValue: number;
  zScore: number;
  nPerm: number;
}

/** Fresh pre-registered seed strings (spec "Seed strings", verbatim). */
function seedString(pattern: string, member: string): string {
  return `${pattern}-preregistered-v1|${member}`;
}

/** DB substrate loader per pattern (the shared spine). */
function substrateFor(pattern: string, member: string): Promise<{ trades: Trade[]; votes: NexusVote[] }> {
  if (pattern === 'trade-vote-alignment') return tradeVoteSubstrate(member);
  if (pattern === 'spousal-trade-timing') return spousalSubstrate(member);
  throw new Error(`score-anomaly: unknown pattern '${pattern}'`);
}

/**
 * PURE core (no DB): observed statistic + null dispatch + permutationTest.
 * Exported for the fixture tests and the Task 4 negative-control harness.
 *
 * The `nPerm` param exists ONLY for test speed and defaults to the
 * pre-registered 10,000; the CLI / scorePattern path never overrides it.
 */
export function computeScore(
  trades: Trade[],
  votes: NexusVote[],
  seedStr: string,
  nPerm: number = N_PERM,
): ScoreResult {
  const observed = countNexus(trades, votes, WINDOW_DAYS);
  const seed = seedFrom(seedStr);
  const rng = mulberry32(seed);

  let nullModel: 'calendar' | 'volume-shuffle';
  let draw: () => number;
  if (trades.length >= BASKET_TRADE_THRESHOLD) {
    nullModel = 'volume-shuffle';
    draw = volumeShuffleDraw(trades, votes, WINDOW_DAYS, rng);
  } else {
    nullModel = 'calendar';
    // Span = min/max over all trade+vote dates (existing score-anomaly logic).
    const dates = [...trades.map(t => t.txDate), ...votes.map(v => v.voteDate)].sort();
    draw = calendarDraw(trades, votes, WINDOW_DAYS, dates[0], dates[dates.length - 1], rng);
  }

  const r = permutationTest({ observed, nPerm, seed, draw });
  return { nullModel, ...r };
}

/**
 * Full DB flow for one (pattern, member): substrate -> row-check -> computeScore
 * -> UPDATE the 6 stat columns. Returns null (and logs) when the member has no
 * pattern_hits row for the pattern (nothing to score — never invents a row).
 * A hit row with an empty substrate is a fail-loud throw (spec: cannot occur).
 */
export async function scorePattern(pattern: string, member: string): Promise<ScoreResult | null> {
  const conn = await getDb();

  // Row existence check BEFORE running 10k permutations — out-of-scope members
  // (zero pattern hits -> no row) are skipped, never scored, never invented.
  const hitRes = await conn.run(
    `SELECT count(*)::int AS n FROM pattern_hits WHERE pattern=? AND member=?`,
    [pattern, member],
  );
  const hitRows = (await hitRes.getRowObjects()) as unknown as { n: number }[];
  if (!hitRows.length || hitRows[0].n === 0) {
    console.log(`${member} [${pattern}]: no pattern_hits row — nothing to score (skipped).`);
    return null;
  }

  const { trades, votes } = await substrateFor(pattern, member);
  if (trades.length === 0) {
    // Spec "Members out of scope": a hit row implies substrate rows; empty here
    // is a fail-loud error, not a skip.
    throw new Error(
      `score-anomaly: ${member} has a ${pattern} pattern_hits row but an empty substrate ` +
        `(spec says this cannot occur — investigate before scoring).`,
    );
  }

  const result = computeScore(trades, votes, seedString(pattern, member));

  await conn.run(
    `UPDATE pattern_hits
        SET null_model=?, observed=?, expected=?, p_value=?, z_score=?, n_perm=?
      WHERE pattern=? AND member=?`,
    [result.nullModel, result.observed, result.expected, result.pValue, result.zScore, result.nPerm, pattern, member],
  );
  console.log(
    `${member} [${pattern}] ${result.nullModel}: trades=${trades.length} observed=${result.observed} ` +
      `expected=${result.expected.toFixed(2)} p=${result.pValue.toFixed(4)} z=${result.zScore.toFixed(2)} ` +
      `(n=${result.nPerm})`,
  );
  return result;
}

/** Members having a pattern_hits row for the given pattern (for --all). */
async function membersWithHit(pattern: string): Promise<string[]> {
  const conn = await getDb();
  const res = await conn.run(
    `SELECT DISTINCT member FROM pattern_hits WHERE pattern=? ORDER BY member`,
    [pattern],
  );
  const rows = (await res.getRowObjects()) as unknown as { member: string }[];
  return rows.map(r => r.member);
}

function argVal(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const patternArg = argVal(args, '--pattern');
  const patterns = patternArg ? [patternArg] : [...SCORED_PATTERNS];
  const all = args.includes('--all');
  const member = argVal(args, '--member');

  if (!all && !member) {
    console.error('usage: score-anomaly.ts (--member <slug> | --all) [--pattern <name>]');
    process.exit(2);
  }

  for (const pattern of patterns) {
    if (!SCORED_PATTERNS.includes(pattern as (typeof SCORED_PATTERNS)[number])) {
      console.error(`unknown pattern '${pattern}' (expected one of ${SCORED_PATTERNS.join(', ')})`);
      process.exit(2);
    }
    const members = all ? await membersWithHit(pattern) : [member!];
    for (const m of members) {
      await scorePattern(pattern, m);
    }
  }
}

// Only run main() as a script, not when imported by tests / the Task 4 harness.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
