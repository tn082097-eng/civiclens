import type { PipelineTask } from '../lib/types.js';
import {
  ok, fail, warn, red, yellow, gray,
  readPipe, writePipe, markAgent,
  checkNeutrality, ArtifactValidationError,
} from './shared.js';
import {
  ResearcherOutputSchema, SummarizerOutputSchema, TradeAnalystOutputSchema,
} from '../lib/schemas.js';
import type { Issue } from './data-checker.js';

export async function runCodeChecker(task: PipelineTask): Promise<boolean> {
  markAgent(task, 'code-checker', 'running');

  const researcher = readPipe<any>(task.taskId, 'researcher', ResearcherOutputSchema);
  // Summarizer is an optional sidecar — when skipped/failed there is no
  // narrative to police, so its checks simply don't apply.
  // Missing file stays silent (pre-PR-2 semantics); a malformed artifact warns.
  let summarizer: any = null;
  try { summarizer = readPipe<any>(task.taskId, 'summarizer', SummarizerOutputSchema); }
  catch (e) { if (e instanceof ArtifactValidationError) warn('Code Checker', e.message); }
  let tradeAnalyst: any = null;
  try { tradeAnalyst = readPipe<any>(task.taskId, 'trade-analyst', TradeAnalystOutputSchema); }
  catch (e) { if (e instanceof ArtifactValidationError) warn('Code Checker', e.message); }
  const d = researcher.data;
  const issues: Issue[] = [];
  const today = new Date().toISOString().split('T')[0];

  // Only scan LLM-generated narrative fields — bill titles, vote questions, and
  // donor names come verbatim from primary sources (Congress.gov, GovTrack,
  // OpenFEC) and may legitimately contain words that would be editorial bias
  // if written by the pipeline itself.
  const shipSurface = [
    summarizer?.bio ?? '',
    summarizer?.neutralNarrative ?? '',
    ...((summarizer?.keyFacts ?? []) as string[]),
    d.role ?? '',
    tradeAnalyst?.tradeNarrative ?? '',
  ].join(' ');

  const violations = checkNeutrality(shipSurface);
  const neutralityCheck = violations.length === 0 ? 'pass' : 'fail';
  if (violations.length > 0) {
    issues.push({ field: 'shipSurface.neutrality', severity: 'critical',
      message: `Forbidden words: ${violations.join(', ')}` });
  }

  if (typeof d.inOffice !== 'boolean') {
    issues.push({ field: 'researcher.inOffice', severity: 'critical',
      message: `inOffice must be boolean, got ${typeof d.inOffice}` });
  }
  if (summarizer && (summarizer.bio ?? '').length < 60) {
    issues.push({ field: 'summarizer.bio', severity: 'critical',
      message: `bio too short: ${summarizer.bio?.length ?? 0} chars (min 60)` });
  }
  for (const b of d.bills ?? []) {
    if (b.introducedAt > today) {
      issues.push({ field: `bills[${b.title}].introducedAt`, severity: 'critical',
        message: `Future date: ${b.introducedAt}` });
    }
  }
  for (const v of d.votes ?? []) {
    if (v.date > today) {
      issues.push({ field: `votes[${v.billTitle}].date`, severity: 'critical',
        message: `Future date: ${v.date}` });
    }
  }

  const criticals = issues.filter(i => i.severity === 'critical').length;
  const warnings  = issues.filter(i => i.severity === 'warning').length;
  const score     = Math.max(0, 1.0 - criticals * 0.3 - warnings * 0.1);
  const passed    = criticals === 0;

  const report = {
    taskId: task.taskId,
    checkedAt: new Date().toISOString(),
    passed,
    score: Math.round(score * 100) / 100,
    issues,
    neutralityCheck,
    typeCheck: passed ? 'pass' : 'fail',
    summary: passed
      ? `Code passed review. Score: ${score.toFixed(2)}`
      : `Code FAILED review: ${criticals} critical issue(s).`,
  };

  writePipe(task.taskId, 'code-checker', report);
  markAgent(task, 'code-checker', passed ? 'complete' : 'failed', { passed, score });

  if (passed) {
    ok('Code Checker', `score ${score.toFixed(2)}`);
  } else {
    fail('Code Checker', report.summary);
  }
  for (const issue of issues.filter(i => i.severity !== 'info')) {
    const icon = issue.severity === 'critical' ? red('✗') : yellow('⚠');
    console.log(`     ${icon} ${gray(issue.field)}: ${issue.message}`);
  }

  return passed;
}
