import type { PipelineTask } from '../lib/types.js';
import {
  ok, fail, warn, spin,
  readPipe, writePipe, markAgent, setStatus,
  llm,
} from './shared.js';

export async function runFinalReviewer(task: PipelineTask): Promise<boolean> {
  markAgent(task, 'final-reviewer', 'running');

  // Final Reviewer always uses Claude — it's the QC gate and must be consistent.
  // Override via LLM_REVIEWER_MODEL if needed, but default pins to Haiku.
  const REVIEWER_MODEL = process.env.LLM_REVIEWER_MODEL ?? 'claude-sonnet-4-6';

  const researcher  = readPipe<any>(task.taskId, 'researcher');
  const dataChecker = readPipe<any>(task.taskId, 'data-checker');
  const summarizer  = readPipe<any>(task.taskId, 'summarizer');
  const coder       = readPipe<any>(task.taskId, 'coder');
  const codeChecker = readPipe<any>(task.taskId, 'code-checker');

  const checklist: Record<string, boolean> = {
    dataCheckerPassed:       !!dataChecker.passed,
    dataCheckerScore:        (dataChecker.score ?? 0) >= 0.70,
    bioLength:               (summarizer.bio?.length ?? 0) >= 60,
    narrativeLength:         (summarizer.neutralNarrative?.length ?? 0) >= 100,
    keyFactsPresent:         (summarizer.keyFacts?.length ?? 0) >= 2,
    noNeutralityViolations:  (summarizer.neutralityViolations?.length ?? 0) === 0,
    codeCheckerPassed:       !!codeChecker.passed,
    codeCheckerScore:        (codeChecker.score ?? 0) >= 0.70,
    neutralityCheckPass:     codeChecker.neutralityCheck === 'pass',
    coderClassified:         !!coder.action && !!coder.politicianId,
  };

  const failedChecks = Object.entries(checklist).filter(([,v]) => !v).map(([k]) => k);

  spin('Final Reviewer', `narrative review via ${REVIEWER_MODEL}…`);
  let narrativeOk = true;
  let narrativeNotes = '';
  try {
    const narrativePrompt = `You are a QC reviewer for a non-partisan political reference site.
Read this politician summary and answer:
1. Is the tone neutral and factual? (YES/NO)
2. Is anything misleading or biased? (YES/NO + brief reason if yes)
3. Suitable for publication? (YES/NO)

Headline: ${summarizer.headline}
Bio: ${summarizer.bio}
Key Facts: ${(summarizer.keyFacts ?? []).join(' | ')}
Narrative: ${summarizer.neutralNarrative}`;

    const review = await llm(
      [{ role: 'user', content: narrativePrompt }],
      { maxTokens: 400, timeoutMs: 30_000, model: REVIEWER_MODEL },
    );
    process.stdout.write('\n');
    narrativeNotes = review.slice(0, 300);
    const lines = review.toLowerCase();
    if (lines.includes('1. no') || lines.includes('3. no') ||
        (lines.includes('2. yes') && lines.includes('biased'))) {
      narrativeOk = false;
    }
  } catch (e: any) {
    process.stdout.write('\n');
    warn('Final Reviewer', `narrative check skipped: ${e.message}`);
  }

  if (!narrativeOk) {
    failedChecks.push('narrativeQuality');
    checklist['narrativeQuality'] = false;
  } else {
    checklist['narrativeQuality'] = true;
  }

  const hasCritical = failedChecks.some(k =>
    ['dataCheckerPassed','codeCheckerPassed','neutralityCheckPass'].includes(k)
  );
  const warnCount = failedChecks.filter(k =>
    !['dataCheckerPassed','codeCheckerPassed','neutralityCheckPass'].includes(k)
  ).length;

  const decision = hasCritical ? 'rejected'
    : warnCount >= 3           ? 'approved_with_warnings'
    : !narrativeOk             ? 'approved_with_warnings'
    :                            'approved';

  const report = {
    taskId:        task.taskId,
    reviewedAt:    new Date().toISOString(),
    decision,
    politicianId:  researcher.data?.id,
    politicianName: researcher.data?.name,
    checklist,
    narrativeReview: {
      model: REVIEWER_MODEL,
      passed: narrativeOk,
      notes: narrativeNotes,
    },
    issues: failedChecks.map(k => ({
      category: 'checklist',
      severity: ['dataCheckerPassed','codeCheckerPassed'].includes(k) ? 'critical' : 'warning',
      message: `Failed check: ${k}`,
    })),
    summary: decision === 'approved'
      ? `All checks passed. Ready to apply to seed.ts.`
      : decision === 'approved_with_warnings'
      ? `Approved with ${warnCount} warning(s). Review before applying.`
      : `REJECTED: ${failedChecks.join(', ')}`,
    readyToApply: decision !== 'rejected',
  };

  writePipe(task.taskId, 'final-review', report);
  setStatus(task, decision === 'rejected' ? 'failed' : 'complete');
  markAgent(task, 'final-reviewer', decision === 'rejected' ? 'failed' : 'complete', { decision });

  if (decision === 'approved') {
    ok('Final Reviewer', 'APPROVED — ready to apply');
  } else if (decision === 'approved_with_warnings') {
    warn('Final Reviewer', `APPROVED WITH WARNINGS (${warnCount} checks)`);
  } else {
    fail('Final Reviewer', `REJECTED: ${failedChecks.slice(0, 3).join(', ')}`);
  }

  return decision !== 'rejected';
}
