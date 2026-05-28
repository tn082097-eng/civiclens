/**
 * Devil's Advocate — adversarial cross-check on the neutral narrative (SKETCH).
 *
 * Role: model DIVERSITY, not generation. Grok's job here is to ATTACK Claude's
 * narrative — find the strongest partisan reading, the unsupported leap, the
 * unfair framing — never to produce facts. (Grok was once the pipeline's
 * researcher and fabricated sponsor rows; that path is permanently closed.
 * See db/load-sponsored.ts:4 and the civiclens-grok-role decision.)
 *
 * Contract:
 *   - Runs AFTER the Summarizer, alongside the Final Reviewer.
 *   - Reads summarizer.json (+ pattern evidence). Writes devils-advocate.json.
 *   - ADVISORY ONLY. Objections land as `warning`-severity issues in the Final
 *     Reviewer; they never auto-reject (Grok can hallucinate objections — the
 *     Final Reviewer / human weighs them).
 *   - Degrades gracefully: no XAI_API_KEY, API error, or unparseable reply →
 *     skip with a warn, exactly like final-reviewer.ts:62-65. Never blocks the
 *     pipeline.
 *   - OPT-IN: gated behind CIVICLENS_DEVILS_ADVOCATE=1 so default batch runs are
 *     untouched. Not imported by pipeline.ts until you wire it (see footer).
 *
 * Why the xAI API path (shared.ts grok()) and not grok-ask:
 *   Inside the pipeline there's no Claude-context to protect, so the handoff-file
 *   dance buys nothing — a direct, small, one-shot critique call is simpler. The
 *   callGrok() indirection below is one line to swap for a grok-ask spawn if you
 *   prefer the grok.com subscription over per-token xAI billing.
 */

import type { PipelineTask } from '../lib/types.js';
import { ok, warn, spin, readPipe, writePipe, llm } from './shared.js';
// NOTE: markAgent() is intentionally NOT used here. It takes a closed `AgentName`
// union (lib/types.ts) that doesn't include 'devils-advocate'. Adding it forces
// initializing the key in the task factory everywhere, which is a wiring step,
// not a sketch step — see the WIRING footer. Status is captured in the report.

// Model must be a `grok-*` id so shared.ts:298 routes to the xAI API path.
// Set to whatever your XAI_API_KEY exposes (`grok-3`, `grok-4-latest`, …).
const GROK_MODEL = process.env.GROK_DA_MODEL ?? 'grok-3';

export interface DevilsAdvocateObjection {
  claim: string;       // the narrative sentence/fact being challenged
  objection: string;   // why a reasonable critic would call it unfair/unsupported
  severity: 'low' | 'medium' | 'high';
}

export interface DevilsAdvocateReport {
  taskId: string;
  reviewedAt: string;
  model: string;
  ran: boolean;                       // false when skipped (no key / error)
  objections: DevilsAdvocateObjection[];
  skipReason?: string;
}

/**
 * Single seam for "ask Grok". Swap the body for a grok-ask spawn to use the
 * grok.com subscription instead of the xAI API.
 */
async function callGrok(prompt: string): Promise<string> {
  return llm(
    [{ role: 'user', content: prompt }],
    { maxTokens: 700, timeoutMs: 40_000, model: GROK_MODEL },
  );
}

export async function runDevilsAdvocate(task: PipelineTask): Promise<DevilsAdvocateReport> {

  const base: DevilsAdvocateReport = {
    taskId: task.taskId,
    reviewedAt: new Date().toISOString(),
    model: GROK_MODEL,
    ran: false,
    objections: [],
  };

  if (!process.env.XAI_API_KEY) {
    base.skipReason = 'XAI_API_KEY not set';
    writePipe(task.taskId, 'devils-advocate', base);
    warn('Devil\'s Advocate', 'skipped — XAI_API_KEY not set');
    return base;
  }

  const summarizer = readPipe<any>(task.taskId, 'summarizer');
  const patterns   = readPipe<any>(task.taskId, 'connection-mapper'); // pattern/edge evidence, if present

  // Adversarial framing. We ask Grok to be the hostile-but-fair critic, and we
  // demand strict JSON so the reply is parseable and bounded. No facts requested.
  const prompt = `You are a hostile-but-fair political critic reviewing a NON-PARTISAN reference
profile for unfairness. You do NOT add facts. You only find the strongest
reasonable objection a careful reader could raise: claims that are unsupported
by the cited evidence, framings that lean partisan, or insinuations of
wrongdoing presented as proximity. If the narrative is genuinely clean, say so.

Return STRICT JSON only, no prose:
{"objections":[{"claim":"<exact sentence/fact challenged>","objection":"<why it's unfair or unsupported>","severity":"low|medium|high"}]}
Empty array if nothing is objectionable.

HEADLINE: ${summarizer.headline ?? ''}
BIO: ${summarizer.bio ?? ''}
KEY FACTS: ${(summarizer.keyFacts ?? []).join(' | ')}
NARRATIVE: ${summarizer.neutralNarrative ?? ''}
EVIDENCE ON FILE (do not exceed this): ${JSON.stringify(patterns?.summary ?? patterns ?? {}).slice(0, 1500)}`;

  spin('Devil\'s Advocate', `adversarial pass via ${GROK_MODEL}…`);
  try {
    const reply = await callGrok(prompt);
    process.stdout.write('\n');

    // Tolerant parse: pull the first JSON object out of the reply.
    const jsonStart = reply.indexOf('{');
    const jsonEnd = reply.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd <= jsonStart) throw new Error('no JSON object in reply');
    const parsed = JSON.parse(reply.slice(jsonStart, jsonEnd + 1));

    const objections: DevilsAdvocateObjection[] = Array.isArray(parsed.objections)
      ? parsed.objections
          .filter((o: any) => o && typeof o.objection === 'string')
          .map((o: any) => ({
            claim: String(o.claim ?? '').slice(0, 300),
            objection: String(o.objection).slice(0, 400),
            severity: (['low', 'medium', 'high'].includes(o.severity) ? o.severity : 'low'),
          }))
          .slice(0, 8) // cap — advisory, not a firehose
      : [];

    base.ran = true;
    base.objections = objections;
    writePipe(task.taskId, 'devils-advocate', base);
    if (objections.length === 0) {
      ok('Devil\'s Advocate', 'no objections — narrative held up');
    } else {
      warn('Devil\'s Advocate', `${objections.length} objection(s) raised (advisory)`);
    }
    return base;
  } catch (e: any) {
    process.stdout.write('\n');
    base.skipReason = e.message;
    writePipe(task.taskId, 'devils-advocate', base);
    warn('Devil\'s Advocate', `skipped — ${e.message}`);
    return base;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * WIRING (apply when you want it live — left undone so default runs are safe):
 *
 * 1. agents/pipeline.ts — after the Summarizer succeeds, before Final Reviewer:
 *
 *      import { runDevilsAdvocate } from './devils-advocate.js';
 *      ...
 *      if (process.env.CIVICLENS_DEVILS_ADVOCATE === '1') {
 *        await runDevilsAdvocate(task);   // never throws; advisory only
 *      }
 *      await runFinalReviewer(task);
 *
 * 2. agents/final-reviewer.ts — fold objections in as WARNINGS (not critical):
 *
 *      const da = readPipe<any>(task.taskId, 'devils-advocate');
 *      for (const o of (da?.objections ?? [])) {
 *        report.issues.push({
 *          category: 'devils-advocate',
 *          severity: 'warning',          // never 'critical' — advisory by rule
 *          message: `[${o.severity}] ${o.objection} — re: "${o.claim}"`,
 *        });
 *      }
 *      // High-severity objections could bump decision to 'approved_with_warnings'
 *      // (a soft gate for human review), but must NEVER force 'rejected'.
 *
 * 3. (optional) render/build.ts — surface objections on the page as a
 *    "what a critic would say" transparency block, with the same provenance
 *    treatment as everything else.
 * ────────────────────────────────────────────────────────────────────────── */
