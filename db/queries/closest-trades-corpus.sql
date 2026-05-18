-- Trades closest in time to a same-member vote, corpus-wide.
-- Neutral framing — no editorial scoring, no "suspicion" rank. Readers filter
-- on whichever signal columns they care about (amount band, asset type, etc).
-- Two parameters: window_days_max, row_limit.
SELECT * FROM v_trades_near_votes
WHERE days_abs <= ?
  AND match_confidence >= 0.95
ORDER BY days_abs ASC, tx_date DESC
LIMIT ?;
