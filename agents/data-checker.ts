import { ResearcherOutputSchema } from '../lib/schemas.js';
import type { PipelineTask } from '../lib/types.js';
import {
  ok, fail, info, spin, red, yellow, cyan, gray,
  readPipe, writePipe, markAgent, US_STATES,
} from './shared.js';

export interface Issue { field: string; severity: 'critical'|'warning'|'info'; message: string; }

export async function runDataChecker(task: PipelineTask): Promise<boolean> {
  markAgent(task, 'data-checker', 'running');
  spin('Data Checker', 'validating schema…');

  const raw = readPipe<any>(task.taskId, 'researcher');
  const issues: Issue[] = [];
  const data = raw.data ?? {};
  const today = new Date().toISOString().split('T')[0];
  const corrections: string[] = [];

  // ── Auto-correct common issues BEFORE Zod validation ──

  if (data.inOffice === 1 || data.inOffice === 'true')  { data.inOffice = true;  corrections.push('inOffice: coerced to boolean true'); }
  if (data.inOffice === 0 || data.inOffice === 'false') { data.inOffice = false; corrections.push('inOffice: coerced to boolean false'); }

  for (const bill of data.bills ?? []) {
    if (bill.introducedAt > today) {
      corrections.push(`bill "${bill.title?.slice(0,40)}": future date ${bill.introducedAt} → clamped to ${today}`);
      bill.introducedAt = today;
    }
    if (!bill.summary || bill.summary.length < 20) {
      bill.summary = bill.title.length >= 20
        ? bill.title
        : `${bill.title} (no summary available)`;
      corrections.push(`bill "${bill.title?.slice(0,40)}": summary missing — copied from title`);
    }
  }

  for (const vote of data.votes ?? []) {
    if (vote.date > today) {
      corrections.push(`vote "${vote.billTitle?.slice(0,40)}": future date ${vote.date} → clamped to ${today}`);
      vote.date = today;
    }
    const raw_vote = (vote.vote ?? '').toLowerCase();
    if (['yes','aye'].includes(raw_vote)) { vote.vote = 'yea'; corrections.push(`vote: normalized "${raw_vote}" → "yea"`); }
    if (['no'].includes(raw_vote))        { vote.vote = 'nay'; corrections.push(`vote: normalized "no" → "nay"`); }
  }

  for (const donor of data.donors ?? []) {
    if (!['individual','pac','corporation'].includes(donor.type)) {
      corrections.push(`donor "${donor.name?.slice(0,30)}": invalid type "${donor.type}" → "individual"`);
      donor.type = 'individual';
    }
  }

  const PARTY_MAP: Record<string,string> = {
    'dem':'Democrat','democratic':'Democrat','rep':'Republican','republican':'Republican',
    'ind':'Independent','independent':'Independent','r':'Republican','d':'Democrat','i':'Independent',
  };
  if (data.party && !['Democrat','Republican','Independent'].includes(data.party)) {
    const fixed = PARTY_MAP[data.party.toLowerCase()];
    if (fixed) { corrections.push(`party: "${data.party}" → "${fixed}"`); data.party = fixed; }
  }

  const CHAMBER_MAP: Record<string,string> = { 'House':'house','Senate':'senate','Executive':'executive','House of Representatives':'house' };
  if (data.chamber && CHAMBER_MAP[data.chamber]) {
    corrections.push(`chamber: "${data.chamber}" → "${CHAMBER_MAP[data.chamber]}"`);
    data.chamber = CHAMBER_MAP[data.chamber];
  }

  if (corrections.length > 0) {
    info('Data Checker', `auto-corrected ${corrections.length} issue(s) before validation`);
    for (const c of corrections) console.log(`     ${cyan('↺')} ${gray(c)}`);
  }

  if (corrections.length > 0) {
    const researcherOutput = readPipe<any>(task.taskId, 'researcher');
    researcherOutput.data = data;
    researcherOutput.corrections = corrections;
    writePipe(task.taskId, 'researcher', researcherOutput);
  }

  const zodResult = ResearcherOutputSchema.safeParse(raw);
  if (!zodResult.success) {
    for (const issue of zodResult.error.issues) {
      issues.push({ field: issue.path.join('.'), severity: 'critical', message: issue.message });
    }
  }

  if ((data.bio ?? '').length < 50) {
    issues.push({ field: 'data.bio', severity: 'critical', message: `Bio too short: ${data.bio?.length ?? 0} chars (min 50)` });
  }
  if (data.state && !US_STATES.has(data.state.toUpperCase())) {
    issues.push({ field: 'data.state', severity: 'warning', message: `Unrecognized state code: ${data.state}` });
  }
  const allEmpty = !data.bills?.length && !data.votes?.length && !data.donors?.length;
  if (allEmpty) {
    issues.push({ field: 'data', severity: 'info', message: 'bills, votes, and donors are all empty' });
  }
  for (const bill of data.bills ?? []) {
    if (bill.introducedAt > today) {
      issues.push({ field: `data.bills[${bill.title}].introducedAt`, severity: 'critical', message: `Future date: ${bill.introducedAt}` });
    }
  }
  for (const vote of data.votes ?? []) {
    if (vote.date > today) {
      issues.push({ field: `data.votes[${vote.billTitle}].date`, severity: 'critical', message: `Future date: ${vote.date}` });
    }
  }
  const allItems = [...(data.bills??[]), ...(data.votes??[]), ...(data.donors??[])];
  for (const item of allItems) {
    if (typeof item.confidence === 'number' && item.confidence < 0.60) {
      issues.push({ field: 'data', severity: 'warning', message: `Low confidence (${item.confidence}) on: ${item.title ?? item.billTitle ?? item.name}` });
    }
  }
  if (typeof data.inOffice !== 'boolean') {
    issues.push({ field: 'data.inOffice', severity: 'critical', message: `inOffice must be boolean, got ${typeof data.inOffice}` });
  }

  process.stdout.write('\n');

  const criticals = issues.filter(i => i.severity === 'critical').length;
  const warnings  = issues.filter(i => i.severity === 'warning').length;
  const score     = Math.max(0, 1.0 - criticals * 0.3 - warnings * 0.1);
  const passed    = criticals === 0;

  const report = {
    taskId: task.taskId,
    validatedAt: new Date().toISOString(),
    passed,
    score: Math.round(score * 100) / 100,
    issues,
    summary: passed
      ? `Data passed validation with ${warnings} warning(s). Score: ${score.toFixed(2)}`
      : `Data FAILED validation: ${criticals} critical issue(s), ${warnings} warning(s).`,
  };

  writePipe(task.taskId, 'data-checker', report);
  markAgent(task, 'data-checker', passed ? 'complete' : 'failed', { passed, score });

  if (passed) {
    ok('Data Checker', `score ${score.toFixed(2)} — ${issues.length} issue(s)`);
  } else {
    fail('Data Checker', `${criticals} critical — ${report.summary}`);
  }
  for (const issue of issues.filter(i => i.severity !== 'info')) {
    const icon = issue.severity === 'critical' ? red('✗') : yellow('⚠');
    console.log(`     ${icon} ${gray(issue.field)}: ${issue.message}`);
  }

  return passed;
}
