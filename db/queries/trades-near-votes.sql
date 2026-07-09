-- Trades by a single member, ordered by date proximity to that member's own
-- votes. Two parameters: member_id, window_days_max.
--
-- Capped per trade at the SQL boundary: heavy traders otherwise produce
-- 100k+ exploded trade×vote rows that OOM the JS heap on materialization.
-- Trade identity includes tx_type (repo convention: filing|date|type|instrument)
-- — a same-day purchase+sale of one ticker is two trades, not one.
-- The renderer collapses to per-trade cards needing only the closest rows,
-- the closest on-committee row, and the true pair count (window_vote_count).
SELECT * FROM (
  SELECT v.*,
    COUNT(*) OVER (PARTITION BY trade_filing_id, tx_date, tx_type, asset, ticker) AS window_vote_count,
    ROW_NUMBER() OVER (PARTITION BY trade_filing_id, tx_date, tx_type, asset, ticker
      ORDER BY days_abs ASC, tx_date DESC, trade_filing_id ASC, vote_id ASC,
               ticker ASC, asset ASC, tx_type ASC, amount_band ASC, holder ASC) AS rn_close,
    ROW_NUMBER() OVER (PARTITION BY trade_filing_id, tx_date, tx_type, asset, ticker
      ORDER BY member_on_bill_committee DESC, days_abs ASC, vote_id ASC, tx_type ASC, amount_band ASC, holder ASC) AS rn_cmte
  FROM v_trades_near_votes v
  WHERE member_id = ?
    AND days_abs <= ?
)
WHERE rn_close <= 6 OR (member_on_bill_committee AND rn_cmte = 1)
ORDER BY days_abs ASC, tx_date DESC,
         trade_filing_id ASC, vote_id ASC, ticker ASC, asset ASC,
         tx_type ASC, amount_band ASC, holder ASC;
