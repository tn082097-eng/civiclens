# Money↔Vote Juxtaposition Detector (Issue #6) Implementation Plan

> **Rev 2026-06-19 — 3 blockers patched after a second Grok design review** (`~/grok-workspace/reviews/20260619-180944-design-...md`): **(#1)** `filing_id` now `COALESCE(transaction_id, image_number)` in the Task 4 view + `filingId: z.string().min(1)` in Task 2 (image-only rows no longer throw at parse). **(#2)** Task 9 no longer races Issue #7 — it fills #7's reserved `sec-money-votes` slot and never touches `buildMemberPage`/receipts wiring. **(#3)** Task 9 render path collapsed to a single source (`pipeline/artifacts/{member}.money-votes.json`) behind a `loadMoneyVotesOrSentinel` sentinel; `db/load-from-tasks.ts` modify removed. Non-blocking concerns (temporal SQL bound, fec_candidate_id skip behavior, source_url permalink, pipeline.ts wiring, theme enum) remain as filed — fold in opportunistically.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic, row-cited detector that surfaces dated juxtapositions between a member's *industry-PAC contributions* and their *theme-matched votes* within N days — the money→vote analogue of the existing trade→vote nexus.

**Architecture:** Mirror the trade→vote spine. A new `fec_contributions` table holds itemized **non-individual (PAC) Schedule A receipts** (dated, `transaction_id`+image-cited). A curated `pac_theme` ILIKE crosswalk maps genuine industry/trade PAC names to one of the 12 existing themes; leadership/ideological/JFC/conduit PACs are deliberately *unmapped → excluded* (same philosophy as `donor_industry_theme`). A new view `v_donor_vote_nexus` joins themed PAC contributions to theme-matched bills the member voted on, computing `days_before_vote`. A pure TS assembler emits a typed `MoneyVoteFlags` artifact; a deterministic render section displays it. No LLM on the ship path (ADR 0001).

**Tech Stack:** TypeScript + tsx, DuckDB (`@duckdb/node-api`), Zod, `node:test`. FEC OpenFEC API via the existing `lib/fec-ie.ts` client.

## Global Constraints

- **No LLM on the ship path.** Detector + render are pure deterministic SQL/TS (ADR 0001).
- **No stub data — fail loudly.** No fabricated PAC names, themes, or receipts. The `pac_theme` seed is curated only from PAC names that actually appear in loaded `fec_contributions`.
- **Row-enumeration guard (#3 parity):** never render an aggregate ("received $X from sector Y") without enumerating the underlying filing rows. Each hit carries its own `transaction_id` + source URL.
- **Before-not-after:** a hit requires `money_date <= vote_date` (`days_before_vote >= 0`). Money *after* a vote is not a juxtaposition.
- **Proximity window is a named constant** `WINDOW_DAYS = 30`, applied in the TS detector (not baked into the view) so it is tunable without rewriting SQL.
- **Empty result is valid output**, rendered as explicit data ("no money↔vote flags in window"), never omitted. Uniform-skeleton rule.
- **Theme strings must exactly equal** the 12 `theme_bill_match.theme` values: `Banks & Finance, Defense & Aerospace, Energy, Industrials, Materials & Mining, Media & Telecom, Payments, Pharma & Health, Real Estate, Retail & Consumer, Tech & Semiconductors, Transportation`.
- **Scope:** non-individual (PAC) receipts only. Individual itemized receipts (154k/member-cycle) are out of scope — infeasible volume and require OpenSecrets' proprietary employer→industry classification. Documented as a deferred enrichment.

---

## File Structure

- `lib/schemas.ts` — add `MoneyVoteFlagSchema`, `MoneyVoteFlagsSchema`, `MoneyVoteFlags` type. (Modify)
- `db/schema.sql` — add `fec_contributions` table, `pac_theme` table, `v_donor_vote_nexus` view. (Modify)
- `lib/fec-contributions.ts` — fetcher: non-individual Schedule A receipts per committee/cycle. (Create)
- `db/load-fec-contributions.ts` — loader: candidate_id → principal committee → fetch → upsert into `fec_contributions`. (Create)
- `db/load-sector-crosswalk.ts` — add `pac_theme` seed block. (Modify)
- `pipeline/detect-money-votes.ts` — `assembleFlags()` pure assembler + DB glue `detectMember()`. (Create)
- `pipeline/detect-money-votes.test.ts` — assembler unit tests. (Create)
- `render/build.ts` — add `renderMoneyVotesSection(a: MoneyVoteFlags): string`. (Modify)
- `render/money-votes.test.ts` — render unit tests. (Create)
- `package.json` — widen test glob to include `pipeline/*.test.ts`. (Modify)
- `SOURCES.md` — freeze a Schedule A non-individual sample payload + quirks. (Modify)

---

## Task 1: Freeze the Schedule A source sample

**Files:**
- Modify: `SOURCES.md` (append under "FEC OpenFEC API")

**Interfaces:**
- Produces: documented field shapes consumed by Tasks 3–4 (`transaction_id`, `contribution_receipt_date`, `contribution_receipt_amount`, `contributor_name`, `entity_type`, `image_number`, `pdf_url`).

- [ ] **Step 1: Pull one live sample** (non-individual page, sorted by amount) for committee `C00652727` (Josh Hawley for Senate), cycle 2024, via the existing key in `.env`. Endpoint: `/schedules/schedule_a/?committee_id=C00652727&two_year_transaction_period=2024&is_individual=false&sort=-contribution_receipt_amount&per_page=5`.

- [ ] **Step 2: Append a "Schedule A — itemized receipts (non-individual)" subsection** to `SOURCES.md` recording: the endpoint, the `is_individual=false` filter, cursor pagination keys (`last_index`, `last_contribution_receipt_amount`), per-member-cycle volume (~553 non-individual vs ~154k all), entity_type distribution (`PAC/COM/ORG/CCM/PTY/IND`), and the verbatim sample fields for one industry PAC row (e.g. `NATIONAL ASSOCIATION OF REALTORS PAC`). Note the quirk: top non-individual rows are JFC transfers/conduits (WinRed), not interest money — these are excluded at theme time.

- [ ] **Step 3: Commit**
```bash
git add SOURCES.md
git commit -m "docs(sources): freeze FEC Schedule A non-individual receipts sample"
```

---

## Task 2: `MoneyVoteFlags` typed artifact schema

**Files:**
- Modify: `lib/schemas.ts` (append after `ThemeGapReceiptsSchema`, ~line 284)
- Test: `pipeline/detect-money-votes.test.ts` (created here, extended in Task 6)

**Interfaces:**
- Produces: `MoneyVoteFlagSchema`, `MoneyVoteFlagsSchema`, `type MoneyVoteFlags`. Consumed by Tasks 6 (assembler) and 7 (render).

- [ ] **Step 1: Write the failing test**
```ts
// pipeline/detect-money-votes.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MoneyVoteFlagsSchema } from '../lib/schemas.js';

test('MoneyVoteFlagsSchema accepts a well-formed empty artifact', () => {
  const art = {
    memberId: 'josh-hawley', windowDays: 30,
    coverage: { pacReceiptsThemed: 0, pacReceiptsTotal: 12 },
    flags: [],
  };
  assert.doesNotThrow(() => MoneyVoteFlagsSchema.parse(art));
});

test('MoneyVoteFlagsSchema rejects a negative daysBeforeVote', () => {
  const bad = {
    memberId: 'm', windowDays: 30, coverage: { pacReceiptsThemed: 1, pacReceiptsTotal: 1 },
    flags: [{ theme: 'Energy', committeeName: 'X PAC', supportOppose: 'S', filingId: 't1',
      amount: 5000, moneyDate: '2024-01-01', voteId: 'v', voteDate: '2024-01-10',
      votePosition: 'Yea', billId: '118-hr-1', billTitle: 'Energy Act', daysBeforeVote: -2,
      moneySourceUrl: 'u', voteSourceUrl: 'u', billSourceUrl: 'u' }],
  };
  assert.throws(() => MoneyVoteFlagsSchema.parse(bad));
});
```

- [ ] **Step 2: Run, verify it fails** — `npx tsx --test pipeline/detect-money-votes.test.ts` → FAIL (`MoneyVoteFlagsSchema` undefined).

- [ ] **Step 3: Add the schema** to `lib/schemas.ts`:
```ts
export const MoneyVoteFlagSchema = z.object({
  theme:          z.string(),
  committeeName:  z.string(),
  supportOppose:  z.enum(['S', 'O']),   // direct contributions are 'S'; kept for symmetry w/ IE
  filingId:       z.string().min(1),    // COALESCE(transaction_id, image_number) — the dated
                                         // filing cite. Non-empty: the loader drops rows where
                                         // BOTH are null (Task 6), so this is always citable.
  amount:         z.number().nonnegative(),
  moneyDate:      z.string(),           // contribution_receipt_date (YYYY-MM-DD)
  voteId:         z.string(),
  voteDate:       z.string(),
  votePosition:   z.string().nullable(),
  billId:         z.string(),
  billTitle:      z.string(),
  daysBeforeVote: z.number().int().nonnegative(),
  moneySourceUrl: z.string(),
  voteSourceUrl:  z.string(),
  billSourceUrl:  z.string(),
});

export const MoneyVoteFlagsSchema = z.object({
  memberId:   z.string(),
  windowDays: z.number().int().positive(),
  coverage:   z.object({
    pacReceiptsThemed: z.number().int().nonnegative(), // themed (mapped) PAC receipts = denominator
    pacReceiptsTotal:  z.number().int().nonnegative(), // all non-individual receipts on record
  }),
  flags: z.array(MoneyVoteFlagSchema), // chronological by moneyDate asc, then voteDate
});
export type MoneyVoteFlags = z.infer<typeof MoneyVoteFlagsSchema>;
```

- [ ] **Step 4: Run, verify it passes** — `npx tsx --test pipeline/detect-money-votes.test.ts` → PASS (2 tests).

- [ ] **Step 5: Commit**
```bash
git add lib/schemas.ts pipeline/detect-money-votes.test.ts
git commit -m "feat(schemas): MoneyVoteFlags typed artifact for the money->vote detector"
```

---

## Task 3: Pure assembler `assembleFlags()`

**Files:**
- Create: `pipeline/detect-money-votes.ts`
- Test: `pipeline/detect-money-votes.test.ts` (extend)

**Interfaces:**
- Consumes: `MoneyVoteFlags`, `MoneyVoteFlagsSchema` (Task 2).
- Produces:
  - `interface NexusFlagRow` — one row from `v_donor_vote_nexus` (camelCase, see code).
  - `WINDOW_DAYS = 30` (exported const).
  - `assembleFlags(input: { memberId: string; windowDays: number; coverage: { pacReceiptsThemed: number; pacReceiptsTotal: number }; rows: NexusFlagRow[] }): MoneyVoteFlags` — filters `rows` to `daysBeforeVote <= windowDays`, sorts chronologically (moneyDate asc, then voteDate), validates via `MoneyVoteFlagsSchema.parse`. Consumed by Task 6 DB glue and Task 7 render tests.

- [ ] **Step 1: Write the failing test** (append to `pipeline/detect-money-votes.test.ts`)
```ts
import { assembleFlags, WINDOW_DAYS, type NexusFlagRow } from './detect-money-votes.js';

const row = (over: Partial<NexusFlagRow>): NexusFlagRow => ({
  theme: 'Energy', committeeName: 'X PAC', supportOppose: 'S', filingId: 't',
  amount: 5000, moneyDate: '2024-01-01', voteId: 'v', voteDate: '2024-01-10',
  votePosition: 'Yea', billId: '118-hr-1', billTitle: 'Energy Act', daysBeforeVote: 9,
  moneySourceUrl: 'MU', voteSourceUrl: 'VU', billSourceUrl: 'BU', ...over,
});

test('assembleFlags drops rows outside the window', () => {
  const art = assembleFlags({
    memberId: 'm', windowDays: 30, coverage: { pacReceiptsThemed: 3, pacReceiptsTotal: 9 },
    rows: [row({ filingId: 'in', daysBeforeVote: 30 }), row({ filingId: 'out', daysBeforeVote: 31 })],
  });
  assert.deepEqual(art.flags.map(f => f.filingId), ['in']);
});

test('assembleFlags sorts chronologically by moneyDate then voteDate', () => {
  const art = assembleFlags({
    memberId: 'm', windowDays: 30, coverage: { pacReceiptsThemed: 2, pacReceiptsTotal: 2 },
    rows: [
      row({ filingId: 'b', moneyDate: '2024-03-01' }),
      row({ filingId: 'a', moneyDate: '2024-01-01' }),
    ],
  });
  assert.deepEqual(art.flags.map(f => f.filingId), ['a', 'b']);
});

test('WINDOW_DAYS default is 30', () => assert.equal(WINDOW_DAYS, 30));
```

- [ ] **Step 2: Run, verify it fails** — `npx tsx --test pipeline/detect-money-votes.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `pipeline/detect-money-votes.ts`:
```ts
/**
 * Issue #6 — money->vote juxtaposition detector. Deterministic, row-cited.
 * Mirrors score-theme-gaps.ts: a pure assembler (unit-tested) + DB glue.
 *   npx tsx pipeline/detect-money-votes.ts --member josh-hawley
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDb } from '../db/init.js';
import { MoneyVoteFlagsSchema, type MoneyVoteFlags } from '../lib/schemas.js';

export const WINDOW_DAYS = 30;

export interface NexusFlagRow {
  theme: string;
  committeeName: string;
  supportOppose: 'S' | 'O';
  filingId: string;
  amount: number;
  moneyDate: string;
  voteId: string;
  voteDate: string;
  votePosition: string | null;
  billId: string;
  billTitle: string;
  daysBeforeVote: number;
  moneySourceUrl: string;
  voteSourceUrl: string;
  billSourceUrl: string;
}

export function assembleFlags(input: {
  memberId: string;
  windowDays: number;
  coverage: { pacReceiptsThemed: number; pacReceiptsTotal: number };
  rows: NexusFlagRow[];
}): MoneyVoteFlags {
  const flags = input.rows
    .filter(r => r.daysBeforeVote >= 0 && r.daysBeforeVote <= input.windowDays)
    .sort((a, b) => a.moneyDate.localeCompare(b.moneyDate) || a.voteDate.localeCompare(b.voteDate));
  return MoneyVoteFlagsSchema.parse({
    memberId: input.memberId,
    windowDays: input.windowDays,
    coverage: input.coverage,
    flags,
  });
}
```

- [ ] **Step 4: Run, verify it passes** — `npx tsx --test pipeline/detect-money-votes.test.ts` → PASS (5 tests).

- [ ] **Step 5: Commit**
```bash
git add pipeline/detect-money-votes.ts pipeline/detect-money-votes.test.ts
git commit -m "feat(pipeline): pure assembleFlags for the money->vote detector"
```

---

## Task 4: Schema — `fec_contributions`, `pac_theme`, `v_donor_vote_nexus`

**Files:**
- Modify: `db/schema.sql` (add two tables near `donor_industry_theme` ~line 594; add the view after `v_theme_eligible_votes` ~line 708)

**Interfaces:**
- Produces: table `fec_contributions(member_id, committee_id, transaction_id, contributor_name, entity_type, amount, contribution_date, cycle, image_number, pdf_url, source_url, fetched_at)`; table `pac_theme(committee_pattern, theme, note)`; view `v_donor_vote_nexus` with columns matching `NexusFlagRow` snake_case (consumed by Task 6 query).

- [ ] **Step 1: Add the tables** to `db/schema.sql`:
```sql
-- Itemized non-individual (PAC) Schedule A receipts to a member's principal
-- campaign committee. The dated, filing-cited money the #6 detector threads to
-- votes. Individual itemized receipts are intentionally NOT stored (154k/member-
-- cycle; sector classification needs OpenSecrets' proprietary employer crosswalk).
CREATE TABLE IF NOT EXISTS fec_contributions (
  member_id         TEXT NOT NULL,
  committee_id      TEXT NOT NULL,       -- recipient (member's) committee
  transaction_id    TEXT,               -- FEC SA tx id; nullable on some rows
  contributor_name  TEXT NOT NULL,      -- the PAC name
  entity_type       TEXT,               -- PAC | COM | ORG | CCM | PTY | IND
  amount            DOUBLE NOT NULL,
  contribution_date DATE,
  cycle             INTEGER NOT NULL,
  image_number      TEXT,
  pdf_url           TEXT,
  source_url        TEXT,
  fetched_at        TIMESTAMP NOT NULL
  -- No PRIMARY KEY: FEC repeats transaction_id (amendments). Idempotent via the
  -- loader's DELETE-then-insert per (member_id, cycle).
);

-- PAC-name → theme crosswalk. Same hand-curated, version-controlled philosophy
-- as donor_industry_theme/sic_theme: an ILIKE pattern on contributor_name maps a
-- genuine industry/trade PAC to one of the 12 themes. Leadership PACs, JFCs,
-- conduits (WinRed/ActBlue), and ideological PACs are deliberately UNMAPPED ->
-- excluded from the detector (they carry no industry theme). Seeded by
-- db/load-sector-crosswalk.ts.
CREATE TABLE IF NOT EXISTS pac_theme (
  committee_pattern TEXT NOT NULL,   -- ILIKE pattern on fec_contributions.contributor_name
  theme             TEXT NOT NULL,   -- one of the theme_bill_match themes
  note              TEXT
);
```

- [ ] **Step 2: Add the view** to `db/schema.sql` (mirror `v_trade_bill_nexus` guards exactly; theme comes from the PAC, bill-matched like the trade nexus):
```sql
-- Money↔vote nexus (the #6 detector's SQL spine). A themed PAC contribution
-- dated on/before a theme-matched vote. Theme is PAC-anchored (pac_theme) and
-- must equal the bill's theme — same credible-loop shape as v_trade_bill_nexus.
-- Window is NOT applied here (the TS detector filters days_before_vote <= 30).
CREATE OR REPLACE VIEW v_donor_vote_nexus AS
SELECT DISTINCT
  c.member_id,
  pt.theme,
  c.contributor_name        AS committee_name,
  'S'                       AS support_oppose,   -- direct receipts support the member
  COALESCE(c.transaction_id, c.image_number) AS filing_id,  -- BLOCKER FIX (#1): image-only
                                                            -- rows are kept by the loader
                                                            -- (Task 6 drops only when BOTH are
                                                            -- null), so transaction_id alone
                                                            -- would NULL out filing_id and make
                                                            -- MoneyVoteFlagSchema.parse throw.
                                                            -- COALESCE is guaranteed non-null.
  c.amount,
  c.contribution_date       AS money_date,
  v.vote_id, v.date         AS vote_date, v.position AS vote_position,
  v.bill_id, bsum.title     AS bill_title,
  date_diff('day', c.contribution_date, v.date) AS days_before_vote,
  COALESCE(c.pdf_url, c.source_url) AS money_source_url,
  v.source_url              AS vote_source_url,
  bsum.source_url           AS bill_source_url
FROM fec_contributions c
JOIN pac_theme          pt   ON c.contributor_name ILIKE pt.committee_pattern
JOIN votes              v    ON v.member_id = c.member_id
JOIN bill_subjects      bsub ON bsub.bill_id = v.bill_id
LEFT JOIN bill_summaries bsum ON bsum.bill_id = v.bill_id
JOIN theme_bill_match   m    ON m.theme = pt.theme
  AND ( (m.policy_area     IS NOT NULL AND bsub.policy_area = m.policy_area)
     OR (m.subject_pattern IS NOT NULL AND bsub.subject ILIKE m.subject_pattern
          AND (SELECT COUNT(*) FROM bill_subjects b2 WHERE b2.bill_id = v.bill_id) <= 25) )
WHERE c.contribution_date IS NOT NULL
  AND v.bill_id IS NOT NULL
  AND bsum.title IS NOT NULL
  AND date_diff('day', c.contribution_date, v.date) >= 0
  AND LENGTH(bsum.title) >= 6
  AND bsum.title NOT ILIKE 'Providing for consideration%'
  AND bsum.title NOT ILIKE '%appropriations%'
  AND bsum.title NOT ILIKE '%consolidated%'
  AND bsum.title NOT ILIKE '%continuing%'
  AND bsum.title NOT ILIKE '%relief act%'
  AND bsum.title NOT ILIKE '%reconciliation%'
  AND bsum.title NOT ILIKE '%omnibus%'
  AND bsum.title NOT ILIKE '%national defense authorization%'
  AND bsum.title NOT ILIKE '%rescissions act%'
  AND regexp_extract(v.bill_id, '-(hr|s|hjres|sjres)-', 1) <> '';
```

- [ ] **Step 3: Apply schema to the live DB and verify the view compiles** (empty result is fine; the table is unpopulated until Task 5):
```bash
npx tsx -e "import('./db/init.js').then(async m=>{const c=await m.getDb(); await c.run('SELECT count(*) FROM v_donor_vote_nexus'); console.log('view ok');})"
```
Expected: `view ok` (DDL is in `db/init.ts`'s schema bootstrap — confirm the new statements run; if `db/init.ts` reads `schema.sql`, no code change is needed).

- [ ] **Step 4: Commit**
```bash
git add db/schema.sql
git commit -m "feat(db): fec_contributions + pac_theme + v_donor_vote_nexus for #6"
```

---

## Task 5: FEC Schedule A fetcher `lib/fec-contributions.ts`

**Files:**
- Create: `lib/fec-contributions.ts`

**Interfaces:**
- Consumes: the FEC HTTP/cache helpers' pattern from `lib/fec-ie.ts` (reuse `BASE`, key loading, retry, cursor pagination — copy the minimal helpers or import if exported).
- Produces:
  - `interface PacReceipt { transactionId: string | null; contributorName: string; entityType: string | null; amount: number; contributionDate: string | null; imageNumber: string | null; pdfUrl: string | null; sourceUrl: string | null; }`
  - `async function principalCommittee(candidateId: string): Promise<string>` — `/candidate/{id}/committees/`, returns the `designation === 'P'` committee_id (fallback: first result).
  - `async function fetchPacReceipts(committeeId: string, cycle: number, opts?: { refresh?: boolean }): Promise<PacReceipt[]>` — `/schedules/schedule_a/` with `is_individual=false`, `sort=-contribution_receipt_amount`, cursor pagination (`last_index` + `last_contribution_receipt_amount`), cached under `data/caches/pfd-cache/fec-contributions/{committeeId}/{cycle}.json`. Consumed by Task 6 loader.

- [ ] **Step 1: Implement the fetcher** (model on `lib/fec-ie.ts` `fetchItemizedIE` cursor loop; `pdfUrl`/`sourceUrl` from `r.pdf_url` and the FEC receipt permalink):
```ts
/**
 * FEC Schedule A non-individual (PAC) receipts to a member's principal committee.
 * The dated, filing-cited money the #6 money->vote detector threads to votes.
 * Individual receipts are intentionally excluded (volume + classification).
 * See SOURCES.md → "Schedule A — itemized receipts (non-individual)".
 *   npx tsx lib/fec-contributions.ts S8MO00160 2024
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ENV_PATH, PFD_CACHE } from './paths.js';

const BASE = 'https://api.open.fec.gov/v1';
const UA = 'CivicLens/1.0 (research; civiclens.org)';
const PAGE_SIZE = 100;
const REQUEST_DELAY_MS = 250;
const CACHE_ROOT = join(PFD_CACHE, 'fec-contributions');

let envLoaded = false;
function loadEnvOnce() {
  if (envLoaded) return; envLoaded = true;
  if (process.env.OPENFEC_API_KEY) return;
  try {
    for (const line of readFileSync(ENV_PATH, 'utf-8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
}
function apiKey(): string {
  loadEnvOnce();
  const k = process.env.OPENFEC_API_KEY;
  if (!k) throw new Error('OPENFEC_API_KEY not set in environment');
  return k;
}
async function get<T = any>(path: string, params: Record<string, string | number>, maxAttempts = 4): Promise<T> {
  const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), api_key: apiKey() });
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await fetch(`${BASE}${path}?${qs}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(90_000) });
      if (r.ok) return (await r.json()) as T;
      if (!(r.status === 429 || r.status >= 500) || attempt === maxAttempts) throw new Error(`HTTP ${r.status} ${path}`);
    } catch (e: any) { lastErr = e; if (attempt === maxAttempts) break; }
    await new Promise(res => setTimeout(res, 600 * Math.pow(3, attempt - 1)));
  }
  throw lastErr!;
}
const pause = () => new Promise(r => setTimeout(r, REQUEST_DELAY_MS));

export interface PacReceipt {
  transactionId: string | null; contributorName: string; entityType: string | null;
  amount: number; contributionDate: string | null; imageNumber: string | null;
  pdfUrl: string | null; sourceUrl: string | null;
}

export async function principalCommittee(candidateId: string): Promise<string> {
  const d = await get<any>(`/candidate/${candidateId.trim().toUpperCase()}/committees/`, {});
  const results = d.results ?? [];
  const principal = results.find((c: any) => c.designation === 'P');
  const cid = (principal ?? results[0])?.committee_id;
  if (!cid) throw new Error(`no committee for candidate ${candidateId}`);
  return cid;
}

export async function fetchPacReceipts(committeeId: string, cycle: number, opts: { refresh?: boolean } = {}): Promise<PacReceipt[]> {
  const cacheFile = join(CACHE_ROOT, committeeId, `${cycle}.json`);
  if (!opts.refresh && existsSync(cacheFile)) {
    try { return JSON.parse(readFileSync(cacheFile, 'utf8')) as PacReceipt[]; } catch {}
  }
  const out: PacReceipt[] = [];
  let li: string | null = null, la: number | null = null, page = 1;
  while (true) {
    const params: Record<string, string | number> = {
      committee_id: committeeId, two_year_transaction_period: cycle,
      per_page: PAGE_SIZE, is_individual: 'false', sort: '-contribution_receipt_amount',
    };
    if (li && la != null) { params.last_index = li; params.last_contribution_receipt_amount = la; }
    else params.page = page;
    const d = await get<any>('/schedules/schedule_a/', params);
    const results = d.results ?? [];
    for (const r of results) {
      out.push({
        transactionId: r.transaction_id ?? null,
        contributorName: r.contributor_name ?? '',
        entityType: r.entity_type ?? null,
        amount: Number(r.contribution_receipt_amount ?? 0),
        contributionDate: r.contribution_receipt_date ? String(r.contribution_receipt_date).slice(0, 10) : null,
        imageNumber: r.image_number ?? null,
        pdfUrl: r.pdf_url ?? null,
        sourceUrl: r.pdf_url ?? null,
      });
    }
    if (!results.length) break;
    const lix = d.pagination?.last_indexes;
    if (lix?.last_index && lix?.last_contribution_receipt_amount != null) {
      li = String(lix.last_index); la = Number(lix.last_contribution_receipt_amount);
    } else if (page < (d.pagination?.pages ?? 1)) { page += 1; }
    else break;
    await pause();
  }
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(out, null, 2));
  return out;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [, , candidateId, cycleStr] = process.argv;
  if (!candidateId || !cycleStr) { console.error('usage: tsx lib/fec-contributions.ts <candidate_id> <cycle>'); process.exit(1); }
  principalCommittee(candidateId)
    .then(cid => fetchPacReceipts(cid, Number(cycleStr), { refresh: true }).then(rs => {
      console.log(`${candidateId} -> ${cid} cycle ${cycleStr}: ${rs.length} non-individual receipts`);
      for (const r of rs.slice(0, 10)) console.log(`  ${r.contributionDate} $${r.amount} [${r.entityType}] ${r.contributorName}`);
    }))
    .catch(e => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 2: Smoke test the fetcher**
```bash
npx tsx lib/fec-contributions.ts S8MO00160 2024
```
Expected: `S8MO00160 -> C00652727 cycle 2024: ~5xx non-individual receipts` then 10 dated rows. Confirms principal-committee resolution + pagination + cache write.

- [ ] **Step 3: Commit**
```bash
git add lib/fec-contributions.ts
git commit -m "feat(fec): non-individual Schedule A receipts fetcher for #6"
```

---

## Task 6: Loader + detector DB glue

**Files:**
- Create: `db/load-fec-contributions.ts`
- Modify: `pipeline/detect-money-votes.ts` (add `detectMember()` DB glue + `main()`)

**Interfaces:**
- Consumes: `principalCommittee`, `fetchPacReceipts` (Task 5); `assembleFlags`, `WINDOW_DAYS`, `NexusFlagRow` (Task 3); `getDb` (`db/init.ts`).
- Produces: `db/load-fec-contributions.ts` populating `fec_contributions` (DELETE-then-insert per `(member_id, cycle)`); `detectMember(member)` writing `pipeline/artifacts/{member}.money-votes.json`.

- [ ] **Step 1: Write the loader** `db/load-fec-contributions.ts` — for each member with `fec_candidate_id`, resolve principal committee, fetch receipts per cycle (default cycles `[2024, 2026]`), DELETE-then-insert into `fec_contributions`. Build `source_url` as the FEC receipt permalink when `pdf_url` is null. Mirror the idempotency + logging style of `db/load-fec-ie.ts`.

  **Grok review fixes (apply at load):**
  - **Entity filter:** keep only `entity_type IN ('PAC','COM','ORG')` — drop `IND` (stray individuals on the non-individual page), `CCM`, `PTY`. Industry money lives in PAC/ORG; COM is kept but stays unmapped (JFC transfers).
  - **Cite integrity:** a hit must be row-citable. Build a stable `cite_key = COALESCE(transaction_id, image_number || '|' || contribution_date || '|' || amount || '|' || contributor_name)`. **Drop rows where BOTH `transaction_id` and `image_number` are null** (uncitable — would violate the #3 row-enumeration guard).
  - **Amendment dedupe:** dedupe receipts on `cite_key` before insert (FEC repeats `transaction_id` across amendments/election-type splits) — keep the max-amount row per key.
```ts
// After fetch, filter + dedupe in TS before insert:
const KEEP = new Set(['PAC', 'COM', 'ORG']);
const byKey = new Map<string, PacReceipt>();
for (const r of receipts) {
  if (r.entityType && !KEEP.has(r.entityType)) continue;
  if (!r.transactionId && !r.imageNumber) continue;            // uncitable -> drop
  const key = r.transactionId ?? `${r.imageNumber}|${r.contributionDate}|${r.amount}|${r.contributorName}`;
  const prev = byKey.get(key);
  if (!prev || r.amount > prev.amount) byKey.set(key, r);
}
// Key insert shape (per deduped receipt):
await conn.run(
  `INSERT INTO fec_contributions
     (member_id, committee_id, transaction_id, contributor_name, entity_type, amount,
      contribution_date, cycle, image_number, pdf_url, source_url, fetched_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?, now())`,
  [memberId, committeeId, r.transactionId, r.contributorName, r.entityType, r.amount,
   r.contributionDate, cycle, r.imageNumber, r.pdfUrl, r.sourceUrl]);
```

- [ ] **Step 2: Run the loader for one member** (smoke)
```bash
npx tsx db/load-fec-contributions.ts --member josh-hawley
```
Expected: `josh-hawley: inserted ~5xx non-individual receipts (cycles 2024,2026)`.

- [ ] **Step 3: Add `detectMember()` + `main()`** to `pipeline/detect-money-votes.ts`:
```ts
async function detectMember(member: string): Promise<void> {
  const conn = await getDb();
  const rows = (await (await conn.run(
    `SELECT theme, committee_name AS "committeeName", support_oppose AS "supportOppose",
            filing_id AS "filingId", amount, money_date::text AS "moneyDate",
            vote_id::text AS "voteId", vote_date::text AS "voteDate", vote_position AS "votePosition",
            bill_id AS "billId", bill_title AS "billTitle", days_before_vote::int AS "daysBeforeVote",
            money_source_url AS "moneySourceUrl", vote_source_url AS "voteSourceUrl", bill_source_url AS "billSourceUrl"
       FROM v_donor_vote_nexus WHERE member_id = ?
      ORDER BY "moneyDate", "voteDate", "filingId"`,
    [member],
  )).getRowObjects()) as unknown as NexusFlagRow[];

  const themed = (await (await conn.run(
    `SELECT count(*)::int AS c FROM fec_contributions c
       JOIN pac_theme pt ON c.contributor_name ILIKE pt.committee_pattern
      WHERE c.member_id = ?`, [member])).getRowObjects())[0] as unknown as { c: number };
  const total = (await (await conn.run(
    `SELECT count(*)::int AS c FROM fec_contributions WHERE member_id = ?`, [member])).getRowObjects())[0] as unknown as { c: number };

  const art = assembleFlags({
    memberId: member, windowDays: WINDOW_DAYS,
    coverage: { pacReceiptsThemed: themed.c, pacReceiptsTotal: total.c },
    rows,
  });
  const out = `pipeline/artifacts/${member}.money-votes.json`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(art, null, 2));
  console.log(`${member}: ${art.flags.length} money->vote flags (themed=${themed.c}/${total.c}) -> ${out}`);
}

async function main(): Promise<void> {
  const i = process.argv.indexOf('--member');
  if (i === -1 || !process.argv[i + 1]) { console.error('usage: detect-money-votes.ts --member <slug>'); process.exit(2); }
  await detectMember(process.argv[i + 1]);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Run the detector** (will emit 0 flags until the crosswalk is seeded in Task 7 — that's expected and valid)
```bash
npx tsx pipeline/detect-money-votes.ts --member josh-hawley
```
Expected: `josh-hawley: 0 money->vote flags (themed=0/5xx) -> pipeline/artifacts/josh-hawley.money-votes.json`.

- [ ] **Step 5: Commit**
```bash
git add db/load-fec-contributions.ts pipeline/detect-money-votes.ts
git commit -m "feat(pipeline): FEC contributions loader + money->vote detector DB glue"
```

---

## Task 7: Seed `pac_theme` from real loaded data

**Files:**
- Modify: `db/load-sector-crosswalk.ts` (add a `pac_theme` seed block mirroring the `donor_industry_theme` block ~line 275)

**Interfaces:**
- Consumes: `fec_contributions` populated (Task 6).
- Produces: `pac_theme` rows. Detector now emits non-zero flags where real industry-PAC money precedes theme-matched votes.

- [ ] **Step 1: Probe the real unmapped PAC names** (source-first — curate only from names that exist)
```bash
npx tsx -e "import('./db/init.js').then(async m=>{const c=await m.getDb();const rs=await(await c.run(\`SELECT contributor_name, count(*) n, sum(amount)::bigint amt FROM fec_contributions WHERE entity_type IN ('PAC','ORG','COM') GROUP BY 1 ORDER BY amt DESC LIMIT 60\`)).getRowObjects(); for(const r of rs) console.log(r.amt, r.n, r.contributor_name);})"
```

- [ ] **Step 1b (Grok fix): verify patterns are mutually exclusive.** A contribution that matches two `pac_theme` patterns mapping to *different* themes produces two `v_donor_vote_nexus` rows (DISTINCT keeps both — different `theme`), double-counting one filing. After seeding, assert no contributor matches >1 distinct theme:
```bash
npx tsx -e "import('./db/init.js').then(async m=>{const c=await m.getDb();const rs=await(await c.run(\`SELECT cn, count(DISTINCT theme) t FROM (SELECT c.contributor_name cn, pt.theme FROM fec_contributions c JOIN pac_theme pt ON c.contributor_name ILIKE pt.committee_pattern GROUP BY 1,2) GROUP BY 1 HAVING t>1\`)).getRowObjects(); console.log(rs.length? rs : 'OK: no multi-theme contributor');})"
```
Expected: `OK: no multi-theme contributor`. If any appear, narrow the offending patterns.

- [ ] **Step 2: Add the seed block** to `db/load-sector-crosswalk.ts`. Map ONLY genuine industry/trade PACs to their theme; leave leadership/JFC/conduit/ideological PACs unmapped. Verbatim theme strings. Patterns must be **mutually exclusive** (Step 1b). Starter set (extend from Step 1 output):
```ts
await conn.run(`DELETE FROM pac_theme`);
const PAC_THEME: Array<[string, string, string]> = [
  ['%REALTORS%PAC%',                'Real Estate',          'National Assoc of Realtors PAC'],
  ['%HOME BUILDERS%',              'Real Estate',          'NAHB'],
  ['%MORTGAGE BANKERS%',          'Real Estate',          ''],
  ['%BROADCASTERS%',              'Media & Telecom',      'NAB PAC'],
  ['%COMCAST%',                   'Media & Telecom',      ''],
  ['%AT&T%',                       'Media & Telecom',      ''],
  ['%VERIZON%',                    'Media & Telecom',      ''],
  ['%BANKERS ASSOCIATION%',       'Banks & Finance',      'ABA'],
  ['%CREDIT UNION%',              'Banks & Finance',      ''],
  ['%CAPITAL ONE%',               'Banks & Finance',      ''],
  ['%JPMORGAN%',                   'Banks & Finance',      ''],
  ['%GOLDMAN SACHS%',             'Banks & Finance',      ''],
  ['%VISA%',                       'Payments',             ''],
  ['%MASTERCARD%',                 'Payments',             ''],
  ['%AMERICAN EXPRESS%',          'Payments',             ''],
  ['%PFIZER%',                     'Pharma & Health',      ''],
  ['%PHARMACEUTICAL%',            'Pharma & Health',      'PhRMA + member PACs'],
  ['%MERCK%',                      'Pharma & Health',      ''],
  ['%AMGEN%',                      'Pharma & Health',      ''],
  ['%HOSPITAL ASSOCIATION%',      'Pharma & Health',      ''],
  ['%LOCKHEED%',                   'Defense & Aerospace',  ''],
  ['%RAYTHEON%',                   'Defense & Aerospace',  ''],
  ['%NORTHROP%',                   'Defense & Aerospace',  ''],
  ['%GENERAL DYNAMICS%',          'Defense & Aerospace',  ''],
  ['%BOEING%',                     'Defense & Aerospace',  ''],
  ['%EXXON%',                      'Energy',               ''],
  ['%CHEVRON%',                    'Energy',               ''],
  ['%PETROLEUM%',                 'Energy',               'API + co PACs'],
  ['%EDISON%',                     'Energy',               ''],
  ['%NEXTERA%',                    'Energy',               ''],
  ['%SEMICONDUCTOR%',             'Tech & Semiconductors',''],
  ['%QUALCOMM%',                   'Tech & Semiconductors',''],
  ['%INTEL%',                      'Tech & Semiconductors',''],
  ['%MICROSOFT%',                  'Tech & Semiconductors',''],
  ['%AIRLINES%',                   'Transportation',       ''],
  ['%UNION PACIFIC%',             'Transportation',       ''],
  ['%FEDEX%',                      'Transportation',       ''],
  ['%UPS%',                        'Transportation',       ''],
  ['%MANUFACTURERS%',             'Industrials',          'NAM'],
  ['%HONEYWELL%',                  'Industrials',          ''],
  ['%CATERPILLAR%',                'Industrials',          ''],
  ['%DEERE%',                      'Industrials',          ''],
  ['%MINING ASSOCIATION%',        'Materials & Mining',   ''],
  ['%STEEL%',                      'Materials & Mining',   ''],
  ['%NATIONAL RESTAURANT%',       'Retail & Consumer',    ''],
  ['%WALMART%',                    'Retail & Consumer',    ''],
  ['%RETAIL FEDERATION%',         'Retail & Consumer',    ''],
];
for (const [pattern, theme, note] of PAC_THEME) {
  await conn.run(`INSERT INTO pac_theme (committee_pattern, theme, note) VALUES (?,?,?)`, [pattern, theme, note]);
}
console.log(`seeded ${PAC_THEME.length} pac_theme rows`);
```

- [ ] **Step 3: Re-seed and re-run the detector**
```bash
npx tsx db/load-sector-crosswalk.ts && npx tsx pipeline/detect-money-votes.ts --member josh-hawley
```
Expected: non-zero `themed=N/5xx`; flags appear only where a themed PAC contribution precedes a theme-matched vote within 30d. Spot-check 1–2 flags are real (PAC name → theme → bill subject all coherent).

- [ ] **Step 4: Commit**
```bash
git add db/load-sector-crosswalk.ts
git commit -m "feat(db): seed pac_theme crosswalk (industry PACs only, curated from live data)"
```

---

## Task 8: Render section + tests

**Files:**
- Modify: `render/build.ts` (add `renderMoneyVotesSection`, exported, near `renderReceiptsSection` ~line 102)
- Create: `render/money-votes.test.ts`
- Modify: `package.json` (widen test glob)

**Interfaces:**
- Consumes: `MoneyVoteFlags` (Task 2), the `esc` / `fmtN` / `fmtMoney` helpers in `render/build.ts`.
- Produces: `renderMoneyVotesSection(a: MoneyVoteFlags): string`.

- [ ] **Step 1: Write failing render tests** `render/money-votes.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMoneyVotesSection } from './build.js';
import type { MoneyVoteFlags } from '../lib/schemas.js';

const base: MoneyVoteFlags = {
  memberId: 'm', windowDays: 30, coverage: { pacReceiptsThemed: 0, pacReceiptsTotal: 18 }, flags: [],
};

test('zero flags renders an explicit empty state, not omission', () => {
  const html = renderMoneyVotesSection(base);
  assert.match(html, /no .*money.*vote.*(flag|on record)/i);
});

test('coverage strip states themed/total honestly', () => {
  const html = renderMoneyVotesSection({ ...base, coverage: { pacReceiptsThemed: 3, pacReceiptsTotal: 18 } });
  assert.match(html, /18/);
  assert.match(html, /3 .*theme/i);
});

test('a flag renders the dated money->vote juxtaposition with all three cite links', () => {
  const html = renderMoneyVotesSection({
    ...base, coverage: { pacReceiptsThemed: 1, pacReceiptsTotal: 18 },
    flags: [{ theme: 'Energy', committeeName: 'EXXON PAC', supportOppose: 'S', filingId: 't1',
      amount: 5000, moneyDate: '2024-02-01', voteId: 'v', voteDate: '2024-02-20', votePosition: 'Yea',
      billId: '118-hr-1', billTitle: 'Energy Act', daysBeforeVote: 19,
      moneySourceUrl: 'MU', voteSourceUrl: 'VU', billSourceUrl: 'BU' }],
  });
  assert.match(html, /EXXON PAC/);
  assert.match(html, /19 days later/i);
  assert.match(html, /Energy Act/);
  for (const u of ['MU', 'VU', 'BU']) assert.ok(html.includes(u), `cite ${u} present`);
});
```

- [ ] **Step 2: Run, verify it fails** — `npx tsx --test render/money-votes.test.ts` → FAIL (`renderMoneyVotesSection` undefined).

- [ ] **Step 3: Implement** `renderMoneyVotesSection` in `render/build.ts` (mirror `renderReceiptsSection` + `receiptCard`, using `esc`/`fmtN`/`fmtMoney`):
```ts
export function renderMoneyVotesSection(a: MoneyVoteFlags): string {
  const cov = `<p class="coverage">` +
    `${fmtN(a.coverage.pacReceiptsThemed)} theme-matched of ${fmtN(a.coverage.pacReceiptsTotal)} ` +
    `itemized PAC contributions on record. Window: ${a.windowDays} days.</p>`;
  if (a.flags.length === 0) {
    return `<section class="money-votes"><h2>Money–vote timing</h2>${cov}` +
      `<p class="empty">No money→vote flags on record for this member in the ${a.windowDays}-day window.</p></section>`;
  }
  return `<section class="money-votes"><h2>Money–vote timing</h2>${cov}` +
    a.flags.map(moneyVoteCard).join('') + `</section>`;
}

function moneyVoteCard(f: MoneyVoteFlags['flags'][number]): string {
  return `<article class="flag" data-theme="${esc(f.theme)}">` +
    `<a href="${esc(f.moneySourceUrl)}">${esc(f.committeeName)}</a> gave ${fmtMoney(f.amount)} on ${esc(f.moneyDate)} — ` +
    `<b>${f.daysBeforeVote} days later</b> → ` +
    `<a href="${esc(f.voteSourceUrl)}">voted ${esc(f.votePosition ?? '')}</a> on ` +
    `<a href="${esc(f.billSourceUrl)}">${esc(f.billTitle)}</a> (${esc(f.voteDate)})</article>`;
}
```
Add `import type { MoneyVoteFlags } from '../lib/schemas.js';` if not already imported in `render/build.ts`.

- [ ] **Step 4: Run, verify it passes** — `npx tsx --test render/money-votes.test.ts` → PASS (3 tests).

- [ ] **Step 5: Widen the test glob** in `package.json` so `pipeline/*.test.ts` (this detector + the existing `score-theme-gaps.test.ts`) run under `npm test`:
```json
"test": "tsx --test pipeline/*.test.ts pipeline/patterns/*.test.ts render/*.test.ts agents/*.test.ts",
```

- [ ] **Step 6: Run the full suite** — `npm test`. Expected: baseline 49 + 3 score-theme-gaps (newly included) + 5 detect-money-votes + 3 money-votes = **60 pass, 0 fail**.

- [ ] **Step 7: Commit**
```bash
git add render/build.ts render/money-votes.test.ts package.json
git commit -m "feat(render): deterministic money-vote section + widen test glob"
```

---

## Task 9: Wire into the member page + end-to-end smoke

**Files:**
- Modify: `render/build.ts` (add `loadMoneyVotesOrSentinel` + fill the #7-reserved `sec-money-votes` slot with `renderMoneyVotesSection`; reads `pipeline/artifacts/{member}.money-votes.json` only — see blocker fix #3)
- ~~Modify: `db/load-from-tasks.ts`~~ — **removed (blocker fix #3):** render reads the artifact file directly via the sentinel loader; no DB-sync path.

**Interfaces:**
- Consumes: `renderMoneyVotesSection` (Task 8), `MoneyVoteFlagsSchema` for typed reads (parity with the typed-artifact-reads work).

> **BLOCKER FIXES (post-Grok 2026-06-19) — read before implementing this task:**
>
> **(#2) Sequencing — #7 lands first.** Issue #7 (`2026-06-18-uniform-member-skeleton.md`) owns `buildMemberPage` and reserves a `sec-money-votes` slot. This task does **NOT** patch `buildMemberPage` ad-hoc and does **NOT** touch receipts wiring. It only fills the reserved `sec-money-votes` slot with `renderMoneyVotesSection`. If #7 has not landed when starting this task, **stop and land #7 first** (or its skeleton seam) — do not race it. Confirm the seam exists before Step 1: `rg -n 'sec-money-votes' render/build.ts` must return the reserved slot.
>
> **(#3) Single render path + sentinel contract.** The render reads exactly ONE source: the artifact file `pipeline/artifacts/{member}.money-votes.json`. No `load-from-tasks` sync, no "read the view directly" path. Mirror #7's `loadThemeGapsOrSentinel`: add `loadMoneyVotesOrSentinel(member): MoneyVoteFlags` that, when the file is missing or unparseable, returns a **valid empty artifact** (`{ memberId, windowDays: WINDOW_DAYS, coverage: {pacReceiptsThemed:0,pacReceiptsTotal:0}, flags: [] }`) so the section always renders its explicit empty state (uniform-skeleton rule) — never crashes, never omits. Present artifacts are parsed with `MoneyVoteFlagsSchema.parse` (typed-read parity, PR2).

- [ ] **Step 1: Confirm the #7 seam exists, then locate the slot**
```bash
rg -n 'sec-money-votes|loadThemeGapsOrSentinel|buildMemberPage' render/build.ts
```
Expected: the reserved `sec-money-votes` slot from #7 is present. If it is NOT, land #7 first (blocker #2). Add `loadMoneyVotesOrSentinel` next to #7's loader and call `renderMoneyVotesSection(loadMoneyVotesOrSentinel(member))` into the reserved slot only. Do not add or move the receipts section here.

- [ ] **Step 2: End-to-end on one member**
```bash
npx tsx db/load-fec-contributions.ts --member josh-hawley \
  && npx tsx db/load-sector-crosswalk.ts \
  && npx tsx pipeline/detect-money-votes.ts --member josh-hawley \
  && npx tsx render/build.ts josh-hawley
```
Expected: member page renders a "Money–vote timing" section (populated or explicit empty state). No crash, no LLM call.

- [ ] **Step 3: Run full suite + corpus validation**
```bash
npm test && npm run validate:corpus
```
Expected: 60 pass; corpus still valid.

- [ ] **Step 4: Commit**
```bash
git add render/build.ts
git commit -m "feat(render): surface money-vote section on the member page (#6)"
```

---

## Deferred (filed, not built here)

- **Individual itemized receipts** (employer→industry→theme): 154k/member-cycle volume + needs OpenSecrets-grade employer classification. File as a separate enrichment issue; revisit if a classification source is acquired.
- **Per-theme weighting / statistical null** for money→vote (analogue of Lane 1's `perPairLowerTail`): #6 is a deterministic detector; a power-banded ranking is a separate slice.

## Self-Review Notes

- **Spec coverage (#6 acceptance criteria):** SQL detector + typed schema (Tasks 2,4) ✓; dated row-cited hits with vote_id/filing_id/day-gap/bill/theme (Tasks 3,4) ✓; no aggregate without rows (each flag carries its filing — Task 8 card) ✓; named-constant 30d window tunable in TS (Task 3) ✓; empty-as-data (Tasks 3,8) ✓; deterministic render in uniform skeleton (Tasks 8,9) ✓; constructed-hit + zero-hit tests (Tasks 3,8) ✓.
- **Type consistency:** `NexusFlagRow` (camelCase) ↔ `v_donor_vote_nexus` (snake_case, aliased in the Task 6 query) ↔ `MoneyVoteFlagSchema` fields — all aligned. `supportOppose` enum `'S'|'O'`; view emits literal `'S'`.
- **No-LLM / no-stub / row-enumeration / before-not-after constraints** honored throughout.
