import type { PipelineTask } from '../lib/types.js';
import {
  ok, warn, spin,
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

export interface TradeTickerSummary {
  ticker: string;
  count: number;
  firstDate: string;
  lastDate: string;
  txTypes: string;
}

export interface TradeAnalystOutput {
  taskId: string;
  analyzedAt: string;
  hasData: boolean;
  suspicionLevel: SuspicionLevel;
  tradeNarrative: string;
  narrativeSource: 'deterministic' | 'llm' | 'none';
  topFindings: TradeFinding[];
  totalSuspiciousTrades: number;
  allDiscretionaryTrades: TradeTickerSummary[];
  totalDiscretionaryTrades: number;
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

// Deterministic narrative: every sentence is a direct restatement of finding
// rows — no inference, no pattern claims beyond what the rows contain. This is
// the default ship surface; the LLM paragraph is an opt-in sidecar
// (CIVICLENS_TRADE_NARRATIVE=1) because prose paraphrase can blur timing facts.
export function buildDeterministicNarrative(
  findings: TradeFinding[],
  allDiscretionaryTrades: TradeTickerSummary[],
  totalDiscretionaryTrades: number,
): string {
  const sameDay   = findings.filter(f => f.days_before_vote === 0).length;
  const onCmte    = findings.filter(f => f.member_on_bill_committee).length;
  const sentences: string[] = [];

  // findings is the deduplicated top set (LIMIT 5), not a total — say so.
  sentences.push(
    `The ${findings.length === 1 ? 'strongest trade-to-vote pairing' : `${findings.length} strongest trade-to-vote pairings`} ` +
    `for this member (ranked by proximity and committee overlap) ` +
    `${findings.length === 1 ? 'occurred' : 'each occurred'} within 30 days before a vote` +
    (onCmte > 0
      ? `; in ${onCmte === findings.length ? (findings.length === 1 ? 'this case' : 'every case') : `${onCmte} of them`} ` +
        `the member sat on a committee that handled the bill`
      : '') + '.'
  );

  const top = findings[0];
  const timing = top.days_before_vote === 0
    ? 'the same day as'
    : `${top.days_before_vote} day${top.days_before_vote === 1 ? '' : 's'} before`;
  const bill = top.bill_title ?? top.vote_question ?? '(unknown bill)';
  // findings[0] is top-RANKED (committee overlap can outrank raw proximity),
  // so don't call it "closest".
  sentences.push(
    `Top-ranked: a ${top.tx_type.toLowerCase()} of ${top.ticker ?? top.asset} ` +
    `(${top.amount_band}) on ${top.tx_date}, ${timing} the vote on "${bill}"` +
    (top.member_on_bill_committee
      ? `, a bill handled by a committee the member sits on` +
        (top.member_committee_role && top.member_committee_role !== 'member'
          ? ` as ${top.member_committee_role}` : '')
      : '') + '.'
  );

  if (sameDay > 1 || (sameDay === 1 && top.days_before_vote !== 0)) {
    sentences.push(
      `${sameDay === findings.length ? `All ${sameDay}` : `${sameDay} of the ${findings.length}`} ` +
      `fell on the same day as a vote.`
    );
  }

  if (totalDiscretionaryTrades > 0 && allDiscretionaryTrades.length > 0) {
    const topTickers = allDiscretionaryTrades.slice(0, 3)
      .map(t => `${t.ticker} (×${t.count})`).join(', ');
    sentences.push(
      `The full discretionary record spans ${totalDiscretionaryTrades} ` +
      `transaction${totalDiscretionaryTrades === 1 ? '' : 's'} across ` +
      `${allDiscretionaryTrades.length} position${allDiscretionaryTrades.length === 1 ? '' : 's'}; ` +
      `most-traded: ${topTickers}.`
    );
  }

  return sentences.join(' ');
}

function writeEmpty(
  task: PipelineTask,
  suspicionLevel: SuspicionLevel,
  totalSuspiciousTrades = 0,
  allDiscretionaryTrades: TradeTickerSummary[] = [],
  totalDiscretionaryTrades = 0,
): void {
  const output: TradeAnalystOutput = {
    taskId:               task.taskId,
    analyzedAt:           new Date().toISOString(),
    hasData:              false,
    suspicionLevel,
    tradeNarrative:       'N/A',
    narrativeSource:      'none',
    topFindings:          [],
    totalSuspiciousTrades,
    allDiscretionaryTrades,
    totalDiscretionaryTrades,
  };
  writePipe(task.taskId, 'trade-analyst', output);
  markAgent(task, 'trade-analyst', 'complete', { suspicionLevel, findings: 0 });
}

export async function runTradeAnalyst(task: PipelineTask): Promise<boolean> {
  markAgent(task, 'trade-analyst', 'running');

  const ANALYST_MODEL = process.env.LLM_TRADE_MODEL ?? process.env.LLM_SUMMARIZER_MODEL ?? 'claude-sonnet-4-6';
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
    return true;
  }

  if (!memberId) {
    warn('Trade Analyst', `member not in DB yet — skipping trade analysis`);
    writeEmpty(task, 'none');
    return true;
  }

  // ── 2. Query top suspicious trades (deduplicated per trade×best-vote) ──────
  let findings: TradeFinding[] = [];
  let totalSuspiciousTrades = 0;
  let allDiscretionaryTrades: TradeTickerSummary[] = [];
  let totalDiscretionaryTrades = 0;
  try {
    // Two-level deduplication:
    //   Level 1 (rn=1): per (ticker, tx_date), keep only the best-matching vote.
    //     Prefer committee involvement > proximity > substantive bill over procedural.
    //   Level 2 (rn2=1): per tx_date, keep only the single best ticker.
    //     This prevents all 5 slots being consumed by different tickers all traded
    //     on the same date, which would hide closer but fewer-coincident trades
    //     on other dates (e.g. PLTR Jul 15 × H.R.4016 Jul 18).
    const r = await db!.run(
      `WITH ranked AS (
         SELECT DISTINCT
           asset, ticker, tx_type, tx_date::text AS tx_date, amount_band,
           days_before_vote, bill_title, vote_question,
           member_on_bill_committee, member_committee_role,
           bill_source_url, vote_source_url,
           ROW_NUMBER() OVER (
             PARTITION BY ticker, tx_date
             ORDER BY
               CASE
                 WHEN days_before_vote = 0 AND member_on_bill_committee THEN 100
                 WHEN days_before_vote = 0                              THEN 90
                 WHEN days_before_vote <= 3 AND member_on_bill_committee THEN 85
                 WHEN days_before_vote <= 3                             THEN 80
                 WHEN member_on_bill_committee                          THEN 70
                 ELSE 50
               END DESC,
               days_before_vote ASC,
               -- prefer substantive bill votes over procedural ones
               CASE
                 WHEN vote_question ILIKE 'On Ordering the Previous Question%' THEN 2
                 WHEN vote_question ILIKE 'On Motion to%'                      THEN 2
                 WHEN vote_question ILIKE 'H.Res.%'                            THEN 2
                 ELSE 1
               END ASC,
               -- total order: without these, equal-score ties resolve
               -- arbitrarily and the "top finding" flips run-to-run
               vote_source_url ASC NULLS LAST, bill_title ASC NULLS LAST
           ) AS rn,
           CASE
             WHEN days_before_vote = 0 AND member_on_bill_committee THEN 100
             WHEN days_before_vote = 0                              THEN 90
             WHEN days_before_vote <= 3 AND member_on_bill_committee THEN 85
             WHEN days_before_vote <= 3                             THEN 80
             WHEN member_on_bill_committee                          THEN 70
             ELSE 50
           END AS score
         FROM v_suspicious_trades
         WHERE member_id = ?
           AND days_before_vote <= 30
       ),
       by_date AS (
         SELECT *,
           ROW_NUMBER() OVER (
             PARTITION BY tx_date
             ORDER BY score DESC, days_before_vote ASC,
                      ticker ASC NULLS LAST, asset ASC
           ) AS rn2
         FROM ranked
         WHERE rn = 1
       )
       SELECT asset, ticker, tx_type, tx_date, amount_band, days_before_vote,
              bill_title, vote_question, member_on_bill_committee,
              member_committee_role, bill_source_url, vote_source_url
       FROM by_date
       WHERE rn2 = 1
       ORDER BY score DESC, days_before_vote ASC,
                tx_date DESC, ticker ASC NULLS LAST, asset ASC
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

    const countR = await db!.run(
      `SELECT COUNT(DISTINCT trade_filing_id) AS n FROM v_suspicious_trades WHERE member_id = ?`,
      [memberId],
    );
    const countRows = await countR.getRowObjects() as any[];
    totalSuspiciousTrades = Number(countRows[0]?.n ?? 0);

    // All discretionary trades — ticker-level rollup for pattern context
    const discreteFilter = `
      asset_type NOT IN ('GS', 'MF', 'EF', 'BA', 'CT', 'AB', 'Corporate Bond', 'Municipal Security')
      AND NOT (asset_type IN ('OT', 'Stock') AND (
        LOWER(asset) LIKE '%etf%' OR LOWER(asset) LIKE '%index fund%'
        OR LOWER(asset) LIKE '%s&p 500%' OR LOWER(asset) LIKE '%vanguard%'
        OR LOWER(asset) LIKE '%ishares%' OR LOWER(asset) LIKE '%schwab%'
        OR LOWER(asset) LIKE '%fidelity%'
      ))`;
    const allR = await db!.run(
      `SELECT COALESCE(ticker, asset) AS ticker,
              COUNT(*)::int AS cnt,
              MIN(tx_date::text) AS first_tx,
              MAX(tx_date::text) AS last_tx,
              STRING_AGG(DISTINCT tx_type, '/') AS tx_types
       FROM pfd_transactions
       WHERE member_id = ? AND ${discreteFilter}
       GROUP BY COALESCE(ticker, asset)
       ORDER BY cnt DESC
       LIMIT 40`,
      [memberId],
    );
    const allRows = await allR.getRowObjects() as any[];
    allDiscretionaryTrades = allRows.map((row: any): TradeTickerSummary => ({
      ticker:    String(row.ticker ?? ''),
      count:     Number(row.cnt),
      firstDate: String(row.first_tx ?? ''),
      lastDate:  String(row.last_tx ?? ''),
      txTypes:   String(row.tx_types ?? ''),
    }));

    const totalR = await db!.run(
      `SELECT COUNT(*)::int AS n FROM pfd_transactions WHERE member_id = ? AND ${discreteFilter}`,
      [memberId],
    );
    const totalRows = await totalR.getRowObjects() as any[];
    totalDiscretionaryTrades = Number(totalRows[0]?.n ?? 0);
  } catch (e: any) {
    warn('Trade Analyst', `query failed: ${e.message}`);
    writeEmpty(task, 'none');
    return true;
  }

  if (findings.length === 0) {
    writeEmpty(task, 'none', totalSuspiciousTrades, allDiscretionaryTrades, totalDiscretionaryTrades);
    ok('Trade Analyst', 'no discretionary trades before votes — N/A');
    return true;
  }

  // ── 3. Compute suspicion level (deterministic) ─────────────────────────────
  const suspicionLevel = computeSuspicionLevel(findings);

  // ── 4. Narrative ────────────────────────────────────────────────────────────
  // Deterministic by default — a template over the finding rows, so every
  // shipped sentence traces to a row. The LLM paragraph is an opt-in sidecar.
  let tradeNarrative = buildDeterministicNarrative(
    findings, allDiscretionaryTrades, totalDiscretionaryTrades,
  );
  let narrativeSource: TradeAnalystOutput['narrativeSource'] = 'deterministic';

  if (process.env.CIVICLENS_TRADE_NARRATIVE === '1') {
  spin('Trade Analyst', `generating ${suspicionLevel} suspicion narrative via ${ANALYST_MODEL}…`);

  const systemPrompt = `You are a sharp, neutral financial transparency analyst specializing in congressional trading patterns.

You are given:
- The top 5 most relevant trade-vote proximity findings for a U.S. member of Congress
- A summary of their full discretionary trading portfolio (tickers, frequency, date ranges)

Your job is to write a single, cohesive analytical paragraph (4–6 sentences) that reveals the most important patterns.

**Core Rules:**
- Focus on **patterns and relationships**, not just listing individual trades.
- Prioritize: same-day or 1–3 day proximity + committee involvement + repeated behavior.
- Use precise timing language: "purchased on the same day as", "sold 2 days before", "3 days prior to".
- If the member served on a committee with jurisdiction over a bill, state it factually.
- Reference the broader portfolio when relevant (e.g., "Despite heavy concentration in [sector]..." or "Across ${totalDiscretionaryTrades} transactions in ${allDiscretionaryTrades.length} positions...").
- Never speculate about intent, legality, or ethics.
- Avoid repetitive phrasing. Vary sentence structure.

**What to Emphasize (in order of importance):**
1. The strongest proximity signals (especially same-day or committee-related)
2. Any recurring patterns across multiple trades
3. Concentration in specific sectors or tickers
4. Notable absence of proximity in high-volume holdings

**Output Format:**
Write exactly one paragraph of 4–6 sentences. No bullet points. No concluding sentence. No moralizing.`;

  const allTradesSummary = allDiscretionaryTrades.length > 0
    ? allDiscretionaryTrades
        .map(t => `${t.ticker} ×${t.count} (${t.firstDate}–${t.lastDate}, ${t.txTypes})`)
        .join(', ')
    : 'none';

  const userPrompt = `**Input Data:**

Top findings (ranked by proximity and committee involvement):
${findingsToText(findings)}

Full discretionary portfolio (${totalDiscretionaryTrades} total transactions across ${allDiscretionaryTrades.length} positions; top 40 by frequency):
${allTradesSummary}

Member: ${memberName}`;

  try {
    tradeNarrative = await llm(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      { maxTokens: 700, timeoutMs: 120_000, model: ANALYST_MODEL },
    );
    narrativeSource = 'llm';
    process.stdout.write('\n');
  } catch (e: any) {
    process.stdout.write('\n');
    warn('Trade Analyst', `LLM failed: ${e.message} — using deterministic narrative`);
  }
  } // end CIVICLENS_TRADE_NARRATIVE sidecar

  // ── 5. Write output ─────────────────────────────────────────────────────────
  const output: TradeAnalystOutput = {
    taskId:               task.taskId,
    analyzedAt:           new Date().toISOString(),
    hasData:              true,
    suspicionLevel,
    tradeNarrative,
    narrativeSource,
    topFindings:          findings,
    totalSuspiciousTrades,
    allDiscretionaryTrades,
    totalDiscretionaryTrades,
  };

  writePipe(task.taskId, 'trade-analyst', output);
  markAgent(task, 'trade-analyst', 'complete', { suspicionLevel, findings: findings.length, narrativeSource });
  ok('Trade Analyst', `${findings.length} findings → ${suspicionLevel} suspicion (${narrativeSource} narrative)`);
  return true;
}
