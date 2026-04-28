-- CivicLens DuckDB schema.
-- Single source of truth for the corpus. Each table is per-source; joins
-- happen at query time, not at fetch time.
--
-- Conventions:
--   member_id   = lowercased "first-last" slug (matches Connection Mapper today)
--   fetched_at  = when this row was last refreshed from its primary source
--   source_url  = the canonical primary-source URL the row was derived from
--   *_canonical = lowercased / entity-stripped form for fuzzy matching
--
-- Per-source tables are append-friendly via PRIMARY KEY upsert; freshness is
-- determined by `fetched_at`, not by table existence.

-- ─── Members (the spine) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS members (
  member_id           TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  party               TEXT,
  chamber             TEXT,
  state               TEXT,
  district            TEXT,
  role                TEXT,
  in_office           BOOLEAN,
  first_elected_year  INTEGER,
  bioguide_id         TEXT,
  fec_candidate_id    TEXT,
  trade_activity      TEXT,
  bio_summary         TEXT,
  bio_source_url      TEXT,
  fetched_at          TIMESTAMP NOT NULL
);

-- ─── Donors (lifetime cumulative across cycles) ─────────────────────────────
CREATE TABLE IF NOT EXISTS donors (
  member_id           TEXT NOT NULL,
  donor_name          TEXT NOT NULL,
  donor_canonical     TEXT NOT NULL,
  donor_type          TEXT,                 -- individual | pac | corporation
  amount              DOUBLE NOT NULL,      -- cumulative across cycles
  latest_date         DATE,
  cycles              INTEGER[],
  source              TEXT,
  source_url          TEXT,
  confidence          DOUBLE,
  fetched_at          TIMESTAMP NOT NULL,
  PRIMARY KEY (member_id, donor_canonical)
);

-- ─── Votes ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS votes (
  member_id     TEXT NOT NULL,
  vote_id       TEXT NOT NULL,        -- govtrack vote id
  date          DATE,
  question      TEXT,
  position      TEXT,                 -- Yea | Nay | Present | Not Voting
  category      TEXT,                 -- passage | amendment | nomination | cloture | ...
  party_position TEXT,
  bill_number   TEXT,                 -- legacy, e.g. "H.R. 8752"
  bill_id       TEXT,                 -- canonical Congress.gov key, e.g. "118-hr-8752"
  source_url    TEXT,
  fetched_at    TIMESTAMP NOT NULL,
  PRIMARY KEY (member_id, vote_id)
);

-- Canonical bills referenced by votes. One row per (congress, bill_type,
-- bill_number); summary text comes from Congress.gov v3 /summaries endpoint.
-- LEFT JOINed at view time so votes without a resolved bill don't drop out.
CREATE TABLE IF NOT EXISTS bill_summaries (
  bill_id          TEXT PRIMARY KEY,   -- "118-hr-8752"
  congress         INTEGER NOT NULL,
  bill_type        TEXT NOT NULL,      -- hr | s | hres | sres | hjres | sjres
  bill_number      INTEGER NOT NULL,
  title            TEXT,               -- extracted bill title (from first <strong>)
  summary_text     TEXT,               -- plain-text summary, HTML stripped
  summary_html     TEXT,               -- original HTML kept for future rendering
  summary_version  TEXT,               -- 00 | 07 | 53 etc — Congress.gov version code
  action_date      DATE,
  source_url       TEXT,               -- canonical congress.gov bill URL
  fetched_at       TIMESTAMP NOT NULL
);

-- ─── Bills sponsored / cosponsored ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bills (
  member_id     TEXT NOT NULL,
  bill_id       TEXT NOT NULL,
  title         TEXT,
  status        TEXT,
  sponsor_role  TEXT,                 -- sponsor | cosponsor
  introduced_at DATE,
  source_url    TEXT,
  fetched_at    TIMESTAMP NOT NULL,
  PRIMARY KEY (member_id, bill_id)
);

-- ─── Committees ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS committees (
  member_id           TEXT NOT NULL,
  committee_name      TEXT NOT NULL,
  committee_canonical TEXT,           -- normalized join key, see committeeCanonical()
  role                TEXT,           -- member | chair | ranking | ...
  source_url          TEXT,
  fetched_at          TIMESTAMP NOT NULL,
  PRIMARY KEY (member_id, committee_name)
);

-- Committees that handled a given bill (referred / marked up / reported).
-- One row per (bill_id, committee_code). `committee_canonical` is the join
-- key against `committees.committee_canonical` so we can flag trades that
-- happened while the trader sat on the committee with jurisdiction.
CREATE TABLE IF NOT EXISTS bill_committees (
  bill_id              TEXT NOT NULL,
  committee_name       TEXT NOT NULL,    -- "Appropriations Committee"
  committee_chamber    TEXT,             -- House | Senate | Joint
  committee_code       TEXT NOT NULL,    -- "hsap00"
  committee_canonical  TEXT,             -- "appropriations"
  latest_activity      TEXT,             -- "Reported Original Measure" / "Markup" / ...
  latest_activity_date DATE,
  source_url           TEXT,
  fetched_at           TIMESTAMP NOT NULL,
  PRIMARY KEY (bill_id, committee_code)
);

-- ─── Controversies ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS controversies (
  member_id   TEXT NOT NULL,
  topic       TEXT NOT NULL,
  summary     TEXT,
  date        DATE,
  source      TEXT,
  source_url  TEXT,
  fetched_at  TIMESTAMP NOT NULL,
  PRIMARY KEY (member_id, topic)
);

-- ─── PFD transactions (House Clerk PTRs) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS pfd_transactions (
  filing_id          TEXT NOT NULL,
  tx_index           INTEGER NOT NULL,    -- transaction position within filing
  filer_name         TEXT,
  filer_state_district TEXT,
  member_id          TEXT,                -- nullable: best-effort link to members
  holder             TEXT,                -- self | spouse | joint | dependent-child
  asset              TEXT,
  ticker             TEXT,
  asset_type         TEXT,                -- ST | OP | AB | BA | CT | GS | MF | EF | FU
  sub_account        TEXT,                -- e.g. "Marjorie IRA"
  location           TEXT,                -- two-letter, usually US
  tx_type            TEXT,                -- purchase | sale | sale-partial | exchange
  tx_date            DATE,
  notification_date  DATE,
  amount_band        TEXT,                -- preserved as string, no midpointing
  filing_status      TEXT,                -- New | Amended
  description        TEXT,
  source_url         TEXT,
  match_confidence   DOUBLE,               -- 0.0–1.0; NULL when member_id is NULL
  match_method       TEXT,                 -- exact_state_lastname | state_district_lastname | state_lastname_ambiguous | unmatched | manual
  source_year        INTEGER,              -- year passed to --load-pfd
  fetched_at         TIMESTAMP NOT NULL,
  PRIMARY KEY (filing_id, tx_index)
);

-- ─── Pipeline runs (replaces task-*/state.json + final-review.json) ─────────
CREATE TABLE IF NOT EXISTS pipeline_runs (
  task_id           TEXT PRIMARY KEY,
  member_id         TEXT NOT NULL,
  started_at        TIMESTAMP NOT NULL,
  finished_at       TIMESTAMP,
  approved          BOOLEAN,
  reviewer_decision TEXT,
  reviewer_notes    TEXT,
  summary_text      TEXT,
  report_html_path  TEXT,
  errors            TEXT[]
);

-- ─── Predictor calibration runs ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS predictions (
  task_id          TEXT NOT NULL,
  member_id        TEXT NOT NULL,
  model            TEXT NOT NULL,        -- naive-half | always-yes | historical-rate | laplace-smoothed | party-class-rate
  brier_score      DOUBLE,
  log_loss         DOUBLE,
  accuracy         DOUBLE,
  train_count      INTEGER,
  test_count       INTEGER,
  best_model       BOOLEAN DEFAULT FALSE,
  run_at           TIMESTAMP NOT NULL,
  PRIMARY KEY (task_id, model)
);

-- ─── Views ──────────────────────────────────────────────────────────────────

-- Latest member-pair shared donors. Replaces Connection Mapper stage 1.
CREATE OR REPLACE VIEW v_shared_donors AS
SELECT
  a.member_id          AS subject_id,
  b.member_id           AS peer_id,
  a.donor_canonical,
  a.donor_name          AS subject_donor_name,
  b.donor_name          AS peer_donor_name,
  a.amount              AS subject_amount,
  b.amount              AS peer_amount,
  a.donor_type
FROM donors a
JOIN donors b
  ON a.donor_canonical = b.donor_canonical
 AND a.member_id <> b.member_id;

-- Shared committee memberships. Mirrors v_shared_donors. Committee names
-- are matched verbatim — the unitedstates YAML keys them by stable code so
-- normalization isn't needed.
CREATE OR REPLACE VIEW v_shared_committees AS
SELECT
  a.member_id   AS subject_id,
  b.member_id   AS peer_id,
  a.committee_name,
  a.role        AS subject_role,
  b.role        AS peer_role
FROM committees a
JOIN committees b
  ON a.committee_name = b.committee_name
 AND a.member_id <> b.member_id;

-- Top donors corpus-wide — useful for the dashboard / staleness audits.
CREATE OR REPLACE VIEW v_top_donors AS
SELECT
  donor_canonical,
  ANY_VALUE(donor_name)         AS sample_name,
  COUNT(DISTINCT member_id)     AS member_count,
  SUM(amount)                   AS total_amount,
  ANY_VALUE(donor_type)         AS donor_type
FROM donors
GROUP BY donor_canonical
ORDER BY member_count DESC, total_amount DESC;

-- Trade × vote proximity. Joins each PFD transaction to votes by the same
-- member and exposes timing signals as separate columns. NEUTRAL framing:
-- no scalar "suspicion" score — readers filter on the signals they care about.
-- Sign convention for days_from_trade_to_vote:
--   positive = trade BEFORE vote, negative = trade AFTER vote, zero = same day.
CREATE OR REPLACE VIEW v_trades_near_votes AS
SELECT
  t.member_id, m.name AS member_name, t.holder,
  t.tx_date, t.tx_type, t.asset, t.ticker, t.asset_type, t.amount_band,
  t.filing_id AS trade_filing_id, t.source_url AS trade_source_url,
  t.source_year,
  v.date AS vote_date, v.question AS vote_question,
  v.position AS vote_position, v.vote_id, v.source_url AS vote_source_url,
  v.bill_id,
  bs.title AS bill_title,
  bs.summary_text AS bill_summary,
  bs.source_url AS bill_source_url,
  -- Bill committees: list of committee names + a flag if the trader
  -- sits on any of them. Computed once via correlated subquery so each
  -- bill's committees are aggregated, not exploded into duplicate rows.
  (SELECT STRING_AGG(bc.committee_name, ' · ')
     FROM bill_committees bc WHERE bc.bill_id = v.bill_id) AS bill_committees,
  EXISTS (
    SELECT 1 FROM bill_committees bc
    JOIN committees mc ON mc.committee_canonical = bc.committee_canonical
    WHERE bc.bill_id = v.bill_id AND mc.member_id = t.member_id
  ) AS member_on_bill_committee,
  (SELECT mc.role FROM bill_committees bc
     JOIN committees mc ON mc.committee_canonical = bc.committee_canonical
     WHERE bc.bill_id = v.bill_id AND mc.member_id = t.member_id
     ORDER BY CASE mc.role
       WHEN 'chair' THEN 1
       WHEN 'ranking' THEN 2
       WHEN 'member' THEN 3
       ELSE 4
     END
     LIMIT 1) AS member_committee_role,
  date_diff('day', t.tx_date, v.date)       AS days_from_trade_to_vote,
  ABS(date_diff('day', t.tx_date, v.date))  AS days_abs,
  GREATEST(0,  date_diff('day', t.tx_date, v.date)) AS days_before_vote,
  GREATEST(0, -date_diff('day', t.tx_date, v.date)) AS days_after_vote,
  t.match_confidence, t.match_method
FROM pfd_transactions t
JOIN votes v ON v.member_id = t.member_id
JOIN members m ON m.member_id = t.member_id
LEFT JOIN bill_summaries bs ON bs.bill_id = v.bill_id
WHERE t.member_id IS NOT NULL
  AND t.tx_date IS NOT NULL
  AND v.date IS NOT NULL;

-- Per-member trade rollup. Drives the loader's sanity check and the future
-- dashboard's overview row.
CREATE OR REPLACE VIEW v_member_trade_summary AS
SELECT
  t.member_id, m.name,
  COUNT(*) AS total_trades,
  COUNT(DISTINCT COALESCE(t.ticker, t.asset)) AS distinct_assets,
  SUM(CASE WHEN t.tx_type = 'purchase' THEN 1 ELSE 0 END) AS purchase_count,
  SUM(CASE WHEN t.tx_type LIKE 'sale%' THEN 1 ELSE 0 END) AS sale_count,
  MIN(t.tx_date) AS first_trade_date,
  MAX(t.tx_date) AS last_trade_date,
  ROUND(AVG(t.match_confidence), 3) AS avg_match_confidence
FROM pfd_transactions t
JOIN members m ON m.member_id = t.member_id
WHERE t.member_id IS NOT NULL
GROUP BY t.member_id, m.name;

-- Focused investigative view.  Three noise-reduction rules applied:
--   1. Asset-type filter: drop GS (govt securities / T-bills), MF (mutual funds),
--      EF (ETFs), BA (bonds — includes corporates and munis), CT (cash/treasuries),
--      and the free-text variants we actually see in the data ('Corporate Bond',
--      'Municipal Security').  Also drops 'OT' rows whose asset name contains
--      known index/ETF keywords so Vanguard S&P 500 ETF doesn't surface as signal.
--   2. Direction filter: only trades BEFORE the vote (days_from_trade_to_vote >= 0).
--      After-vote trades are noise for the "advance knowledge" question.
--   3. Vote relevance: surfaces two boolean signals the reader can filter on —
--        • member_on_bill_committee (already in v_trades_near_votes)
--        • bill_mentions_ticker: TRUE when the bill summary text contains the traded
--          ticker symbol as a whole word (rough proxy for bill→company relevance).
--      Neither is a score — both are raw signals; readers draw conclusions.
--
-- "Passive/automated" exclusion rationale:
--   T-bills roll on fixed schedules, ETFs/index funds have no single-company
--   vote nexus, and mutual fund redemptions are often broker-initiated.  These
--   inflate proximity counts without meaningful informational asymmetry.
--   Excluding them does NOT mean they are legal or ethical — it means they are
--   not the right instrument for the trade-vote join.
CREATE OR REPLACE VIEW v_suspicious_trades AS
SELECT
  v.*,
  -- Bill-text ticker match: whole-word search so "MA" doesn't match "SMALL".
  -- Null-safe: if no bill_summary or no ticker, evaluates to FALSE.
  (
    v.ticker IS NOT NULL
    AND v.bill_summary IS NOT NULL
    AND v.bill_summary ILIKE ('%' || ' ' || v.ticker || ' ' || '%')
       OR (v.ticker IS NOT NULL AND v.bill_summary IS NOT NULL
           AND v.bill_summary ILIKE (v.ticker || ' %'))
       OR (v.ticker IS NOT NULL AND v.bill_summary IS NOT NULL
           AND v.bill_summary ILIKE ('% ' || v.ticker))
  ) AS bill_mentions_ticker
FROM v_trades_near_votes v
WHERE
  -- Drop passive / non-discretionary asset types
  v.asset_type NOT IN ('GS', 'MF', 'EF', 'BA', 'CT', 'AB')
  AND v.asset_type NOT IN ('Corporate Bond', 'Municipal Security')
  -- Drop ETF / index fund rows classified as 'OT' or 'Stock' by free-text
  AND NOT (
    v.asset_type IN ('OT', 'Stock')
    AND (
         LOWER(v.asset) LIKE '%etf%'
      OR LOWER(v.asset) LIKE '%index fund%'
      OR LOWER(v.asset) LIKE '%s&p 500%'
      OR LOWER(v.asset) LIKE '%vanguard%'
      OR LOWER(v.asset) LIKE '%ishares%'
      OR LOWER(v.asset) LIKE '%schwab%'
      OR LOWER(v.asset) LIKE '%fidelity%'
      OR LOWER(v.asset) LIKE '%matthews international mutual%'
    )
  )
  -- Before-vote only (positive = trade before vote, zero = same day)
  AND v.days_from_trade_to_vote >= 0;

-- Members with last-fetched age in days, for staleness checks.
CREATE OR REPLACE VIEW v_member_freshness AS
SELECT
  member_id,
  name,
  fetched_at,
  date_diff('day', fetched_at, current_timestamp) AS days_since_fetch
FROM members;
