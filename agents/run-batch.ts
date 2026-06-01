#!/usr/bin/env node
/**
 * CivicLens Batch Runner
 * Runs the full pipeline for a list of politicians and auto-applies approved results to seed.ts.
 * Usage: npx tsx agents/run-batch.ts
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { ROOT, PIPE_DIR, NAMES_PATH, BATCH_LOG } from '../lib/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Politician list lives in names.txt so the batch runner and single-name runs
// share a single source of truth. One name per line, blank lines ignored.
const POLITICIANS: string[] = fs.readFileSync(NAMES_PATH, 'utf-8')
  .split('\n')
  .map(s => s.trim())
  .filter(s => s.length > 0);

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

function bold(s: string)  { return `${c.bold}${s}${c.reset}`; }
function green(s: string) { return `${c.green}${s}${c.reset}`; }
function red(s: string)   { return `${c.red}${s}${c.reset}`; }
function yellow(s: string){ return `${c.yellow}${s}${c.reset}`; }
function cyan(s: string)  { return `${c.cyan}${s}${c.reset}`; }
function dim(s: string)   { return `${c.dim}${s}${c.reset}`; }
function gray(s: string)  { return `${c.gray}${s}${c.reset}`; }

interface BatchResult {
  name: string;
  taskId: string | null;
  status: 'approved' | 'approved_with_warnings' | 'rejected' | 'failed' | 'applied';
  applied: boolean;
  corrections: string[];
  errors: string[];
  duration: number;
  source: string;
}

function findLatestTask(name: string): { taskId: string; final: any; researcher: any } | null {
  if (!fs.existsSync(PIPE_DIR)) return null;
  const dirs = fs.readdirSync(PIPE_DIR).sort().reverse();
  for (const taskId of dirs) {
    const stateFile = path.join(PIPE_DIR, taskId, 'state.json');
    const finalFile = path.join(PIPE_DIR, taskId, 'final-review.json');
    if (!fs.existsSync(stateFile) || !fs.existsSync(finalFile)) continue;
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    if (state.target?.name?.toLowerCase() !== name.toLowerCase()) continue;
    const final = JSON.parse(fs.readFileSync(finalFile, 'utf-8'));
    const researcherFile = path.join(PIPE_DIR, taskId, 'researcher.json');
    const researcher = fs.existsSync(researcherFile)
      ? JSON.parse(fs.readFileSync(researcherFile, 'utf-8')) : null;
    return { taskId, final, researcher };
  }
  return null;
}

async function runOne(name: string): Promise<BatchResult> {
  const start = Date.now();
  const result: BatchResult = {
    name, taskId: null, status: 'failed', applied: false,
    corrections: [], errors: [], duration: 0, source: 'unknown',
  };

  console.log(`\n${c.cyan}${'═'.repeat(62)}${c.reset}`);
  console.log(`${c.bold}${c.cyan}  [${POLITICIANS.indexOf(name) + 1}/${POLITICIANS.length}] ${name}${c.reset}`);
  console.log(`${c.cyan}${'═'.repeat(62)}${c.reset}\n`);

  // Run pipeline
  const proc = spawnSync(
    'npx', ['tsx', path.join(__dirname, 'pipeline.ts'), name],
    { encoding: 'utf8', timeout: 600_000, cwd: ROOT,
      stdio: ['pipe', 'inherit', 'inherit'] }
  );

  if (proc.status !== 0 && proc.status !== null) {
    result.errors.push(`Pipeline exited ${proc.status}`);
    result.duration = Date.now() - start;
    return result;
  }

  // Find the task that was just created
  const found = findLatestTask(name);
  if (!found) {
    result.errors.push('Task not found after pipeline run');
    result.duration = Date.now() - start;
    return result;
  }

  const { taskId, final, researcher } = found;
  result.taskId = taskId;
  result.source = researcher?.source ?? 'unknown';

  // Collect corrections from researcher
  result.corrections = researcher?.corrections ?? [];

  // Check data checker for corrections
  const dcFile = path.join(PIPE_DIR, taskId, 'data-checker.json');
  if (fs.existsSync(dcFile)) {
    const dc = JSON.parse(fs.readFileSync(dcFile, 'utf-8'));
    for (const issue of dc.issues ?? []) {
      if (issue.severity === 'critical') {
        result.errors.push(`${issue.field}: ${issue.message}`);
      }
    }
  }

  // Decision
  const decision = final.decision ?? 'rejected';
  result.status = decision as any;

  if (final.readyToApply) {
    // Apply to seed.ts
    console.log(`\n  ${cyan('›')}  ${bold('Applying to seed.ts…')}`);
    const applyProc = spawnSync(
      'npx', ['tsx', path.join(__dirname, 'pipeline.ts'), '--apply', taskId],
      { encoding: 'utf8', timeout: 30_000, cwd: ROOT,
        stdio: ['pipe', 'inherit', 'inherit'] }
    );
    result.applied = applyProc.status === 0;
    result.status = 'applied';
  } else {
    result.errors.push(`Final review decision: ${decision}`);
    if (final.issues?.length) {
      result.errors.push(...final.issues.map((i: any) => i.message));
    }
  }

  result.duration = Date.now() - start;
  return result;
}

async function main() {
  const line = '═'.repeat(62);
  console.log(`\n${c.bold}${c.cyan}${line}${c.reset}`);
  console.log(`${c.bold}${c.cyan}  CivicLens Batch Pipeline Runner${c.reset}`);
  console.log(`${c.bold}${c.cyan}  ${POLITICIANS.length} politicians · auto-apply enabled${c.reset}`);
  console.log(`${c.bold}${c.cyan}${line}${c.reset}\n`);

  const results: BatchResult[] = [];

  for (const name of POLITICIANS) {
    const r = await runOne(name);
    results.push(r);
  }

  // ── Second pass: re-run Connection Mapper against the full corpus ──
  // Per-politician runs see an incomplete corpus (subject N sees only 1..N-1).
  // Rerun the Mapper now that every researcher.json exists so each subject
  // cross-references against every peer. Eliminates order-of-run bias.
  const rerunable = results.filter(r => r.taskId);
  if (rerunable.length > 1) {
    console.log(`\n${c.bold}${c.cyan}${'─'.repeat(62)}${c.reset}`);
    console.log(`${c.bold}${c.cyan}  Re-running Connection Mapper against full corpus (${rerunable.length} tasks)${c.reset}`);
    console.log(`${c.bold}${c.cyan}${'─'.repeat(62)}${c.reset}`);
    for (const r of rerunable) {
      process.stdout.write(`  ${cyan('↻')}  ${r.name.padEnd(30)} ${dim('(' + r.taskId + ')')} ... `);
      const proc = spawnSync(
        'npx', ['tsx', path.join(__dirname, 'pipeline.ts'), '--rerun-mapper', r.taskId!],
        { encoding: 'utf8', timeout: 120_000, cwd: ROOT,
          stdio: ['pipe', 'pipe', 'pipe'] }
      );
      if (proc.status === 0) {
        process.stdout.write(green('ok\n'));
      } else {
        process.stdout.write(red(`failed (${proc.status ?? 'timeout'})\n`));
        r.errors.push(`Mapper rerun exited ${proc.status}`);
      }
    }
  }

  // ── Final report ──
  console.log(`\n\n${c.bold}${c.cyan}${line}${c.reset}`);
  console.log(`${c.bold}${c.cyan}  BATCH COMPLETE — RESULTS${c.reset}`);
  console.log(`${c.bold}${c.cyan}${line}${c.reset}\n`);

  const applied  = results.filter(r => r.applied);
  const warnings = results.filter(r => r.status === 'approved_with_warnings');
  const rejected = results.filter(r => !r.applied);

  for (const r of results) {
    const icon  = r.applied ? green('✓') : r.status === 'rejected' ? red('✗') : yellow('⚠');
    const mins  = (r.duration / 60000).toFixed(1);
    const src   = dim(`[${r.source}]`);
    const corr  = r.corrections.length ? yellow(` ↺${r.corrections.length} corrections`) : '';
    console.log(`  ${icon}  ${bold(r.name.padEnd(30))}  ${dim(r.status.padEnd(22))}  ${dim(mins + 'm')}  ${src}${corr}`);
    if (r.corrections.length) {
      for (const c of r.corrections) console.log(`       ${gray('↺')} ${gray(c)}`);
    }
    if (r.errors.length && !r.applied) {
      for (const e of r.errors) console.log(`       ${red('✗')} ${gray(e)}`);
    }
  }

  console.log(`\n  ${bold('Applied:  ')} ${green(String(applied.length))}/${POLITICIANS.length}`);
  console.log(`  ${bold('Warnings: ')} ${warnings.length}`);
  console.log(`  ${bold('Rejected: ')} ${rejected.length > 0 ? red(String(rejected.length)) : '0'}\n`);

  // Write full log
  const logPath = BATCH_LOG;
  fs.writeFileSync(logPath, JSON.stringify({ runAt: new Date().toISOString(), results }, null, 2));
  console.log(`  ${dim('Full log → ' + logPath)}\n`);

  process.exit(rejected.length > 0 ? 1 : 0);
}

main().catch(e => { console.error(red('\nFatal: ' + e.message)); process.exit(1); });
