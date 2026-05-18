-- Trades by a single member, ordered by date proximity to that member's own
-- votes. Two parameters: member_id, window_days_max.
SELECT * FROM v_trades_near_votes
WHERE member_id = ?
  AND days_abs <= ?
ORDER BY days_abs ASC, tx_date DESC;
