import type { PipelineTask } from '../lib/types.js';
import {
  ok, fail, warn,
  readPipe, writePipe, markAgent, setStatus,
  ArtifactValidationError,
} from './shared.js';
import {
  ResearcherOutputSchema, DataCheckerReportSchema, CodeCheckerReportSchema,
  SummarizerOutputSchema,
} from '../lib/schemas.js';

export async function runFinalReviewer(task: PipelineTask): Promise<boolean> {
  markAgent(task, 'final-reviewer', 'running');

  const researcher  = readPipe<any>(task.taskId, 'researcher', ResearcherOutputSchema);
  const dataChecker = readPipe<any>(task.taskId, 'data-checker', DataCheckerReportSchema);
  const codeChecker = readPipe<any>(task.taskId, 'code-checker', CodeCheckerReportSchema);
  // Optional sidecar — absent when skipped (CIVICLENS_SUMMARIZER=0) or failed.
  // Missing file stays silent (pre-PR-2 semantics); a malformed artifact warns.
  let summarizer: any = null;
  try { summarizer = readPipe<any>(task.taskId, 'summarizer', SummarizerOutputSchema); }
  catch (e) { if (e instanceof ArtifactValidationError) warn('Final Reviewer', e.message); }

  // Deterministic QC gate — no LLM. readyToApply derives purely from the
  // upstream validators (Data Checker), the neutrality gate (Code Checker), and
  // — when a narrative was produced — completeness of its fields. Narrative
  // completeness must never block deterministic facts: those checks only exist
  // when the sidecar ran, and they are warnings, not critical.
  const checklist: Record<string, boolean> = {
    dataCheckerPassed:       !!dataChecker.passed,
    dataCheckerScore:        (dataChecker.score ?? 0) >= 0.70,
    codeCheckerPassed:       !!codeChecker.passed,
    codeCheckerScore:        (codeChecker.score ?? 0) >= 0.70,
    neutralityCheckPass:     codeChecker.neutralityCheck === 'pass',
  };
  if (summarizer) {
    checklist.bioLength              = (summarizer.bio?.length ?? 0) >= 60;
    checklist.narrativeLength        = (summarizer.neutralNarrative?.length ?? 0) >= 100;
    checklist.keyFactsPresent        = (summarizer.keyFacts?.length ?? 0) >= 2;
    checklist.noNeutralityViolations = (summarizer.neutralityViolations?.length ?? 0) === 0;
  }

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
