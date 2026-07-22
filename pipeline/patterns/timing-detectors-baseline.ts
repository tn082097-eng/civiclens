/**
 * Pre-registered NEGATIVE CONTROL for the two live timing detectors
 * (trade-vote-alignment, spousal-trade-timing).
 *
 * Machinery-validity gate (the only HARD gate in the scoring spec,
 * docs/2026-07-20-timing-detectors-scoring.md "Negative control"): it runs and
 * is evaluated BEFORE the formal scoring run. Vote-attribute scramble destroys
 * the real pairing between trade timing and which votes carry a nexus while
 * preserving every marginal the null conditions on (trade dates/cadence, vote
 * density, committee-vote count, named-ticker multiset). A machinery that flags
 * scrambled data is reading marginals, not timing.
 *
 * For each detector × each roster member with non-empty substrate: 20 replicates
 * through the FULL procedure — scramble, fresh observed S, fresh 10,000-perm
 * null — with the spec's verbatim replicate-indexed seeds. Pre-registered pass
 * criterion: pooled false-positive rate across all (member, replicate) pairs
 * <= 10% AND no single member > 4/20 significant replicates. Either exceeded ->
 * MACHINERY GATE: FAIL.
 *
 * Reuses the Task 2 pure scoring core (computeScore) — no duplicated
 * observed/dispatch/permutation logic. Console-only; the run is `| tee`'d to the
 * audit dir. Never touch data/civiclens.duckdb outside the gated run.
 *
 * Usage: npx tsx pipeline/patterns/timing-detectors-baseline.ts [nPerm=10000] [seed-prefix]
 */

import { listMembers } from '../../db/queries.js';
import { assertConfirmatoryAllowed } from './_confirmatory-guard.js';
import { mulberry32, seedFrom } from './_rng.js';
import type { Trade, NexusVote } from './_nexus.js';
import { tradeVoteSubstrate, spousalSubstrate } from './_substrate.js';
import { computeScore, SCORED_PATTERNS, type ScoreResult } from '../score-anomaly.js';

const N_CONTROL = 20;
const N_PERM_DEFAULT = 10_000;
const ALPHA = 0.05;

/** Pre-registered criterion constants (spec "Pass criterion"). */
const POOLED_MAX = 0.10; // pooled false-positive rate ceiling
const PER_MEMBER_MAX = 4; // a single member may not exceed this many /20

const SUBSTRATE: Record<string, (m: string) => Promise<{ trades: Trade[]; votes: NexusVote[] }>> = {
  'trade-vote-alignment': tradeVoteSubstrate,
  'spousal-trade-timing': spousalSubstrate,
};

/**
 * Permute the (committee, namedTickers) attribute TUPLES across the vote set.
 * Vote id and date stay at their index; the two attributes travel together as a
 * unit. Fisher-Yates on the tuple array, seeded by `rng`. Pure — never mutates
 * the input.
 */
export function scrambleVoteAttributes(votes: NexusVote[], rng: () => number): NexusVote[] {
  const tuples = votes.map(v => ({ committee: v.committee, namedTickers: v.namedTickers }));
  for (let i = tuples.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = tuples[i];
    tuples[i] = tuples[j];
    tuples[j] = tmp;
  }
  return votes.map((v, i) => ({
    id: v.id,
    voteDate: v.voteDate,
    committee: tuples[i].committee,
    namedTickers: tuples[i].namedTickers,
  }));
}

/**
 * One negative-control replicate through the full procedure: scramble the votes
 * with `scrambleSeed`, then fresh scoring (observed + dispatch + permutation
 * null) via the Task 2 pure core with `nullSeed`.
 */
export function runControlReplicate(
  trades: Trade[],
  votes: NexusVote[],
  scrambleSeed: string,
  nullSeed: string,
  nPerm: number = N_PERM_DEFAULT,
): ScoreResult {
  const scrambled = scrambleVoteAttributes(votes, mulberry32(seedFrom(scrambleSeed)));
  return computeScore(trades, scrambled, nullSeed, nPerm);
}

/**
 * Pre-registered verdict: PASS iff pooled significant-rate <= 10% AND no single
 * member exceeds 4/20 significant replicates.
 */
export function evaluateVerdict(
  perMember: { member: string; sig: number }[],
  nReplicates: number,
): { pass: boolean; pooledRate: number; totalSig: number; worst: { member: string; sig: number } | null } {
  const totalSig = perMember.reduce((n, m) => n + m.sig, 0);
  const totalPairs = perMember.length * nReplicates;
  const pooledRate = totalPairs === 0 ? 0 : totalSig / totalPairs;
  const worst = perMember.reduce<{ member: string; sig: number } | null>(
    (w, m) => (w === null || m.sig > w.sig ? m : w),
    null,
  );
  const pass = pooledRate <= POOLED_MAX && (worst === null || worst.sig <= PER_MEMBER_MAX);
  return { pass, pooledRate, totalSig, worst };
}

/** Verbatim seed strings (spec "Seed strings" / negative-control section). */
const scrambleSeed = (pattern: string, i: number, member: string) => `${pattern}-nc-scramble-v1-${i}|${member}`;
const nullSeed = (pattern: string, i: number, member: string) => `${pattern}-nc-null-v1-${i}|${member}`;

async function main(): Promise<void> {
  // ADR 0003 in-path guard: refuse before any DB/computation if either timing
  // detector's preregistered confirmatory run is already consumed.
  assertConfirmatoryAllowed([...SCORED_PATTERNS]);
  const nPerm = parseInt(process.argv[2] ?? String(N_PERM_DEFAULT), 10);
  const roster = (await listMembers()).map(m => m.member_id);

  console.log('timing-detectors negative control (vote-attribute scramble)');
  console.log(`  roster: ${roster.length} member(s)`);
  console.log(`  detectors: ${SCORED_PATTERNS.join(', ')}`);
  console.log(`  ${N_CONTROL} replicates/(detector,member); nPerm=${nPerm}; alpha=${ALPHA}`);
  console.log(`  criterion: pooled <= ${(POOLED_MAX * 100).toFixed(0)}% AND no member > ${PER_MEMBER_MAX}/${N_CONTROL}`);

  const allPerMember: { member: string; sig: number }[] = [];
  let membersWithSubstrate = 0;

  for (const pattern of SCORED_PATTERNS) {
    const loader = SUBSTRATE[pattern];
    const perMember: { member: string; sig: number }[] = [];
    console.log(`\n▸ ${pattern}`);

    for (const member of roster) {
      const { trades, votes } = await loader(member);
      if (trades.length === 0) continue; // out of scope for this detector
      membersWithSubstrate++;

      let sig = 0;
      for (let i = 0; i < N_CONTROL; i++) {
        const r = runControlReplicate(
          trades,
          votes,
          scrambleSeed(pattern, i, member),
          nullSeed(pattern, i, member),
          nPerm,
        );
        if (r.pValue < ALPHA) sig++;
      }
      perMember.push({ member, sig });
      allPerMember.push({ member: `${pattern}|${member}`, sig });
      console.log(`  ${member.padEnd(32)} ${String(sig).padStart(2)}/${N_CONTROL} sig` + (sig > PER_MEMBER_MAX ? '  *' : ''));
    }

    if (perMember.length === 0) {
      console.log('  (no members with non-empty substrate)');
    }
  }

  // Fail-loud: the whole roster produced no substrate for either detector.
  if (membersWithSubstrate === 0) {
    throw new Error(
      'no roster member has non-empty substrate for either timing detector — ' +
        'load PFD/vote data before the control run (no-stub rule)',
    );
  }

  const verdict = evaluateVerdict(allPerMember, N_CONTROL);
  console.log('\n── summary ──');
  console.log(`  (detector,member) cells: ${allPerMember.length}`);
  console.log(`  total significant: ${verdict.totalSig}/${allPerMember.length * N_CONTROL} pairs`);
  console.log(`  pooled false-positive rate: ${(verdict.pooledRate * 100).toFixed(2)}% (expect ~${(ALPHA * 100).toFixed(0)}%)`);
  if (verdict.worst) {
    console.log(`  worst member: ${verdict.worst.member} at ${verdict.worst.sig}/${N_CONTROL}`);
  }
  console.log(`\nMACHINERY GATE: ${verdict.pass ? 'PASS' : 'FAIL'}`);
  if (!verdict.pass) {
    console.log('  FAIL -> formal results are NOT published; investigate + dated outcome-blind amendment before any rerun (spec).');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch(e => {
      console.error(e.message ?? e);
      process.exit(1);
    });
}
