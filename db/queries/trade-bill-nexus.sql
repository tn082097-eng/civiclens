-- Trade↔bill nexus instances: qualifying (trade, bill) pairs where the traded
-- ticker's industry theme intersects the bill's topic, the trade preceded the
-- vote, and broad vehicles are excluded (see v_trade_bill_nexus in schema.sql).
-- Ranked by trade-to-vote proximity (closest first) — a raw fact, not a score.
-- Dates cast to text for safe string/JSON rendering.
SELECT
  member_id, member_name,
  CAST(tx_date AS VARCHAR)   AS tx_date,
  tx_type, ticker, asset, amount_band,
  sic_description, theme,
  bill_id, bill_title,
  CAST(vote_date AS VARCHAR) AS vote_date,
  vote_question, vote_position, days_before_vote,
  trade_source_url, vote_source_url, bill_source_url
FROM v_trade_bill_nexus
ORDER BY days_before_vote ASC, member_name ASC, tx_date DESC,
         member_id ASC, vote_id ASC, ticker ASC, asset ASC, bill_id ASC;
