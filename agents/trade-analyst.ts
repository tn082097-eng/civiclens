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
    return true;
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
    const r = await db!.run(
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

    const countR = await db!.run(
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
