# Trade Analyst Agent — Design Spec
**Date:** 2026-04-28  
**Status:** Approved (revised)

---

## Problem

The CivicLens pipeline produces member profiles (bio, keyFacts, neutralNarrative) from Researcher data — bills, votes, donors. Trade-vote proximity data lives in DuckDB (`v_suspicious_trades`) but no pipeline agent reads it. As a result, significant trade-vote findings (e.g. MTG's PLTR purchase 3 days before the DoD Appropriations Act, 2026 vote) are visible in the site's trade card UI but never appear in the member's written profile.

---

## Solution

A new **Trade Analyst** agent inserted between Connection Mapper and Summarizer. It queries the DB directly, asks the LLM to write a short analytical prose section, and outputs that section as its own artifact — separate from the Summarizer's bio/narrative.

---

## Pipeline Position

```
Researcher → Data Checker → Predictor → Connection Mapper → Trade Analyst → Summarizer → ...
```

Failure is **non-fatal**: if the agent errors or finds no data, the pipeline continues with `hasData: false` and no trade section appears in the profile.

---

## Agent: `trade-analyst`

### Input

Queries `v_suspicious_trades` in DuckDB for the member using a **weighted suspicion score** to surface the strongest signals first:

```sql
SELECT DISTINCT asset, ticker, tx_type, tx_date::text as tx_date, amount_band,
       days_before_vote, bill_title, vote_question, bill_summary,
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
LIMIT 5
```

Also fetches a **total count** of distinct discretionary trades in `v_suspicious_trades` for the member (used to set dynamic sentence length).

No dependency on Researcher JSON. Reads DB directly via `getDb()`.

### Output file: `trade-analyst.json`

```typescript
interface TradeAnalystOutput {
  taskId: string;
  analyzedAt: string;
  hasData: boolean;
  suspicionLevel: 'none' | 'low' | 'medium' | 'high';
  tradeNarrative: string;   // "N/A" when hasData: false
  topFindings: TradeFinding[];
  totalSuspiciousTrades: number;
}

interface TradeFinding {
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
```

**Suspicion level logic (deterministic, computed before LLM call):**

| Level | Criteria |
|---|---|
| `high` | Any finding with `days_before_vote <= 3` AND `member_on_bill_committee = true` |
| `high` | 3+ findings with `days_before_vote = 0` |
| `medium` | Any finding with `days_before_vote <= 3`, OR any finding with `member_on_bill_committee = true` |
| `low` | Has findings but none of the above |
| `none` | 0 findings |

### LLM prompt (when `hasData: true`)

Model: `LLM_SUMMARIZER_MODEL` (grok-4.20 by default).  
Timeout: 120s.  
Max tokens: 700.  
**Sentence target:** 3–4 sentences if `totalSuspiciousTrades <= 10`, 4–6 sentences if `> 10`.

System prompt:
```
You are a sharp, neutral financial transparency analyst writing for a public accountability tool.
Your job is to analyze trade-vote proximity data for a U.S. member of Congress and write a factual,
analytical paragraph. You do not speculate about intent or legality — you only state what the
records show.
```

User prompt:
```
Write a [3–4 | 4–6] sentence analytical paragraph about the most significant trade-vote
proximity patterns for [member name].

Focus on:
1. The strongest findings first — same-day trades, trades 1–3 days before a vote, and trades
   near bills where the member serves on the relevant committee.
2. State timing precisely: "purchased N days before", "sold the same day as".
3. If the member sat on a committee that handled the bill, state it factually.
4. Group related trades when possible (e.g. multiple purchases of the same ticker near the
   same bill).
5. If there are no particularly close patterns, say so concisely.

FORBIDDEN words (do NOT use): extreme, radical, corrupt, suspicious, illegal, improper,
dishonest, claims to, pretends to, hero, champion.

Do not use bullet points. Do not add a conclusion about legality or ethics.
Cite specific tickers, dates, amounts, and bill titles from the data.

Top findings (ranked by proximity and committee involvement):
[structured list of findings]
```

### No-data path

When the query returns 0 rows: write `{ hasData: false, suspicionLevel: 'none', tradeNarrative: "N/A", topFindings: [], totalSuspiciousTrades: 0 }` directly, skip LLM call entirely.

---

## Summarizer Changes

The Summarizer receives `topFindings` from `trade-analyst.json` as additional context appended to its user prompt:

```
Recent trade-vote proximity (top findings, pre-ranked):
- [date] [type] [asset] ([ticker]) [amount]: [N]d before vote on "[bill_title]"[  · on committee] 
```

This lets the Summarizer reference specific trades in `keyFacts`. The Summarizer is not required to use this data — it enriches the prompt, it doesn't replace existing logic.

---

## Coder / Site Changes

The Coder agent includes `tradeActivity` as a new field written to `members.trade_activity`. The renderer shows it as a labeled section on the member page.

**Position:** Below bio metadata, above the Timeline section.  
**Label:** "Trade activity"  
**Badge:** A colored dot next to the label reflecting `suspicionLevel` — grey (low), amber (medium), red (high). Omit badge when level is `none` or `low`.  
**Rendering:** Plain paragraph. When `tradeNarrative` is "N/A" or null, section is omitted entirely.

### Schema change

```sql
ALTER TABLE members ADD COLUMN IF NOT EXISTS trade_activity TEXT;
```

Added to `db/schema.sql`, applied via `applySchema()` on next init.

---

## `lib/types.ts` Changes

- Add `'trade-analyst'` to `AgentName` union between `'connection-mapper'` and `'summarizer'`
- Add `'analyzing-trades'` to `PipelineStatus` union

---

## `agents/pipeline.ts` Changes

After `runConnectionMapper`, before `runSummarizer`:

```typescript
import { runTradeAnalyst } from './trade-analyst.js';

setStatus(task, 'analyzing-trades');
const tradeOk = await runTradeAnalyst(task);
if (!tradeOk) {
  warn('Brain', 'Trade Analyst failed — continuing without trade section');
}
```

---

## Neutrality Enforcement

`code-checker.ts`: add `tradeAnalyst?.tradeNarrative ?? ''` to the `shipSurface` array alongside `bio`, `neutralNarrative`, and `keyFacts`. The same FORBIDDEN word scan applies.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| No trades in DB for member | `hasData: false`, `suspicionLevel: 'none'`, `tradeNarrative: "N/A"`, no LLM call |
| DB unavailable | Agent returns false, pipeline continues |
| LLM timeout / error | Agent returns false, pipeline continues |
| Neutrality violation in narrative | Code Checker flags it; Final Reviewer rejects; existing retry logic applies |

---

## Files Touched

| File | Change |
|---|---|
| `agents/trade-analyst.ts` | New file |
| `agents/pipeline.ts` | Import + call `runTradeAnalyst`; add `'analyzing-trades'` status |
| `agents/summarizer.ts` | Read `trade-analyst.json`, append `topFindings` to user prompt |
| `agents/code-checker.ts` | Add `tradeNarrative` to `shipSurface` scan |
| `lib/types.ts` | Add `'trade-analyst'` to `AgentName`; add `'analyzing-trades'` to `PipelineStatus` |
| `db/schema.sql` | Add `trade_activity TEXT` to `members` |
| `render/build.ts` | Render `trade_activity` with suspicion-level badge on member page |

---

## Out of Scope

- No changes to `v_suspicious_trades` view
- No changes to Researcher, Data Checker, Predictor, Visualizer, or Publisher
- No corpus-wide trade feed changes on index page
- No re-running of existing approved tasks (new runs only)
