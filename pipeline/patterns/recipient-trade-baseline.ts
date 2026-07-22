/**
 * Pre-registered permutation baseline + negative control for the
 * recipient-trade detector (docs/2026-07-17-recipient-trade-detector.md).
 *
 * Null: member↔district shuffle across the in-office House roster, 2,000
 * permutations, fixed seed. Both S1 (breadth) and S2 (exposure) must clear
 * p < 0.05 or the detector is NOT registered — no threshold tuning after.
 *
 * Negative control (runs with the baseline, before any hand-tracing):
 * 20 replicates of the ticker-identity scramble, each rerun through the
 * FULL procedure (ubiquity exclusion recomputed per replicate) with its own
 * 2,000-perm null. Must reliably return null; expect ~1/20 significant by
 * chance — flag if > 2/20 on either statistic.
 *
 * Usage: npx tsx pipeline/patterns/recipient-trade-baseline.ts [nPerm] [seed-string]
 */
import { getDb } from '../../db/init.js';
import { assertConfirmatoryAllowed } from './_confirmatory-guard.js';
import { mulberry32, seedFrom } from './_rng.js';
import { CY_START, CY_END } from './district-contract-trade-alignment.js';
import {
  excludedTickers, districtTickerDollars, rosterStats, scrambleConfirmTickers,
  type ConfirmRow, type RecipientAmount,
} from './recipient-trade-overlap.js';

const N_CONTROL = 20;

interface Substrate {
  memberIds: string[];
  traded: Map<string, Set<string>>;
  districtRows: Map<string, RecipientAmount[]>;
  confirms: ConfirmRow[];
}

async function loadSubstrate(): Promise<Substrate> {
  const conn = await getDb();
  const mRes = await conn.run(
    `SELECT member_id FROM members WHERE chamber='house' AND in_office ORDER BY member_id`,
  );
  const memberIds = ((await mRes.getRowObjects()) as any[]).map((r) => String(r.member_id));

  const traded = new Map<string, Set<string>>();
  for (const m of memberIds) {
    const r = await conn.run(
      `SELECT DISTINCT UPPER(ticker) AS ticker FROM pfd_transactions
        WHERE member_id = ? AND ticker IS NOT NULL AND tx_date BETWEEN ? AND ?
        ORDER BY ticker`,
      [m, `${CY_START}-01-01`, `${CY_END}-12-31`],
    );
    traded.set(m, new Set(((await r.getRowObjects()) as any[]).map((x) => String(x.ticker))));
  }

  const districtRows = new Map<string, RecipientAmount[]>();
  for (const m of memberIds) {
    const r = await conn.run(
      `SELECT recipient_key, SUM(amount) AS amount
         FROM district_contract_recipient
        WHERE member_id = ? AND cy BETWEEN ? AND ?
        GROUP BY recipient_key ORDER BY recipient_key`,
      [m, CY_START, CY_END],
    );
    districtRows.set(m, ((await r.getRowObjects()) as any[]).map((x) => ({
      recipientKey: String(x.recipient_key), amount: Number(x.amount),
    })));
  }

  const cRes = await conn.run(`SELECT recipient_key, ticker FROM recipient_ticker ORDER BY recipient_key`);
  const confirms = ((await cRes.getRowObjects()) as any[]).map((x) => ({
    recipientKey: String(x.recipient_key), ticker: String(x.ticker),
  }));
  return { memberIds, traded, districtRows, confirms };
}

/** Full procedure for one confirm set: exclusion → dollars → observed + null. */
function runProcedure(
  sub: Substrate, confirms: ConfirmRow[], nPerm: number, shuffleSeedStr: string,
): { observed: { s1: number; s2: number }; excluded: Set<string>;
     e1: number; e2: number; z1: number; z2: number; p1: number; p2: number } {
  const { memberIds, traded, districtRows } = sub;
  const excluded = excludedTickers(confirms, districtRows, memberIds.length);
  const cmap = new Map(confirms.map((c) => [c.recipientKey, c.ticker]));
  const dollars = new Map(memberIds.map((m) => [m, districtTickerDollars(districtRows.get(m)!, cmap, excluded)]));

  const observed = rosterStats(memberIds, memberIds, traded, dollars);
  const rng = mulberry32(seedFrom(shuffleSeedStr));
  let ge1 = 0, ge2 = 0, sum1 = 0, sum2 = 0;
  const s1s = new Array<number>(nPerm); const s2s = new Array<number>(nPerm);
  for (let k = 0; k < nPerm; k++) {
    const shuffled = [...memberIds];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const s = rosterStats(memberIds, shuffled, traded, dollars);
    s1s[k] = s.s1; s2s[k] = s.s2; sum1 += s.s1; sum2 += s.s2;
    if (s.s1 >= observed.s1) ge1++;
    if (s.s2 >= observed.s2) ge2++;
  }
  const e1 = sum1 / nPerm, e2 = sum2 / nPerm;
  let v1 = 0, v2 = 0;
  for (let k = 0; k < nPerm; k++) { v1 += (s1s[k] - e1) ** 2; v2 += (s2s[k] - e2) ** 2; }
  const sd1 = Math.sqrt(v1 / nPerm), sd2 = Math.sqrt(v2 / nPerm);
  return {
    observed, excluded, e1, e2,
    z1: sd1 === 0 ? 0 : (observed.s1 - e1) / sd1,
    z2: sd2 === 0 ? 0 : (observed.s2 - e2) / sd2,
    p1: ge1 / nPerm, p2: ge2 / nPerm,
  };
}

const usd = (n: number) => '$' + Math.round(n).toLocaleString();

async function main() {
  // ADR 0003 in-path guard: refuse before any DB/computation if this detector's
  // preregistered confirmatory run is already consumed and not invalidated.
  assertConfirmatoryAllowed(['recipient-trade']);
  const nPerm = parseInt(process.argv[2] ?? '2000', 10);
  const seedStr = process.argv[3] ?? 'recipient-trade-baseline-v1';
  const sub = await loadSubstrate();
  const districtsWithRows = sub.memberIds.filter((m) => (sub.districtRows.get(m)!.length > 0)).length;
  console.log(`  districts with substrate rows: ${districtsWithRows}/${sub.memberIds.length}`);
  if (districtsWithRows < sub.memberIds.length) {
    throw new Error(
      `district substrate incomplete (${districtsWithRows}/${sub.memberIds.length} districts have rows) — ` +
      `finish the harvest before the baseline (no-stub rule)`,
    );
  }
  if (sub.confirms.length === 0) {
    throw new Error('recipient_ticker is empty — curate confirms before running the baseline (no-stub rule)');
  }
  const traders = sub.memberIds.filter((m) => (sub.traded.get(m)?.size ?? 0) > 0);
  console.log(`recipient-trade null baseline`);
  console.log(`  roster: ${sub.memberIds.length} House members (${traders.length} with in-window trades), window CY${CY_START}–${CY_END}`);
  console.log(`  confirms: ${sub.confirms.length} recipient→ticker row(s)`);

  const b = runProcedure(sub, sub.confirms, nPerm, seedStr);
  console.log(`  ubiquity-excluded tickers (> 1/3 of ${sub.memberIds.length} districts): ${b.excluded.size ? [...b.excluded].sort().join(', ') : '(none)'}`);
  console.log(`  observed S1 (breadth):  ${b.observed.s1}`);
  console.log(`  observed S2 (exposure): ${usd(b.observed.s2)}`);
  console.log(`  null (member↔district shuffle, ${nPerm} perms, seed "${seedStr}"):`);
  console.log(`    S1: expected ${b.e1.toFixed(2)}, z=${b.z1.toFixed(2)}, p=${b.p1.toFixed(4)}`);
  console.log(`    S2: expected ${usd(b.e2)}, z=${b.z2.toFixed(2)}, p=${b.p2.toFixed(4)}`);
  console.log(`  gate (both p < 0.05): ${b.p1 < 0.05 && b.p2 < 0.05 ? 'PASS' : 'FAIL'}`);

  console.log(`\nnegative control — ticker-identity scramble, ${N_CONTROL} replicates, full procedure each:`);
  let sig = 0;
  for (let i = 0; i < N_CONTROL; i++) {
    const scrambleRng = mulberry32(seedFrom(`recipient-negative-control-v1-${i}`));
    const scrambled = scrambleConfirmTickers(sub.confirms, scrambleRng);
    const c = runProcedure(sub, scrambled, nPerm, `recipient-negative-control-shuffle-v1-${i}`);
    const flag = c.p1 < 0.05 || c.p2 < 0.05;
    if (flag) sig++;
    console.log(`  rep ${String(i).padStart(2)}: S1 obs ${c.observed.s1} p=${c.p1.toFixed(4)} | S2 obs ${usd(c.observed.s2)} p=${c.p2.toFixed(4)}${flag ? '  *' : ''}`);
  }
  console.log(`  significant replicates: ${sig}/${N_CONTROL} (expect ~1 by chance; > 2 means the detector reads marginals — investigate before ANY use)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message ?? e); process.exit(1); });
