/**
 * Pure (no-DB) tests for the shared trade-vote substrate module.
 *
 * These protect the "one spine, no drift" invariant: the null scorer and the
 * detectors must assemble the SAME trades/votes population from the SAME rows.
 * DB queries (tradeVoteSubstrate / spousalSubstrate) are NOT tested here — the
 * pre-registration gate forbids running any pipeline CLI against the live DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleTradeVote, assembleSpousal, type SubstrateRow } from './_substrate.js';
import { countNexus } from './_nexus.js';

/** Minimal row builder; SQL uppercases `instrument`, so callers pass it as-is. */
const R = (o: Partial<SubstrateRow>): SubstrateRow => ({
  filing_id: 'f1',
  tx_date: '2024-01-01',
  tx_type: 'P',
  instrument: 'NVDA',
  vote_id: 'v1',
  vote_date: '2024-01-05',
  member_on_bill_committee: false,
  bill_mentions_ticker: false,
  ...o,
});

// (a) Spine reconciliation: assemble + countNexus(14) equals the hand-computed
//     distinct-trade count. Three distinct trades, two of which have a nexus
//     vote in [tx, tx+14].
test('spine: assembleTradeVote + countNexus equals hand-computed distinct-trade count', () => {
  const rows: SubstrateRow[] = [
    // t1 NVDA — committee vote 4 days later -> nexus
    R({ filing_id: 'f1', tx_date: '2024-01-01', tx_type: 'P', instrument: 'NVDA',
        vote_id: 'v1', vote_date: '2024-01-05', member_on_bill_committee: true }),
    // t2 AAPL — bill names AAPL 3 days later -> nexus
    R({ filing_id: 'f2', tx_date: '2024-02-01', tx_type: 'P', instrument: 'AAPL',
        vote_id: 'v2', vote_date: '2024-02-04', bill_mentions_ticker: true }),
    // t3 TSLA — matched vote is 30 days later -> NO nexus
    R({ filing_id: 'f3', tx_date: '2024-03-01', tx_type: 'P', instrument: 'TSLA',
        vote_id: 'v3', vote_date: '2024-03-31', member_on_bill_committee: true }),
  ];
  const { trades, votes } = assembleTradeVote(rows);
  assert.equal(trades.length, 3, 'three distinct trades');
  assert.equal(countNexus(trades, votes, 14), 2, 'two trades have a nexus vote in-window');
});

// (b) Mixed-case dedupe: two rows identical except instrument case collapse to
//     one trade. RED against a keyer that does not uppercase.
test('dedupe: rows differing only by instrument case collapse to one trade', () => {
  const rows: SubstrateRow[] = [
    R({ instrument: 'Nvda', vote_id: 'v1' }),
    R({ instrument: 'NVDA', vote_id: 'v2' }),
  ];
  const { trades } = assembleTradeVote(rows);
  assert.equal(trades.length, 1, 'Nvda and NVDA are the same instrument');
  assert.equal(trades[0].ticker, 'NVDA', 'ticker is upper-cased');
});

// (c) assembleSpousal: votes always carry namedTickers:[] even when the row
//     says the bill mentions the ticker; committee flag ORs across rows per vote.
test('spousal: votes are committee-only, namedTickers always empty', () => {
  const rows: SubstrateRow[] = [
    // same vote seen twice: first row not-committee, second row committee -> OR true
    R({ filing_id: 'f1', vote_id: 'v1', member_on_bill_committee: false, bill_mentions_ticker: true }),
    R({ filing_id: 'f2', vote_id: 'v1', member_on_bill_committee: true, bill_mentions_ticker: true }),
  ];
  const { votes } = assembleSpousal(rows);
  assert.equal(votes.length, 1);
  assert.equal(votes[0].committee, true, 'committee ORs across rows');
  assert.deepEqual(votes[0].namedTickers, [], 'spousal never has a ticker-text path');
});

// (d) Common-word guard: a bill_mentions_ticker row whose instrument is a
//     common English word does NOT add to namedTickers.
test('trade-vote: common-word ticker is excluded from namedTickers', () => {
  const rows: SubstrateRow[] = [
    R({ instrument: 'NOW', vote_id: 'v1', bill_mentions_ticker: true }),
  ];
  const { votes } = assembleTradeVote(rows);
  assert.equal(votes.length, 1);
  assert.deepEqual(votes[0].namedTickers, [], "'NOW' is a common word, not a named ticker");
});

test('trade-vote: real named ticker is added to namedTickers (guard control)', () => {
  const rows: SubstrateRow[] = [
    R({ instrument: 'NVDA', vote_id: 'v1', bill_mentions_ticker: true }),
  ];
  const { votes } = assembleTradeVote(rows);
  assert.deepEqual(votes[0].namedTickers, ['NVDA']);
});
