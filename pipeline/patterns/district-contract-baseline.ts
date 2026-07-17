/**
 * Permutation null baseline for district-contract-trade-alignment.
 *
 * Null model: member↔district assignment is shuffled across the House roster —
 * each member's trades are scored against a random OTHER member's district
 * contract mix using EXACTLY the shipped decision procedure
 * (qualifyingThemes, imported — one spine, no drift). If districts and trading
 * themes were unrelated, real hit counts should look like shuffled ones; the
 * detector discriminates only if the observed count clears the null.
 *
 * Step-0 rule: this baseline gates the thresholds — record the result in
 * docs/2026-07-15-district-contracts-detector.md before render work.
 *
 * Usage: npx tsx pipeline/patterns/district-contract-baseline.ts [nPerm] [seed-string]
 */

import { getDb } from '../../db/init.js';
import { mulberry32, seedFrom } from './_rng.js';
import { permutationTest } from './_permutation.js';
import {
  CONTRACT_SQL, TRADES_SQL, CY_START, CY_END,
  qualifyingThemes, themeMedianShares, type ContractTheme,
} from './district-contract-trade-alignment.js';

async function main() {
  const nPerm = parseInt(process.argv[2] ?? '2000', 10);
  const seedStr = process.argv[3] ?? 'district-contract-baseline-v1';
  const conn = await getDb();

  const mRes = await conn.run(
    `SELECT member_id FROM members WHERE chamber='house' AND in_office ORDER BY member_id`,
  );
  const members = ((await mRes.getRowObjects()) as any[]).map((r) => String(r.member_id));

  // Precompute both sides once; shuffles are then pure in-memory.
  const contracts = new Map<string, ContractTheme[]>();
  const tradeCounts = new Map<string, Map<string, number>>();
  for (const m of members) {
    const cRes = await conn.run(CONTRACT_SQL, [m, CY_START, CY_END]);
    contracts.set(m, (await cRes.getRowObjects()) as unknown as ContractTheme[]);
    const tRes = await conn.run(TRADES_SQL, [m, `${CY_START}-01-01`, `${CY_END}-12-31`]);
    const counts = new Map<string, number>();
    for (const t of (await tRes.getRowObjects()) as any[]) {
      counts.set(t.theme, (counts.get(t.theme) ?? 0) + 1);
    }
    tradeCounts.set(m, counts);
  }

  // Roster medians are a property of the fixed set of districts — invariant
  // under the member↔district shuffle, so the null test stays fair.
  const medianShares = themeMedianShares(contracts);

  const hitCount = (assignment: string[]): number => {
    let n = 0;
    for (let i = 0; i < members.length; i++) {
      const themes = qualifyingThemes(
        contracts.get(assignment[i])!,
        tradeCounts.get(members[i])!,
        medianShares,
      );
      if (themes.length > 0) n++;
    }
    return n;
  };

  const observed = hitCount(members);

  const seed = seedFrom(seedStr);
  const rng = mulberry32(seed);
  const draw = (): number => {
    const shuffled = [...members];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return hitCount(shuffled);
  };

  const res = permutationTest({ observed, nPerm, seed, draw });
  console.log(`district-contract-trade-alignment null baseline`);
  console.log(`  roster: ${members.length} House members, window CY${CY_START}–${CY_END}`);
  console.log(`  observed members-with-hit: ${res.observed}`);
  console.log(`  null (member↔district shuffle, ${res.nPerm} perms, seed "${seedStr}"):`);
  console.log(`    expected ${res.expected.toFixed(2)}, z=${res.zScore.toFixed(2)}, p=${res.pValue.toFixed(4)}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
