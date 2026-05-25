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

-- ─── Super PAC independent expenditures (FEC Schedule E) ───────────────────
-- Persists what lib/fec-ie.ts fetched live at render time, so the Pattern
-- Discovery contract's CitedRow.kind = 'ie' has a substrate to cite.
-- Aggregate row per (member, committee, cycle, support/oppose).
CREATE TABLE IF NOT EXISTS super_pac_ie (
  member_id       TEXT NOT NULL,        -- resolved from members.fec_candidate_id
  candidate_id    TEXT NOT NULL,        -- FEC candidate id (e.g. H0GA06192)
  cycle           INTEGER NOT NULL,     -- even-year election cycle
  committee_id    TEXT,                 -- nullable: FEC by_candidate rows without committee_id
  committee_name  TEXT,
  committee_type  TEXT,
  designation     TEXT,
  party           TEXT,
  support_oppose  TEXT NOT NULL,        -- 'S' = supporting member, 'O' = opposing
  total_amount    DOUBLE NOT NULL,
  filing_count    INTEGER NOT NULL,     -- itemized filings aggregated by FEC
  fetched_at      TIMESTAMP NOT NULL
  -- No PRIMARY KEY: committee_id is nullable (FEC by_candidate rows without a
  -- committee_id), and PK columns are implicitly NOT NULL in DuckDB. Idempotent
  -- via the loader's DELETE-then-insert per (member_id, cycle).
);

-- Itemized Schedule E filings — the clickable CitedRow.kind = 'ie' rows.
CREATE TABLE IF NOT EXISTS super_pac_ie_filings (
  transaction_id  TEXT,                 -- nullable: FEC omits it on some rows
  member_id       TEXT NOT NULL,
  candidate_id    TEXT NOT NULL,
  cycle           INTEGER NOT NULL,
  committee_id    TEXT,
  committee_name  TEXT,
  support_oppose  TEXT NOT NULL,
  amount          DOUBLE NOT NULL,
  expenditure_date DATE,
  disbursement_date DATE,
  description     TEXT,
  payee_name      TEXT,
  election_type   TEXT,                 -- e.g. "P2022", "G2024"
  report_year     INTEGER,
  pdf_url         TEXT,
  fetched_at      TIMESTAMP NOT NULL
  -- No PRIMARY KEY: FEC repeats transaction_id within a member (amendments,
  -- per-election-type splits). Idempotent via DELETE-then-insert per
  -- (member_id, cycle), same as super_pac_ie.
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

-- ─── LDA (Lobbying Disclosure Act) ──────────────────────────────────────────
-- Source: lda.senate.gov REST API (paginated, page_size capped at 25).
-- Two tables: one row per (filing × lobbyist), plus filing-level metadata.
-- Only filings with at least one non-null `covered_position` are retained —
-- that's the revolving-door signal. Bulk filings without former-government
-- ties would balloon the table to ~2M rows for no analytic value.
CREATE TABLE IF NOT EXISTS lda_filings (
  filing_uuid        TEXT PRIMARY KEY,
  filing_year        INTEGER NOT NULL,
  filing_period      TEXT,                  -- first_quarter | second_quarter | ...
  filing_type        TEXT,                  -- Q1 | Q2 | YE | RR | ...
  registrant_name    TEXT,                  -- lobbying firm
  client_name        TEXT,                  -- entity that hired the firm
  income             DOUBLE,
  expenses           DOUBLE,
  posted_at          TIMESTAMP,
  filing_url         TEXT,
  source_url         TEXT,                  -- canonical lda.senate.gov filing URL
  fetched_at         TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS lda_lobbyists (
  filing_uuid        TEXT NOT NULL,
  lobbyist_id        INTEGER NOT NULL,      -- lda.senate.gov lobbyist primary key
  first_name         TEXT,
  last_name          TEXT,
  middle_name        TEXT,
  full_name          TEXT,                  -- "First Middle Last" — convenience
  full_name_canonical TEXT,                 -- UPPER, punctuation/suffix stripped
  covered_position   TEXT,                  -- raw free-text former gov role
  general_issues     TEXT,                  -- "/"-joined issue codes lobbied
  government_entities TEXT,                 -- "/"-joined federal entities targeted
  is_new             BOOLEAN,
  fetched_at         TIMESTAMP NOT NULL,
  PRIMARY KEY (filing_uuid, lobbyist_id)
);

-- Latest registration per lobbyist (for member-page joins). Picks the most
-- recent filing per lobbyist; useful when one person has dozens of quarterly
-- filings under the same registrant.
CREATE OR REPLACE VIEW v_lobbyist_latest AS
SELECT
  l.lobbyist_id,
  l.full_name,
  l.full_name_canonical,
  l.covered_position,
  f.registrant_name,
  f.client_name,
  f.filing_year,
  f.filing_period,
  l.general_issues,
  l.government_entities,
  f.source_url,
  ROW_NUMBER() OVER (
    PARTITION BY l.lobbyist_id
    ORDER BY f.filing_year DESC, f.posted_at DESC
  ) AS rn
FROM lda_lobbyists l
JOIN lda_filings f USING (filing_uuid)
QUALIFY rn = 1;

-- ─── Pattern hits (Pattern Discovery v2) ────────────────────────────────────
-- Written by a separate post-pipeline pass (pipeline/run-patterns.ts), not by
-- an agent. One row per (pattern, member, dates window). citing_json/dates_json
-- are JSON arrays because the read pattern is "all hits for member X" and the
-- citing rows are always read together with the hit. detected_at lets the
-- render layer order by recency within an intensity tier.
-- No enforced PRIMARY KEY. An enforced PK builds a unique ART index, and DuckDB
-- throws "Failed to delete all rows from index. Only deleted 0 out of N rows"
-- when run-patterns re-runs over a member whose prior hit is being replaced —
-- corrupting the pass for ALL detectors. Idempotency is enforced in code by
-- run-patterns (DELETE WHERE pattern+member, then INSERT), so the constraint was
-- redundant. Matches the deliberate no-PK convention of donor_industry /
-- super_pac_ie (churned, DELETE-then-insert tables).
CREATE TABLE IF NOT EXISTS pattern_hits (
  pattern         TEXT NOT NULL,
  member          TEXT NOT NULL,
  finding         TEXT NOT NULL,
  intensity       DOUBLE NOT NULL,
  citing_json     TEXT NOT NULL,
  dates_json      TEXT NOT NULL,
  detected_at     TIMESTAMP NOT NULL
);
-- No secondary ART indexes either: in this DuckDB version they hit the same
-- "Failed to delete all rows from index" bug as the PK on run-patterns re-runs.
-- pattern_hits is small (hundreds of rows) so full scans are instant.

-- ─── Relevance edge: ticker → sector (SEC SIC) ──────────────────────────────
-- Deterministic ticker→company→SIC sector map from SEC. Only the distinct
-- tickers actually traded need rows. `sector` is the 2-digit SIC major-group
-- label; NULL for ETFs/index funds with no single issuer. See SOURCES.md
-- "Source B". Feeds the trade↔bill nexus join (ticker sector ∩ bill subject).
CREATE TABLE IF NOT EXISTS ticker_sectors (
  ticker          TEXT PRIMARY KEY,
  cik             TEXT,             -- SEC CIK, zero-padded
  sic             TEXT,             -- 4-digit SIC code
  sic_description TEXT,             -- e.g. "Electronic Computers"
  sector          TEXT,             -- 2-digit SIC major-group label
  source_url      TEXT,
  fetched_at      TIMESTAMP NOT NULL
);

-- ─── Relevance edge: bill → policy area + subjects (Congress.gov) ────────────
-- One row per (bill_id, subject). `policy_area` repeated per row (single
-- top-level category); `subject` is a granular legislative subject tag (the
-- join surface). See SOURCES.md "Source A". Only fetch distinct bill_ids that
-- votes reference (dense after the --load-bills backfill).
CREATE TABLE IF NOT EXISTS bill_subjects (
  bill_id     TEXT NOT NULL,
  policy_area TEXT,                 -- single top-level category
  subject     TEXT NOT NULL,        -- granular legislative subject tag
  source_url  TEXT,
  fetched_at  TIMESTAMP NOT NULL,
  PRIMARY KEY (bill_id, subject)
);
CREATE INDEX IF NOT EXISTS idx_bill_subjects_bill ON bill_subjects(bill_id);

-- ─── Relevance crosswalk (seeded by db/load-sector-crosswalk.ts) ────────────
-- The only judgment in the relevance edge: a static, hand-curated, version-
-- controlled mapping. NOT an LLM. sic_theme maps each traded SIC to an industry
-- theme; theme_bill_match says which bill policy areas / subject patterns mean
-- a bill materially affects that theme.
CREATE TABLE IF NOT EXISTS sic_theme (
  sic   TEXT PRIMARY KEY,
  theme TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS theme_bill_match (
  theme           TEXT NOT NULL,
  policy_area     TEXT,             -- exact match on bill_subjects.policy_area
  subject_pattern TEXT              -- ILIKE pattern on bill_subjects.subject
);
-- Per-ticker theme override. A handful of tickers share a grab-bag SIC with
-- unrelated businesses (e.g. SIC 7389 "Business Services, NEC" holds both CDN
-- tech and card networks). The override pins those to the correct theme,
-- taking precedence over the SIC→theme map without mutating SEC-sourced data.
CREATE TABLE IF NOT EXISTS ticker_theme_override (
  ticker TEXT PRIMARY KEY,
  theme  TEXT NOT NULL,
  note   TEXT              -- why the SIC-derived theme is wrong for this ticker
);

-- ─── Donor-sector substrate (Pattern Discovery v2, Phase 2) ─────────────────
-- Per-member industry breakdown of campaign money, the donor-side analogue of
-- the trade nexus. Authoritative tier = OpenSecrets per-member industry rollup
-- (source='opensecrets'); fallback tier = FEC Schedule A employer/occupation
-- fuzzy classification (source='fec') for members/cycles OpenSecrets lacks.
-- Idempotency: DELETE-then-insert per (member_id, cycle, source). No PK — a
-- member can have the same industry under both tiers across reconciliation, and
-- OpenSecrets industry strings are not guaranteed unique within a sector.
CREATE TABLE IF NOT EXISTS donor_industry (
  member_id    TEXT NOT NULL,
  cycle        INTEGER NOT NULL,
  sector       TEXT,                 -- OpenSecrets 13-sector label (null for fec tier)
  industry     TEXT NOT NULL,        -- OpenSecrets industry, or FEC-derived label
  total        DOUBLE NOT NULL,      -- total $ from this industry
  individuals  DOUBLE,               -- $ from individuals
  pacs         DOUBLE,               -- $ from PACs
  source       TEXT NOT NULL,        -- 'opensecrets' | 'fec'
  source_url   TEXT,
  fetched_at   TIMESTAMP NOT NULL
);

-- Donor-industry → theme crosswalk. Same hand-curated, version-controlled
-- philosophy as sic_theme/theme_bill_match: an ILIKE pattern against
-- donor_industry.industry maps it to one of the existing economic-sector
-- themes. Industries with no pattern match (Labor, Ideology, Lawyers, Retired,
-- Education, public sector) are deliberately UNMAPPED — they carry no
-- tradable-industry theme, so they sit outside the donor↔sponsorship lens.
-- Seeded by db/load-sector-crosswalk.ts.
CREATE TABLE IF NOT EXISTS donor_industry_theme (
  industry_pattern TEXT NOT NULL,    -- ILIKE pattern on donor_industry.industry
  theme            TEXT NOT NULL,    -- one of the existing theme_bill_match themes
  note             TEXT
);

-- Per-member donor money rolled up to mapped economic-sector themes. The donor
-- analogue of theme exposure. Only mapped industries contribute; unmapped money
-- (Labor/Ideology/etc.) is intentionally excluded so themes are comparable to
-- the trade/bill theme space.
CREATE OR REPLACE VIEW v_member_donor_theme AS
SELECT
  di.member_id,
  di.cycle,
  m.theme,
  SUM(di.total)       AS theme_total,
  SUM(di.individuals) AS theme_individuals,
  SUM(di.pacs)        AS theme_pacs,
  COUNT(*)            AS industry_count,
  ANY_VALUE(di.source) AS source
FROM donor_industry di
JOIN donor_industry_theme m ON di.industry ILIKE m.industry_pattern
GROUP BY di.member_id, di.cycle, m.theme;

-- ─── Trade ↔ bill nexus (the credible-loop view) ────────────────────────────
-- A trade qualifies only when the traded ticker's industry theme intersects the
-- bill's topic — every edge deterministic and sourced, no scalar score.
--
-- Relevance is policy-area-primary: Congress.gov's single editorial policy_area
-- is the reliable signal. Granular `subject` tags are NOT trusted as a primary
-- surface — they are both over-broad (a bill carries dozens of tangential tags,
-- so ILIKE '%technology%' fires on unrelated bills) and sometimes wrong (an
-- amended vehicle keeps its original shell's subjects — e.g. HR 4346 / CHIPS
-- carries Legislative-Branch-Appropriations subjects). subject_pattern rules are
-- kept only as a narrow, high-specificity supplement (e.g. '%semiconductor%')
-- and to discriminate themes that share one coarse policy_area: Tech and Media
-- both fall under "Science, Technology, Communications", so Media&Telecom matches
-- on specific subjects ONLY (no policy_area) to keep cable/broadcast names off
-- semiconductor bills.
--
-- Broad money vehicles (appropriations / CR / consolidated / relief /
-- reconciliation / omnibus / "providing for consideration" rules), ceremonial
-- resolution types, and degenerate stub titles are excluded as having no
-- specific nexus; substantive single-subject bills (hr/s/hjres/sjres) remain.
CREATE OR REPLACE VIEW v_trade_bill_nexus AS
SELECT DISTINCT
  t.member_id, t.member_name,
  t.tx_date, t.tx_type, t.ticker, t.asset, t.amount_band,
  ts.sic, ts.sic_description, COALESCE(o.theme, st.theme) AS theme,
  t.bill_id, t.bill_title, t.vote_id, t.vote_date, t.vote_question, t.vote_position,
  t.days_before_vote,
  t.trade_source_url, t.vote_source_url, t.bill_source_url
FROM v_suspicious_trades t
JOIN ticker_sectors          ts ON ts.ticker = UPPER(t.ticker)
LEFT JOIN sic_theme          st ON st.sic = ts.sic
LEFT JOIN ticker_theme_override o ON o.ticker = UPPER(t.ticker)
JOIN bill_subjects           bs ON bs.bill_id = t.bill_id
JOIN theme_bill_match        m  ON m.theme = COALESCE(o.theme, st.theme)
  AND ( (m.policy_area     IS NOT NULL AND bs.policy_area = m.policy_area)
     OR (m.subject_pattern IS NOT NULL AND bs.subject ILIKE m.subject_pattern
          -- Subject-pattern matches only count on FOCUSED bills. Broad vehicles
          -- carry dozens of incidental subject tags (Fiscal Responsibility Act:
          -- 160, Limit Save Grow: 111), so any single tag is meaningless there;
          -- focused bills carry few (POWER Act: 1, Critical Mineral Act: 3).
          -- policy_area matches are exempt (CHIPS has 49 tags but matches its
          -- editorial policy_area, not a subject).
          AND (SELECT COUNT(*) FROM bill_subjects b2 WHERE b2.bill_id = t.bill_id) <= 25) )
WHERE t.bill_id IS NOT NULL
  AND t.days_before_vote >= 0
  AND t.bill_title IS NOT NULL
  AND COALESCE(o.theme, st.theme) IS NOT NULL
  AND LENGTH(t.bill_title) >= 6
  AND t.bill_title NOT ILIKE 'Providing for consideration%'
  AND t.bill_title NOT ILIKE '%appropriations%'
  AND t.bill_title NOT ILIKE '%consolidated%'
  AND t.bill_title NOT ILIKE '%continuing%'
  AND t.bill_title NOT ILIKE '%relief act%'
  AND t.bill_title NOT ILIKE '%reconciliation%'
  AND t.bill_title NOT ILIKE '%omnibus%'
  AND t.bill_title NOT ILIKE '%national defense authorization%'
  AND t.bill_title NOT ILIKE '%rescissions act%'
  AND regexp_extract(t.bill_id, '-(hr|s|hjres|sjres)-', 1) <> '';
