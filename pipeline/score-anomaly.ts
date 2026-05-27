/**
 * Rigor pillar: score the trade-vote-alignment detector with a null model.
 *   npx tsx pipeline/score-anomaly.ts --member pramila-jayapal
 *   npx tsx pipeline/score-anomaly.ts --member marjorie-taylor-greene
 *
 * Calendar-randomization null for low-volume members; volume-preserving date
 * shuffle for basket traders. Updates the member's trade-vote-alignment row in
 * pattern_hits in place (the row itself is created by run-patterns).
 */
import { getDb } from '../db/init.js';
import { COMMON_WORD_TICKERS } from './patterns/_filters.js';
import { countNexus, type Trade, type NexusVote } from './patterns/_nexus.js';
import { permutationTest, calendarDraw, volumeShuffleDraw } from './patterns/_permutation.js';
import { mulberry32, seedFrom } from './patterns/_rng.js';

const PATTERN = 'trade-vote-alignment';
const WINDOW_DAYS = 14;
const N_PERM = 10_000;
const COMMON = new Set(COMMON_WORD_TICKERS);
const BASKET_TRADE_THRESHOLD = 50; // >= this many trades -> volume-shuffle null

interface Row {
  filing_id: string;
  tx_date: string;
  tx_type: string;
  instrument: string;
  vote_id: string;
  vote_date: string;
  member_on_bill_committee: boolean;
  bill_mentions_ticker: boolean;
}

const SQL = `
SELECT
  trade_filing_id::text AS filing_id,
  tx_date::text         AS tx_date,
  tx_type,
  UPPER(COALESCE(ticker, asset)) AS instrument,
  vote_id::text         AS vote_id,
  vote_date::text       AS vote_date,
  member_on_bill_committee,
  bill_mentions_ticker
FROM v_suspicious_trades
WHERE member_id = ?
`;

function assemble(rows: Row[]): { trades: Trade[]; votes: NexusVote[] } {
  const tradeMap = new Map<string, Trade>();
  const voteMap = new Map<string, NexusVote>();
  for (const r of rows) {
    const tKey = `${r.filing_id}|${r.tx_date}|${r.tx_type}|${r.instrument}`;
    if (!tradeMap.has(tKey)) {
      tradeMap.set(tKey, { id: tKey, txDate: r.tx_date, ticker: r.instrument });
    }
    let v = voteMap.get(r.vote_id);
    if (!v) {
      v = { id: r.vote_id, voteDate: r.vote_date, committee: false, namedTickers: [] };
      voteMap.set(r.vote_id, v);
    }
    if (r.member_on_bill_committee) v.committee = true;
    if (
      r.bill_mentions_ticker &&
      !COMMON.has(r.instrument) &&
      !v.namedTickers.includes(r.instrument)
    ) {
      v.namedTickers.push(r.instrument);
    }
  }
  return { trades: [...tradeMap.values()], votes: [...voteMap.values()] };
}

async function scoreMember(member: string): Promise<void> {
  const conn = await getDb();
  const res = await conn.run(SQL, [member]);
  const rows = (await res.getRowObjects()) as unknown as Row[];
  const { trades, votes } = assemble(rows);

  if (trades.length === 0) {
    console.log(`${member}: no qualifying trades — nothing to score.`);
    return;
  }

  const observed = countNexus(trades, votes, WINDOW_DAYS);
  const seed = seedFrom(`${PATTERN}|${member}`);
  const rng = mulberry32(seed);

  let nullModel: 'calendar' | 'volume-shuffle';
  let draw: () => number;
  if (trades.length >= BASKET_TRADE_THRESHOLD) {
    nullModel = 'volume-shuffle';
    draw = volumeShuffleDraw(trades, votes, WINDOW_DAYS, rng);
  } else {
    nullModel = 'calendar';
    const dates = [...trades.map(t => t.txDate), ...votes.map(v => v.voteDate)].sort();
    draw = calendarDraw(trades, votes, WINDOW_DAYS, dates[0], dates[dates.length - 1], rng);
  }

  const r = permutationTest({ observed, nPerm: N_PERM, seed, draw });

  await conn.run(
    `UPDATE pattern_hits
        SET null_model=?, observed=?, expected=?, p_value=?, z_score=?, n_perm=?
      WHERE pattern=? AND member=?`,
    [nullModel, r.observed, r.expected, r.pValue, r.zScore, r.nPerm, PATTERN, member],
  );
  console.log(
    `${member} [${nullModel}]: trades=${trades.length} observed=${r.observed} ` +
      `expected=${r.expected.toFixed(2)} p=${r.pValue.toFixed(4)} z=${r.zScore.toFixed(2)} (n=${r.nPerm})`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--member');
  if (i === -1 || !args[i + 1]) {
    console.error('usage: score-anomaly.ts --member <slug>');
    process.exit(2);
  }
  await scoreMember(args[i + 1]);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
