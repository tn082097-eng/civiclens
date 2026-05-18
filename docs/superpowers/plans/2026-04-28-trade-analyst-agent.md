# Trade Analyst Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Trade Analyst pipeline agent that queries `v_suspicious_trades` from DuckDB, generates a factual analytical prose paragraph about the member's strongest trade-vote proximity patterns, and renders it as a separate "Trade activity" section on the member profile page.

**Architecture:** New `agents/trade-analyst.ts` reads directly from DuckDB (no Researcher dependency), computes a deterministic suspicion level, calls the LLM for narrative prose, and writes `trade-analyst.json`. Pipeline inserts it between Connection Mapper and Summarizer. The Summarizer reads `topFindings` as enrichment context. `load-from-tasks.ts` persists `trade_activity` to the `members` table; `render/build.ts` renders it with a suspicion-level badge.

**Tech Stack:** TypeScript, DuckDB (`@duckdb/node-api`), shared pipeline utilities (`readPipe`, `writePipe`, `markAgent`, `llm`), grok-4.20 (via `LLM_SUMMARIZER_MODEL` env var).

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `lib/types.ts` | Modify | Add `'trade-analyst'` to `AgentName`; add `'analyzing-trades'` to `PipelineStatus` |
| `db/schema.sql` | Modify | Add `trade_activity TEXT` column to `members` table |
| `agents/trade-analyst.ts` | Create | Query DB, compute suspicion level, call LLM, write pipe |
| `agents/pipeline.ts` | Modify | Import + call `runTradeAnalyst`; add agent to `initTask` defaults |
| `agents/summarizer.ts` | Modify | Read `trade-analyst.json`, append `topFindings` to user prompt |
| `agents/code-checker.ts` | Modify | Add `tradeNarrative` to `shipSurface` neutrality scan |
| `db/load-from-tasks.ts` | Modify | Read `trade-analyst.json` and `UPDATE members SET trade_activity` |
| `render/build.ts` | Modify | Add `trade_activity` to `MemberDetail`; render "Trade activity" section with badge |

---

## Task 1: Extend types

**Files:**
- Modify: `lib/types.ts`

- [ ] **Step 1: Add `'trade-analyst'` to `AgentName` and `'analyzing-trades'` to `PipelineStatus`**

In `lib/types.ts`, the `AgentName` union currently ends with `'publisher'`. Add `'trade-analyst'` between `'connection-mapper'` and `'summarizer'`. Add `'analyzing-trades'` to `PipelineStatus` after `'connecting'`:

```typescript
export type AgentName =
  | 'brain'
  | 'researcher'
  | 'data-checker'
  | 'predictor'
  | 'connection-mapper'
  | 'trade-analyst'        // ← new
  | 'summarizer'
  | 'coder'
  | 'code-checker'
  | 'visualizer'
  | 'final-reviewer'
  | 'publisher';

export type PipelineStatus =
  | 'initializing'
  | 'researching'
  | 'validating'
  | 'predicting'
  | 'connecting'
  | 'analyzing-trades'     // ← new
  | 'summarizing'
  | 'coding'
  | 'reviewing-code'
  | 'visualizing'
  | 'final-review'
  | 'publishing'
  | 'complete'
  | 'failed';
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd ~/.hermes/civiclens && ./node_modules/.bin/tsc --noEmit 2>&1 | head -20
```

Expected: errors only about `'trade-analyst'` missing from `initTask`'s `agents` record (fixed in Task 3). No other errors.

- [ ] **Step 3: Commit**

```bash
cd ~/.hermes/civiclens && git add lib/types.ts && git commit -m "feat(types): add trade-analyst agent and analyzing-trades pipeline status"
```

---

## Task 2: Add `trade_activity` column to schema

**Files:**
- Modify: `db/schema.sql`

- [ ] **Step 1: Add the column to the `members` table definition**

In `db/schema.sql`, find the `CREATE TABLE IF NOT EXISTS members` block. Add `trade_activity TEXT` after `fec_candidate_id`:

```sql
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
  trade_activity      TEXT,          -- ← new: LLM-generated trade analyst prose
  bio_summary         TEXT,
  bio_source_url      TEXT,
  fetched_at          TIMESTAMP NOT NULL
);
```

- [ ] **Step 2: Apply schema to the live DB**

```bash
cd ~/.hermes/civiclens && ./node_modules/.bin/tsx db/init.ts 2>&1
```

Expected: `schema applied: /home/captainanime/.hermes/civiclens/civiclens.duckdb`

- [ ] **Step 3: Verify column exists**

```bash
cd ~/.hermes/civiclens && cat > /tmp/check-col.ts << 'EOF'
import { getDb } from './db/init.js';
const db = await getDb();
const r = await db.run(`DESCRIBE members`);
console.table(await r.getRowObjects());
EOF
./node_modules/.bin/tsx /tmp/check-col.ts 2>&1 | grep -E "trade_activity|column_name"
```

Expected: a row with `column_name: 'trade_activity'` and `column_type: 'VARCHAR'`.

- [ ] **Step 4: Commit**

```bash
cd ~/.hermes/civiclens && git add db/schema.sql && git commit -m "feat(schema): add trade_activity column to members table"
```

---

## Task 3: Create `agents/trade-analyst.ts`

**Files:**
- Create: `agents/trade-analyst.ts`

- [ ] **Step 1: Write the full agent file**

Create `~/.hermes/civiclens/agents/trade-analyst.ts`:

```typescript
import type { PipelineTask } from '../lib/types.js';
import {
  ok, fail, warn, spin,
  writePipe, markAgent, llm,
} from './shared.js';
import { getDb } from '../db/init.js';

export type SuspicionLevel = 'none' | 'low' | 'medium' | 'high';

export interface TradeFinding {
  tx_date: string;
  tx_type: string;
  asset: string;
  ticker: string | null;
  amount_band: string;
  days_before_vote: number;
  bill_title: string | null;
  vote_question: string | null;
  bill_source_url: string | null;
  member_on_bill_committee: boolean;
  member_committee_role: string | null;
}

export interface TradeAnalystOutput {
  taskId: string;
  analyzedAt: string;
  hasData: boolean;
  suspicionLevel: SuspicionLevel;
  tradeNarrative: string;
  topFindings: TradeFinding[];
  totalSuspiciousTrades: number;
}

function computeSuspicionLevel(findings: TradeFinding[]): SuspicionLevel {
  if (findings.length === 0) return 'none';
  const sameDayCount = findings.filter(f => f.days_before_vote === 0).length;
  const hasCommitteeWithin3 = findings.some(
    f => f.days_before_vote <= 3 && f.member_on_bill_committee,
  );
  const hasWithin3 = findings.some(f => f.days_before_vote <= 3);
  const hasCommittee = findings.some(f => f.member_on_bill_committee);
  if (hasCommitteeWithin3 || sameDayCount >= 3) return 'high';
  if (hasWithin3 || hasCommittee) return 'medium';
  return 'low';
}

function findingsToText(findings: TradeFinding[]): string {
  return findings.map((f, i) => {
    const timing = f.days_before_vote === 0
      ? 'same day as'
      : `${f.days_before_vote} day${f.days_before_vote === 1 ? '' : 's'} before`;
    const bill = f.bill_title ?? f.vote_question ?? '(unknown bill)';
    const committee = f.member_on_bill_committee
      ? ` [member sits on committee that handled this bill${f.member_committee_role && f.member_committee_role !== 'member' ? ` as ${f.member_committee_role}` : ''}]`
      : '';
    return `${i + 1}. ${f.tx_date}: ${f.tx_type} ${f.ticker ?? f.asset} (${f.amount_band}), ${timing} vote on "${bill}"${committee}`;
  }).join('\n');
}

export async function runTradeAnalyst(task: PipelineTask): Promise<boolean> {
  markAgent(task, 'trade-analyst', 'running');

  const ANALYST_MODEL = process.env.LLM_SUMMARIZER_MODEL ?? 'claude-sonnet-4-6';
  const memberName = task.target.name;

  // ── 1. Look up member_id from DB ────────────────────────────────────────────
  let memberId: string | null = null;
  let db: Awaited<ReturnType<typeof getDb>>;
  try {
    db = await getDb();
    const slug = memberName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const r = await db.run(
      `SELECT member_id FROM members WHERE member_id = ? OR LOWER(name) = LOWER(?) LIMIT 1`,
      [slug, memberName],
    );
    const rows = await r.getRowObjects() as any[];
    memberId = rows[0]?.member_id ?? null;
  } catch (e: any) {
    warn('Trade Analyst', `DB lookup failed: ${e.message}`);
    writeEmpty(task, 'none');
    return true; // non-fatal
  }

  if (!memberId) {
    warn('Trade Analyst', `member not in DB yet — skipping trade analysis`);
    writeEmpty(task, 'none');
    return true;
  }

  // ── 2. Query top suspicious trades ─────────────────────────────────────────
  let findings: TradeFinding[] = [];
  let totalSuspiciousTrades = 0;
  try {
    const r = await db.run(
      `SELECT DISTINCT asset, ticker, tx_type, tx_date::text AS tx_date, amount_band,
              days_before_vote, bill_title, vote_question,
              member_on_bill_committee, member_committee_role,
              bill_source_url, vote_source_url
       FROM v_suspicious_trades
       WHERE member_id = ?
         AND days_before_vote <= 30
       ORDER BY
         CASE
           WHEN days_before_vote = 0 AND member_on_bill_committee THEN 100
           WHEN days_before_vote = 0                              THEN 90
           WHEN days_before_vote <= 3 AND member_on_bill_committee THEN 85
           WHEN days_before_vote <= 3                             THEN 80
           WHEN member_on_bill_committee                          THEN 70
           ELSE 50
         END DESC,
         days_before_vote ASC
       LIMIT 5`,
      [memberId],
    );
    const rows = await r.getRowObjects() as any[];
    findings = rows.map((row: any): TradeFinding => ({
      tx_date:                  String(row.tx_date ?? ''),
      tx_type:                  String(row.tx_type ?? ''),
      asset:                    String(row.asset ?? ''),
      ticker:                   row.ticker ? String(row.ticker) : null,
      amount_band:              String(row.amount_band ?? ''),
      days_before_vote:         Number(row.days_before_vote),
      bill_title:               row.bill_title ? String(row.bill_title) : null,
      vote_question:            row.vote_question ? String(row.vote_question) : null,
      bill_source_url:          row.bill_source_url ? String(row.bill_source_url) : null,
      member_on_bill_committee: Boolean(row.member_on_bill_committee),
      member_committee_role:    row.member_committee_role ? String(row.member_committee_role) : null,
    }));

    const countR = await db.run(
      `SELECT COUNT(DISTINCT trade_filing_id) AS n FROM v_suspicious_trades WHERE member_id = ?`,
      [memberId],
    );
    const countRows = await countR.getRowObjects() as any[];
    totalSuspiciousTrades = Number(countRows[0]?.n ?? 0);
  } catch (e: any) {
    warn('Trade Analyst', `query failed: ${e.message}`);
    writeEmpty(task, 'none');
    return true;
  }

  if (findings.length === 0) {
    writeEmpty(task, 'none', totalSuspiciousTrades);
    ok('Trade Analyst', 'no discretionary trades before votes — N/A');
    return true;
  }

  // ── 3. Compute suspicion level (deterministic) ─────────────────────────────
  const suspicionLevel = computeSuspicionLevel(findings);
  const sentenceTarget = totalSuspiciousTrades > 10 ? '4–6' : '3–4';

  // ── 4. LLM narrative ────────────────────────────────────────────────────────
  spin('Trade Analyst', `generating ${suspicionLevel} suspicion narrative via ${ANALYST_MODEL}…`);

  const systemPrompt = `You are a sharp, neutral financial transparency analyst writing for a public accountability tool.
Your job is to analyze trade-vote proximity data for a U.S. member of Congress and write a factual,
analytical paragraph. You do not speculate about intent or legality — you only state what the records show.`;

  const userPrompt = `Write a ${sentenceTarget} sentence analytical paragraph about the most significant trade-vote proximity patterns for ${memberName}.

Focus on:
1. The strongest findings first — same-day trades, trades 1–3 days before a vote, and trades near bills where the member serves on the relevant committee.
2. State timing precisely: "purchased N days before", "sold the same day as".
3. If the member sat on a committee that handled the bill, state it factually.
4. Group related trades when possible (e.g. multiple purchases of the same ticker near the same bill).
5. If there are no particularly close patterns, say so concisely.

FORBIDDEN words (do NOT use): extreme, radical, corrupt, suspicious, illegal, improper,
dishonest, claims to, pretends to, hero, champion.

Do not use bullet points. Do not add a conclusion about legality or ethics.
Cite specific tickers, dates, amounts, and bill titles from the data.

Top findings (ranked by proximity and committee involvement):
${findingsToText(findings)}`;

  let tradeNarrative: string;
  try {
    tradeNarrative = await llm(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      { maxTokens: 700, timeoutMs: 120_000, model: ANALYST_MODEL },
    );
    process.stdout.write('\n');
  } catch (e: any) {
    process.stdout.write('\n');
    warn('Trade Analyst', `LLM failed: ${e.message} — skipping trade section`);
    writeEmpty(task, suspicionLevel, totalSuspiciousTrades);
    return true;
  }

  // ── 5. Write output ─────────────────────────────────────────────────────────
  const output: TradeAnalystOutput = {
    taskId:               task.taskId,
    analyzedAt:           new Date().toISOString(),
    hasData:              true,
    suspicionLevel,
    tradeNarrative,
    topFindings:          findings,
    totalSuspiciousTrades,
  };

  writePipe(task.taskId, 'trade-analyst', output);
  markAgent(task, 'trade-analyst', 'complete', { suspicionLevel, findings: findings.length });
  ok('Trade Analyst', `${findings.length} findings → ${suspicionLevel} suspicion`);
  return true;
}

function writeEmpty(
  task: PipelineTask,
  suspicionLevel: SuspicionLevel,
  totalSuspiciousTrades = 0,
): void {
  const output: TradeAnalystOutput = {
    taskId:               task.taskId,
    analyzedAt:           new Date().toISOString(),
    hasData:              false,
    suspicionLevel,
    tradeNarrative:       'N/A',
    topFindings:          [],
    totalSuspiciousTrades,
  };
  writePipe(task.taskId, 'trade-analyst', output);
  markAgent(task, 'trade-analyst', 'complete', { suspicionLevel, findings: 0 });
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
cd ~/.hermes/civiclens && ./node_modules/.bin/tsc --noEmit 2>&1 | grep "trade-analyst" | head -10
```

Expected: no errors referencing `trade-analyst.ts` (there will be errors in `pipeline.ts` and `shared.ts` about the missing agent key until Task 4).

- [ ] **Step 3: Commit**

```bash
cd ~/.hermes/civiclens && git add agents/trade-analyst.ts && git commit -m "feat(agents): add trade-analyst agent with weighted suspicion scoring"
```

---

## Task 4: Wire agent into `pipeline.ts`

**Files:**
- Modify: `agents/pipeline.ts`
- Modify: `agents/shared.ts` (initTask agents record)

- [ ] **Step 1: Add import to `pipeline.ts`**

At the top of `agents/pipeline.ts`, after the existing agent imports (around line 33), add:

```typescript
import { runTradeAnalyst } from './trade-analyst.js';
```

- [ ] **Step 2: Insert `runTradeAnalyst` call in `runPipeline`**

In `runPipeline`, find the block:

```typescript
  setStatus(task, 'connecting');
  const mapOk = await runConnectionMapper(task);
  if (!mapOk) {
    warn('Brain', 'Connection Mapper failed — continuing without network data');
  }

  setStatus(task, 'summarizing');
  let sumOk = await runSummarizer(task);
```

Replace with:

```typescript
  setStatus(task, 'connecting');
  const mapOk = await runConnectionMapper(task);
  if (!mapOk) {
    warn('Brain', 'Connection Mapper failed — continuing without network data');
  }

  setStatus(task, 'analyzing-trades');
  const tradeOk = await runTradeAnalyst(task);
  if (!tradeOk) {
    warn('Brain', 'Trade Analyst failed — continuing without trade section');
  }

  setStatus(task, 'summarizing');
  let sumOk = await runSummarizer(task);
```

- [ ] **Step 3: Add `'trade-analyst'` to the `initTask` agents record in `shared.ts`**

In `agents/shared.ts`, find `initTask`. The `agents` object lists every agent with `{ ...def }`. Add `'trade-analyst'` between `'connection-mapper'` and `'summarizer'`:

```typescript
export function initTask(taskId: string, targetName: string): PipelineTask {
  const def = { status: 'pending' as const, retries: 0 };
  const task: PipelineTask = {
    taskId,
    // ... other fields ...
    agents: {
      brain:               { ...def },
      researcher:          { ...def },
      'data-checker':      { ...def },
      predictor:           { ...def },
      'connection-mapper': { ...def },
      'trade-analyst':     { ...def },   // ← new
      summarizer:          { ...def },
      coder:               { ...def },
      'code-checker':      { ...def },
      visualizer:          { ...def },
      'final-reviewer':    { ...def },
      publisher:           { ...def },
    },
    // ...
  };
```

- [ ] **Step 4: Verify TypeScript compiles cleanly**

```bash
cd ~/.hermes/civiclens && ./node_modules/.bin/tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd ~/.hermes/civiclens && git add agents/pipeline.ts agents/shared.ts && git commit -m "feat(pipeline): wire trade-analyst between connection-mapper and summarizer"
```

---

## Task 5: Feed `topFindings` into Summarizer

**Files:**
- Modify: `agents/summarizer.ts`

- [ ] **Step 1: Read `trade-analyst.json` in `runSummarizer`**

In `agents/summarizer.ts`, after the existing `mapper` optional read (around line 20), add:

```typescript
  let tradeAnalyst: any = null;
  try { tradeAnalyst = readPipe<any>(task.taskId, 'trade-analyst'); } catch { /* optional */ }
```

- [ ] **Step 2: Append `topFindings` to the user prompt**

In `runSummarizer`, find the `userPrompt` string. After the `Verified shared donors` section at the bottom, add:

```typescript
  const tradeContext = (tradeAnalyst?.topFindings ?? []).length > 0
    ? `\nRecent trade-vote proximity (top findings, pre-ranked by proximity and committee involvement):\n` +
      (tradeAnalyst.topFindings as any[]).map((f: any) => {
        const timing = f.days_before_vote === 0 ? 'same day as' : `${f.days_before_vote}d before`;
        const bill = f.bill_title ?? f.vote_question ?? '(unknown bill)';
        const committee = f.member_on_bill_committee ? ' · on committee' : '';
        return `- ${f.tx_date}: ${f.tx_type} ${f.ticker ?? f.asset} (${f.amount_band}), ${timing} vote on "${bill}"${committee}`;
      }).join('\n')
    : '';
```

Then append `${tradeContext}` at the end of `userPrompt`, just before the closing backtick.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd ~/.hermes/civiclens && ./node_modules/.bin/tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd ~/.hermes/civiclens && git add agents/summarizer.ts && git commit -m "feat(summarizer): add trade-vote top findings to LLM context"
```

---

## Task 6: Add `tradeNarrative` to neutrality scan

**Files:**
- Modify: `agents/code-checker.ts`

- [ ] **Step 1: Read `trade-analyst.json` in `runCodeChecker`**

In `agents/code-checker.ts`, after the existing reads for `researcher` and `summarizer`, add:

```typescript
  let tradeAnalyst: any = null;
  try { tradeAnalyst = readPipe<any>(task.taskId, 'trade-analyst'); } catch { /* optional */ }
```

Note: `readPipe` is already imported. No new import needed.

- [ ] **Step 2: Add `tradeNarrative` to `shipSurface`**

Find the `shipSurface` array. The current version is:

```typescript
  const shipSurface = [
    summarizer.bio ?? '',
    summarizer.neutralNarrative ?? '',
    ...((summarizer.keyFacts ?? []) as string[]),
    d.role ?? '',
  ].join(' ');
```

Replace with:

```typescript
  const shipSurface = [
    summarizer.bio ?? '',
    summarizer.neutralNarrative ?? '',
    ...((summarizer.keyFacts ?? []) as string[]),
    d.role ?? '',
    tradeAnalyst?.tradeNarrative ?? '',   // ← new
  ].join(' ');
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd ~/.hermes/civiclens && ./node_modules/.bin/tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd ~/.hermes/civiclens && git add agents/code-checker.ts && git commit -m "feat(code-checker): include tradeNarrative in neutrality scan"
```

---

## Task 7: Persist `trade_activity` in `load-from-tasks.ts`

**Files:**
- Modify: `db/load-from-tasks.ts`

- [ ] **Step 1: Read `trade-analyst.json` and UPDATE `members.trade_activity`**

In `db/load-from-tasks.ts`, find the `loadOne` function. After the `pipeline_runs` INSERT block (around line 232), add:

```typescript
  // trade_activity — from trade-analyst.json if present
  try {
    const taPath = resolve(pick.taskDir, 'trade-analyst.json');
    if (existsSync(taPath)) {
      const ta = JSON.parse(readFileSync(taPath, 'utf-8'));
      const narrative: string | null = ta?.tradeNarrative ?? null;
      if (narrative && narrative !== 'N/A') {
        await conn.run(
          `UPDATE members SET trade_activity = ? WHERE member_id = ?`,
          [narrative, memberId],
        );
      }
    }
  } catch { /* non-fatal */ }
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd ~/.hermes/civiclens && ./node_modules/.bin/tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd ~/.hermes/civiclens && git add db/load-from-tasks.ts && git commit -m "feat(loader): persist trade_activity from trade-analyst pipe to members table"
```

---

## Task 8: Render "Trade activity" section in `render/build.ts`

**Files:**
- Modify: `render/build.ts`

- [ ] **Step 1: Add `trade_activity` to `MemberDetail` interface**

Find `interface MemberDetail` in `render/build.ts` and add the new field:

```typescript
interface MemberDetail {
  member_id: string;
  name: string;
  party: string | null;
  chamber: string | null;
  state: string | null;
  district: string | null;
  bio_summary: string | null;
  bioguide_id: string | null;
  fec_candidate_id: string | null;
  trade_activity: string | null;   // ← new
}
```

- [ ] **Step 2: Fetch `trade_activity` in `fetchMember`**

In `fetchMember`, update the SQL and the return mapping:

```typescript
async function fetchMember(memberId: string): Promise<MemberDetail | null> {
  const conn = await getDb();
  const r = await conn.run(
    `SELECT member_id, name, party, chamber, state, district, bio_summary, bioguide_id,
            fec_candidate_id, trade_activity
     FROM members WHERE member_id = ?`,
    [memberId],
  );
  const rows = await r.getRowObjects() as any[];
  if (rows.length === 0) return null;
  const m = rows[0];
  return {
    member_id:        String(m.member_id),
    name:             String(m.name),
    party:            m.party ?? null,
    chamber:          m.chamber ?? null,
    state:            m.state ?? null,
    district:         m.district ?? null,
    bio_summary:      m.bio_summary ?? null,
    bioguide_id:      m.bioguide_id ?? null,
    fec_candidate_id: m.fec_candidate_id ?? null,
    trade_activity:   m.trade_activity ?? null,    // ← new
  };
}
```

- [ ] **Step 3: Add suspicion badge CSS to `STYLE`**

In the `STYLE` constant, add after the existing `.notice` rule:

```css
.trade-activity { margin: 0 0 24px; }
.trade-activity h2 { margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
.suspicion-badge { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 500; }
.suspicion-badge.medium { background: rgba(247,201,72,0.12); color: #f7c948; border: 1px solid rgba(247,201,72,0.4); }
.suspicion-badge.high   { background: rgba(214,90,90,0.12);  color: #d65a5a; border: 1px solid rgba(214,90,90,0.4); }
```

- [ ] **Step 4: Render the section in `buildMemberPage`**

In `buildMemberPage`, find where `bio` is constructed:

```typescript
  const bio = m.bio_summary ? `<p class="lede">${esc(m.bio_summary)}</p>` : '';
```

Add below it:

```typescript
  // Determine suspicion level from DB if available (re-read trade-analyst.json via rendered data)
  // The suspicion level badge is rendered server-side from the stored narrative presence.
  // Full suspicion level would require re-querying; use a simple heuristic on the narrative.
  // For the badge, re-query the DB for the member's trade count as a proxy.
  const tradeActivityBlock = (() => {
    if (!m.trade_activity) return '';
    // Re-read suspicion level from DB for the badge
    return `<div class="trade-activity">
  <h2>Trade activity</h2>
  <p class="lede">${esc(m.trade_activity)}</p>
</div>`;
  })();
```

- [ ] **Step 5: Insert `tradeActivityBlock` into the page body**

In `buildMemberPage`, find the `body` template string. The current structure starts:

```typescript
  const body = `
<h2>${esc(m.name)}</h2>
${meta}
${bio}
<h2>Timeline</h2>
```

Replace with:

```typescript
  const body = `
<h2>${esc(m.name)}</h2>
${meta}
${bio}
${tradeActivityBlock}
<h2>Timeline</h2>
```

- [ ] **Step 6: Rebuild site and verify MTG page shows the section**

```bash
cd ~/.hermes/civiclens && ./node_modules/.bin/tsx render/build.ts 2>&1 | grep -E "✓|Done"
```

Then check:

```bash
grep -c "Trade activity" ~/.hermes/civiclens/site/members/marjorie-taylor-greene.html
```

Expected: `1` (the section heading appears once).

- [ ] **Step 7: Commit**

```bash
cd ~/.hermes/civiclens && git add render/build.ts && git commit -m "feat(render): add trade activity section to member profile page"
```

---

## Task 9: End-to-end smoke test

- [ ] **Step 1: Run MTG pipeline with `--force` and verify full output**

```bash
cd ~/.hermes/civiclens && source ~/.hermes/.env && npx tsx agents/pipeline.ts "Marjorie Taylor Greene" --force 2>&1
```

Expected output includes:
```
✓  Trade Analyst   N findings → high suspicion
✓  Summarizer      bio + N key facts
✓  Code Checker    score 1.00
✓  Final Reviewer  APPROVED — ready to apply
```

- [ ] **Step 2: Inspect the trade-analyst.json output**

```bash
python3 -c "
import json
import glob, os
tasks = sorted(glob.glob(os.path.expanduser('~/.hermes/civiclens/pipeline/task-*/trade-analyst.json')))
with open(tasks[-1]) as f: d = json.load(f)
print('suspicionLevel:', d['suspicionLevel'])
print('totalSuspiciousTrades:', d['totalSuspiciousTrades'])
print('findings:', len(d['topFindings']))
print()
print('narrative:')
print(d['tradeNarrative'])
" 2>&1
```

Expected: `suspicionLevel: 'high'`, `findings: 5`, non-empty narrative citing PLTR and H.R. 4016.

- [ ] **Step 3: Sync to DB and rebuild**

```bash
cd ~/.hermes/civiclens && source ~/.hermes/.env
LATEST=$(ls -td ~/.hermes/civiclens/pipeline/task-* | head -1 | xargs basename)
npx tsx db/sync-task.ts $LATEST 2>&1
npx tsx render/build.ts 2>&1 | grep "marjorie"
```

Expected: `✓ site/members/marjorie-taylor-greene.html`

- [ ] **Step 4: Verify trade_activity in DB**

```bash
cd ~/.hermes/civiclens && cat > /tmp/verify-ta.ts << 'EOF'
import { getDb } from './db/init.js';
const db = await getDb();
const r = await db.run(`SELECT member_id, trade_activity FROM members WHERE trade_activity IS NOT NULL`);
const rows = await r.getRowObjects() as any[];
for (const row of rows) {
  console.log(row.member_id, ':', String(row.trade_activity).slice(0, 150));
}
EOF
./node_modules/.bin/tsx /tmp/verify-ta.ts 2>&1 && rm /tmp/verify-ta.ts
```

Expected: at least `marjorie-taylor-greene` with a non-empty narrative.

- [ ] **Step 5: Commit**

```bash
cd ~/.hermes/civiclens && git add -A && git commit -m "test: verify trade-analyst end-to-end smoke test passes"
```

---

## Self-Review

**Spec coverage check:**
- ✅ Weighted SQL ORDER BY (Task 3, query in `runTradeAnalyst`)
- ✅ Deterministic suspicion level (Task 3, `computeSuspicionLevel`)
- ✅ Revised LLM prompt with role, prioritization, forbidden words (Task 3)
- ✅ Dynamic sentence count 3–4 / 4–6 (Task 3, `sentenceTarget`)
- ✅ `topFindings` fed to Summarizer (Task 5)
- ✅ `tradeNarrative` in neutrality scan (Task 6)
- ✅ `trade_activity` persisted to DB (Task 7)
- ✅ "Trade activity" section rendered on member page (Task 8)
- ✅ Suspicion badge CSS (Task 8, Step 3)
- ✅ Non-fatal failure paths throughout (Task 3, all `warn + return true`)
- ✅ `AgentName` and `PipelineStatus` types updated (Task 1)
- ✅ `initTask` agents record updated (Task 4)

**Note on suspicion badge rendering:** Task 8 Step 4 includes the section but omits the badge color — the `suspicionLevel` is written to `trade-analyst.json` but not currently stored in the DB. To show a colored badge, either (a) store `suspicion_level` as a separate DB column and fetch it in `fetchMember`, or (b) infer it from `trade_activity` content. This is low-priority polish; the prose section is the primary deliverable. Add a DB column in a follow-up if the badge is important.
