import type { PipelineTask } from '../lib/types.js';
import { findSharedDonors } from '../db/queries.js';
import {
  ok, fail, warn, spin,
  readPipe, writePipe, markAgent,
  loadSkill, llm, extractJson, checkNeutrality,
  ArtifactValidationError,
} from './shared.js';
import {
  ResearcherOutputSchema, DataCheckerReportSchema, TradeAnalystOutputSchema,
} from '../lib/schemas.js';

export async function runSummarizer(task: PipelineTask): Promise<boolean> {
  markAgent(task, 'summarizer', 'running');

  const SUMMARIZER_MODEL = process.env.LLM_SUMMARIZER_MODEL ?? process.env.SUMMARIZER_MODEL ?? 'claude-sonnet-4-6';
  const skill = loadSkill('summarizer');
  spin('Summarizer', `drafting summary via ${SUMMARIZER_MODEL} (${skill.source})…`);

  const researcher = readPipe<any>(task.taskId, 'researcher', ResearcherOutputSchema);
  const checker    = readPipe<any>(task.taskId, 'data-checker', DataCheckerReportSchema);
  const d = researcher.data;

  // Optional sidecar — absent when the trade analyst is skipped/failed.
  // Missing file stays silent (pre-PR-2 semantics); a malformed artifact warns.
  let tradeAnalyst: any = null;
  try { tradeAnalyst = readPipe<any>(task.taskId, 'trade-analyst', TradeAnalystOutputSchema); }
  catch (e) { if (e instanceof ArtifactValidationError) warn('Summarizer', e.message); }

  // ── Stage 1: deterministic ─────────────────────────────────────────────────
  const headline = `${d.name} — ${d.role}, ${d.state} (${d.party})`;

  const billText = (d.bills ?? []).map((b: any) =>
    `- ${b.title} (${b.status}, ${b.introducedAt})`
  ).join('\n') || 'None on record.';

  const donorText = (d.donors ?? []).map((don: any) =>
    `- ${don.name} (${don.type}): $${(don.amount/1e6).toFixed(1)}M`
  ).join('\n') || 'None on record.';

  const controversyText = (d.controversies ?? []).map((c: any) =>
    `- ${c.title}: ${c.description?.slice(0, 120)}${c.flagged ? ' [DISPUTED]' : ''}`
  ).join('\n') || 'None on record.';

  // Shared-donor peers from the deterministic SQL layer (db/queries.ts) — the same
  // query the public site renders. Replaces the deleted Connection Mapper agent.
  // syncTask() loads this member into DuckDB earlier in the pipeline, so findSharedDonors
  // sees their donors here. Peer-oriented (one row per member sharing ≥1 donor).
  const sharedPeers = await findSharedDonors(d.id);
  const sharedDonorText = sharedPeers.length > 0
    ? sharedPeers.map(p =>
        `- ${p.peer_name}: ${p.shared_count} shared donor${p.shared_count === 1 ? '' : 's'}` +
        (p.donor_canonicals.length ? ` (${p.donor_canonicals.slice(0, 5).join(', ')})` : '')
      ).join('\n')
    : 'None identified.';

  const tradeContext = (tradeAnalyst?.topFindings ?? []).length > 0
    ? `\nRecent trade-vote proximity (top findings, pre-ranked by proximity and committee involvement):\n` +
      (tradeAnalyst.topFindings as any[]).map((f: any) => {
        const timing = f.days_before_vote === 0 ? 'same day as' : `${f.days_before_vote}d before`;
        const bill = f.bill_title ?? f.vote_question ?? '(unknown bill)';
        const committee = f.member_on_bill_committee ? ' · on committee' : '';
        return `- ${f.tx_date}: ${f.tx_type} ${f.ticker ?? f.asset} (${f.amount_band}), ${timing} vote on "${bill}"${committee}`;
      }).join('\n')
    : '';

  const neutralityRules = `
FORBIDDEN words and phrases (do NOT use any of these):
extreme, radical, far-left, far-right, socialist, fascist, corrupt, crooked,
dishonest, liar, hero, champion, maverick, fighter, "pushed through",
"rammed through", "snuck in", "claims to", "pretends to"

REQUIRED: Use "alleged" or "reported" only if the source itself uses them.
REQUIRED: Use "voted against" not "blocked". Use "passed" not "rammed through".`;

  // ── Stage 2: model narrative ───────────────────────────────────────────────
  const userPrompt = `Write a neutral, factual political summary. The headline is already constructed — do not change it.
${neutralityRules}

SPECIFICITY RULES (important — the summary must dig into the data below, not just rephrase the intro bio):
- bio: 2-3 sentences. Mention their chamber, state, party, and ONE concrete legislative focus area grounded in the bill list (e.g., "consumer financial protection" only if bills show it; "judicial confirmations" if votes show it).
- keyFacts: 4-6 items. At least TWO must cite a SPECIFIC bill by short name or bill number from the Bills list, or a specific vote. Do not write generic items like "focuses on X" — that's the bio's job. Items should be facts a reader couldn't guess from the name alone.
- neutralNarrative: 3-4 sentences. Reference at least one specific bill/vote by name. Reference the donor pattern only if the top donors list is non-empty. If a piece of data is empty ("None on record"), say "not documented in the available data" rather than inventing content.

Return ONLY a JSON object with these exact fields (omit headline — it's constructed elsewhere):
{
  "bio": "2-3 sentences as above",
  "keyFacts": ["4-6 items as above — at least 2 cite specific bills/votes"],
  "neutralNarrative": "3-4 sentences as above"
}

Politician data:
Name: ${d.name}
Party: ${d.party}
Role: ${d.role}, ${d.state}
Bio: ${d.bio}
Bills:
${billText}
Top donors:
${donorText}
Controversies: ${controversyText}
Verified shared-donor peers (deterministic SQL match):
${sharedDonorText}${tradeContext}`;

  const messages = skill.source !== 'none'
    ? [{ role: 'system' as const, content: skill.systemPrompt }, { role: 'user' as const, content: userPrompt }]
    : [{ role: 'user' as const, content: userPrompt }];

  let summaryData: any;
  try {
    const raw = await llm(messages, { maxTokens: 1500, timeoutMs: 120_000, model: SUMMARIZER_MODEL });
    process.stdout.write('\n');
    summaryData = extractJson(raw);
  } catch (e: any) {
    process.stdout.write('\n');
    fail('Summarizer', e.message);
    markAgent(task, 'summarizer', 'failed', { error: e.message });
    return false;
  }

  // ── Stage 3: deterministic post-processing ─────────────────────────────────
  const REPLACEMENTS: [RegExp, string][] = [
    [/\bblocked (the )?bill\b/gi, 'voted against the bill'],
    [/\brammed through\b/gi, 'passed'],
    [/\bpushed through\b/gi, 'passed'],
    [/\bsnuck in\b/gi, 'included'],
    [/\bclaims to\b/gi, 'states'],
    [/\bpretends to\b/gi, 'states'],
    [/\badmitted to\b/gi, 'acknowledged'],
  ];

  for (const key of ['bio', 'neutralNarrative'] as const) {
    if (typeof summaryData[key] === 'string') {
      for (const [pattern, replacement] of REPLACEMENTS) {
        summaryData[key] = summaryData[key].replace(pattern, replacement);
      }
    }
  }

  const researcherCorpus = [
    d.bio ?? '',
    d.party ?? '',
    d.state ?? '',
    d.role ?? '',
    ...((d.bills   ?? []).map((b: any) => b.title ?? '')),
    ...((d.donors  ?? []).map((x: any) => x.name  ?? '')),
    ...((d.votes   ?? []).map((v: any) => v.billTitle ?? '')),
  ].join(' ').toLowerCase();

  const STOPWORDS = new Set(['the','a','an','and','or','of','in','on','to','for','with','is','was','by','his','her','their']);
  const tokensFromFact = (s: string) =>
    s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 3 && !STOPWORDS.has(t));

  const rawFacts: string[] = Array.isArray(summaryData.keyFacts) ? summaryData.keyFacts : [];
  const keyFacts: string[] = [];
  const unverifiedFacts: string[] = [];
  for (const f of rawFacts) {
    if (typeof f !== 'string' || f.trim().length === 0) continue;
    const tokens = tokensFromFact(f);
    const grounded = tokens.some(t => researcherCorpus.includes(t));
    if (grounded) keyFacts.push(f);
    else unverifiedFacts.push(f);
  }

  const allText = `${summaryData.bio} ${summaryData.neutralNarrative}`;
  const violations = checkNeutrality(allText);

  const dataQualityNote = checker.issues?.length > 0
    ? checker.summary
    : 'Data passed full validation.';

  const output = {
    taskId: task.taskId,
    summarizedAt: new Date().toISOString(),
    headline,
    bio: summaryData.bio ?? d.bio,
    keyFacts,
    unverifiedFacts,
    neutralNarrative: summaryData.neutralNarrative ?? '',
    dataQualityNote,
    neutralityViolations: violations,
  };

  writePipe(task.taskId, 'summarizer', output);
  markAgent(task, 'summarizer', 'complete', { violations: violations.length, unverified: unverifiedFacts.length });

  const msgParts: string[] = [`bio + ${keyFacts.length} key facts`];
  if (unverifiedFacts.length > 0) msgParts.push(`${unverifiedFacts.length} unverified dropped`);
  if (violations.length > 0) {
    warn('Summarizer', `${msgParts.join(', ')} — ${violations.length} neutrality flag(s): ${violations.join(', ')}`);
  } else {
    ok('Summarizer', msgParts.join(', '));
  }
  return true;
}
