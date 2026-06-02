import type { PipelineTask } from '../lib/types.js';
import {
  ok, fail, warn,
  readPipe, writePipe, markAgent, setStatus,
} from './shared.js';

export async function runFinalReviewer(task: PipelineTask): Promise<boolean> {
  markAgent(task, 'final-reviewer', 'running');

  const researcher  = readPipe<any>(task.taskId, 'researcher');
  const dataChecker = readPipe<any>(task.taskId, 'data-checker');
  const summarizer  = readPipe<any>(task.taskId, 'summarizer');
  const codeChecker = readPipe<any>(task.taskId, 'code-checker');

  // Deterministic QC gate — no LLM. readyToApply derives purely from the
  // upstream validators (Data Checker), the neutrality gate (Code Checker), and
  // completeness of the rendered narrative fields. The old narrative LLM check
  // could only ever downgrade approved→approved_with_warnings, never reject, so
  // it added a nondeterministic call with no gate-changing power.
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
  };

  const failedChecks = Object.entries(checklist).filter(([,v]) => !v).map(([k]) => k);

  const hasCritical = failedChecks.some(k =>
    ['dataCheckerPassed','codeCheckerPassed','neutralityCheckPass'].includes(k)
  );
  const warnCount = failedChecks.filter(k =>
    !['dataCheckerPassed','codeCheckerPassed','neutralityCheckPass'].includes(k)
  ).length;

  const decision = hasCritical ? 'rejected'
    : warnCount >= 3           ? 'approved_with_warnings'
    :                            'approved';

  const report = {
    taskId:        task.taskId,
    reviewedAt:    new Date().toISOString(),
    decision,
    politicianId:  researcher.data?.id,
    politicianName: researcher.data?.name,
    checklist,
    issues: failedChecks.map(k => ({
      category: 'checklist',
      severity: ['dataCheckerPassed','codeCheckerPassed'].includes(k) ? 'critical' : 'warning',
      message: `Failed check: ${k}`,
    })),
    summary: decision === 'approved'
      ? `All checks passed. Ready to load into DuckDB.`
      : decision === 'approved_with_warnings'
      ? `Approved with ${warnCount} warning(s). Review before loading.`
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
