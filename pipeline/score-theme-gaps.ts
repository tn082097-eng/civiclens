/**
 * Lane-1 scorer: theme-gated trade->vote receipts with a per-pair lower-tail
 * null and statistical-honesty power bands. Mirrors score-anomaly.ts but scores
 * PER PAIR (gap, lower tail) instead of a member-level count.
 *   npx tsx pipeline/score-theme-gaps.ts --member nancy-pelosi
 */
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDb, DB_PATH } from '../db/init.js';
import { perPairLowerTail, type ThemeTrade, type ThemeVote } from './patterns/_gap.js';
import { mulberry32, seedFrom } from './patterns/_rng.js';
import { ThemeGapReceiptsSchema, type ThemeGapReceipts } from '../lib/schemas.js';

const WINDOW_DAYS = 90;
const N_PERM = 10_000;
const BASKET_TRADE_THRESHOLD = 50;
const MIN_TRADES_RANKED = 10;
const MIN_TRADES_POWER = 5;

export type Band = 'insufficient-data' | 'low-power' | 'ranked';
export function bandFor(tradeCount: number): Band {
  if (tradeCount < MIN_TRADES_POWER) return 'insufficient-data';
  if (tradeCount < MIN_TRADES_RANKED) return 'low-power';
  return 'ranked';
}

export interface NexusRow {
  theme: string;
  tradeFilingId: string;
  ticker: string;
  txType: string;
  txDate: string;
  voteId: string;
  voteDate: string;
  billId: string;
  billTitle: string;
  daysBeforeVote: number;
  tradeSourceUrl: string;
  voteSourceUrl: string;
  billSourceUrl: string;
}

export function assembleReceipts(input: {
  memberId: string;
  tradeCount: number;            // theme-mappable = band denominator
  disclosedTradeCount: number;   // raw PTR rows, coverage strip only
  windowDays: number;
  nPerm: number;
  coverage: { votesTotal: number; votesBillLinked: number };
  nexusRows: NexusRow[];
  pByTrade: Map<string, number>;
}): ThemeGapReceipts {
  const band = bandFor(input.tradeCount);
  const receipts = input.nexusRows.map(r => ({
    ...r,
    pPair: band === 'insufficient-data' ? null : (input.pByTrade.get(r.tradeFilingId) ?? null),
  }));
  receipts.sort((a, b) =>
    band === 'ranked'
      ? (a.pPair ?? 1) - (b.pPair ?? 1) || a.txDate.localeCompare(b.txDate)
      : a.txDate.localeCompare(b.txDate),
  );
  const art: ThemeGapReceipts = {
    memberId: input.memberId,
    tradeCount: input.tradeCount,
    disclosedTradeCount: input.disclosedTradeCount,
    band,
    nPerm: input.nPerm,
    windowDays: input.windowDays,
    coverage: input.coverage,
    receipts,
  };
  return ThemeGapReceiptsSchema.parse(art);
}

/** Observed gap per trade = the closest guarded vote (min days_before_vote across its nexus rows). */
export function observedGaps(nexusRows: NexusRow[]): Map<string, number> {
  const g = new Map<string, number>();
  for (const r of nexusRows) {
    const cur = g.get(r.tradeFilingId);
    if (cur === undefined || r.daysBeforeVote < cur) g.set(r.tradeFilingId, r.daysBeforeVote);
  }
  return g;
}

// --- DB glue (not unit-tested; exercised by --member runs) ---

async function loadMember(member: string): Promise<{
  nexusRows: NexusRow[];
  trades: ThemeTrade[];
  votes: ThemeVote[];
  tradeCount: number;
  disclosedTradeCount: number;
  coverage: { votesTotal: number; votesBillLinked: number };
}> {
  const conn = await getDb();
  // v_trade_bill_nexus has no trade_filing_id column; a trade's identity is its
  // (date, type, instrument) tuple (mirrors score-anomaly's assemble() key). We
  // synthesize the same composite key here AND in the disclosed-trade query below
  // so observedGaps keys join cleanly onto perPairLowerTail's pByTrade keys.
  const nx = (await (await conn.run(
    `SELECT theme,
            concat_ws('|', tx_date::text, tx_type, UPPER(COALESCE(ticker, asset))) AS "tradeFilingId",
            UPPER(COALESCE(ticker, asset)) AS ticker, tx_type AS "txType",
            tx_date::text AS "txDate", vote_id::text AS "voteId", vote_date::text AS "voteDate",
            bill_id AS "billId", bill_title AS "billTitle", days_before_vote::int AS "daysBeforeVote",
            trade_source_url AS "tradeSourceUrl", vote_source_url AS "voteSourceUrl", bill_source_url AS "billSourceUrl"
       FROM v_trade_bill_nexus WHERE member_id = ?
      ORDER BY "tradeFilingId", "txDate", ticker, "voteId"`,
    [member],
  )).getRowObjects()) as unknown as NexusRow[];

  // Full disclosed trade set (band denominator + null population), with theme.
  // id is the SAME composite key the nexus query builds, so observed gaps map back.
  const trades = (await (await conn.run(
    `SELECT concat_ws('|', p.tx_date::text, p.tx_type, UPPER(COALESCE(p.ticker, p.asset))) AS id,
            p.tx_date::text AS "txDate",
            COALESCE(o.theme, st.theme) AS theme
       FROM pfd_transactions p
       JOIN ticker_sectors ts ON ts.ticker = UPPER(p.ticker)
       LEFT JOIN sic_theme st ON st.sic = ts.sic
       LEFT JOIN ticker_theme_override o ON o.ticker = UPPER(p.ticker)
      WHERE p.member_id = ? AND p.tx_date IS NOT NULL AND COALESCE(o.theme, st.theme) IS NOT NULL
      ORDER BY "txDate", id`,
    [member],
  )).getRowObjects()) as unknown as ThemeTrade[];

  // Null vote population: trade-INDEPENDENT theme-eligible votes (the review fix).
  const votes = (await (await conn.run(
    `SELECT vote_id::text AS id, vote_date::text AS "voteDate", theme
       FROM v_theme_eligible_votes WHERE member_id = ?`,
    [member],
  )).getRowObjects()) as unknown as ThemeVote[];

  const disclosed = (await (await conn.run(
    `SELECT count(*)::int AS c FROM pfd_transactions WHERE member_id = ?`,
    [member],
  )).getRowObjects())[0] as unknown as { c: number };

  const cov = (await (await conn.run(
    `SELECT count(*)::int AS "votesTotal",
            count(*) FILTER (WHERE bill_id IS NOT NULL)::int AS "votesBillLinked"
       FROM votes WHERE member_id = ?`,
    [member],
  )).getRowObjects())[0] as unknown as { votesTotal: number; votesBillLinked: number };

  return {
    nexusRows: nx, trades, votes,
    tradeCount: trades.length, disclosedTradeCount: disclosed.c, coverage: cov,
  };
}

async function scoreMember(member: string): Promise<void> {
  const { nexusRows, trades, votes, tradeCount, disclosedTradeCount, coverage } = await loadMember(member);
  const band = bandFor(tradeCount);

  let pByTrade = new Map<string, number>();
  if (band !== 'insufficient-data' && trades.length > 0) {
    // Observed = the GUARDED pair's gap (closest nexus vote per trade), not a loose recompute.
    const observed = observedGaps(nexusRows);
    const rng = mulberry32(seedFrom(`theme-gap|${member}`));
    const mode = trades.length >= BASKET_TRADE_THRESHOLD ? 'volume-shuffle' : 'calendar';
    const all = [...trades.map(t => t.txDate), ...votes.map(v => v.voteDate)].sort();
    // Null reshuffles the full theme-mappable trade set; recomputes gaps against the
    // trade-independent eligible-vote population. Observed stays the guarded gap.
    pByTrade = perPairLowerTail({
      trades, votes, windowDays: WINDOW_DAYS, observed, nPerm: N_PERM, rng, mode,
      windowStart: all[0], windowEnd: all[all.length - 1],
    });
  }

  const art = assembleReceipts({
    memberId: member, tradeCount, disclosedTradeCount,
    windowDays: WINDOW_DAYS, nPerm: N_PERM, coverage, nexusRows, pByTrade,
  });
  const out = `pipeline/artifacts/${member}.theme-gaps.json`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(art, null, 2));
  console.log(`${member} [${band}]: trades=${tradeCount} receipts=${art.receipts.length} -> ${out}`);
}

// Artifact is fresh if it exists and is newer than the DuckDB file (the only input).
function isFresh(member: string): boolean {
  const out = `pipeline/artifacts/${member}.theme-gaps.json`;
  return existsSync(out) && existsSync(DB_PATH) && statSync(out).mtimeMs > statSync(DB_PATH).mtimeMs;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const i = args.indexOf('--member');
  if (args.includes('--all')) {
    const conn = await getDb();
    const rows = (await (await conn.run(
      `SELECT member_id FROM members ORDER BY member_id`)).getRowObjects()) as unknown as { member_id: string }[];
    let skipped = 0;
    for (const { member_id } of rows) {
      if (!force && isFresh(member_id)) { skipped++; continue; }
      await scoreMember(member_id);
    }
    console.log(`--all done: ${rows.length - skipped} scored, ${skipped} fresh (skipped; --force to redo)`);
    return;
  }
  if (i === -1 || !args[i + 1]) {
    console.error('usage: score-theme-gaps.ts --member <slug> [--force] | --all [--force]');
    process.exit(2);
  }
  const member = args[i + 1];
  if (!force && isFresh(member)) {
    console.log(`${member}: artifact fresh (newer than DB); skipping. Use --force to recompute.`);
    return;
  }
  await scoreMember(member);
}

// Only run main() as a script, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
