#!/usr/bin/env node
/**
 * CivicLens Pipeline Runner
 *
 * Usage:
 *   npx tsx agents/pipeline.ts "Politician Name"      run full pipeline
 *   npx tsx agents/pipeline.ts --append "Name"        append to names.txt and run
 *   npx tsx agents/pipeline.ts --list                 show recent tasks
 *   npx tsx agents/pipeline.ts --status <task-id>     show task status
 *   (after pipeline) npx tsx render/build.ts          rebuild static site from DB
 */

import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  PIPE_DIR,
  c, bold, dim, red, green, yellow, cyan,
  header, ok, fail, warn,
  loadHermesEnv,
  initTask, readTask, readPipe, pipeFile, setStatus, markAgent,
} from './shared.js';
import { ROOT, NAMES_PATH } from '../lib/paths.js';
import { syncTask } from '../db/sync-task.js';
import { closeDb } from '../db/init.js';
import { runResearcher } from './researcher.js';
import { runDataChecker } from './data-checker.js';
import { runPredictor } from './predictor.js';
import { runTradeAnalyst } from './trade-analyst.js';
import { runSummarizer } from './summarizer.js';
import { runCodeChecker } from './code-checker.js';
import { runFinalReviewer } from './final-reviewer.js';
import { FinalReviewReportSchema } from '../lib/schemas.js';

loadHermesEnv();

// ─── Cache check ─────────────────────────────────────────────────────────────
function findFreshTask(name: string, maxAgeMs = 24 * 60 * 60 * 1000): string | null {
  if (!fs.existsSync(PIPE_DIR)) return null;
  const dirs = fs.readdirSync(PIPE_DIR).sort().reverse();
  for (const taskId of dirs) {
    const stateFile = path.join(PIPE_DIR, taskId, 'state.json');
    const finalFile = path.join(PIPE_DIR, taskId, 'final-review.json');
    if (!fs.existsSync(stateFile) || !fs.existsSync(finalFile)) continue;
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    const final = JSON.parse(fs.readFileSync(finalFile, 'utf-8'));
    if (state.target?.name?.toLowerCase() !== name.toLowerCase()) continue;
    if (!final.readyToApply) continue;
    const age = Date.now() - new Date(state.updatedAt).getTime();
    if (age < maxAgeMs) return taskId;
  }
  return null;
}

// ─── Obsidian vault regen ─────────────────────────────────────────────────────
// Keep the NoService vault's Connections/Members notes in sync with the latest
// DuckDB facts + shared-donor edges so the vault never drifts after a pipeline run.
function regenerateVault() {
  const script = path.join(ROOT, 'render', 'connections-to-vault.ts');
  if (!fs.existsSync(script)) { warn('Vault', `regenerator missing: ${script}`); return; }
  // Release our DuckDB file lock first — the regenerator is a separate process
  // and DuckDB is single-writer per file. Without this it crashes with
  // "Could not set lock on file". getDb() reconnects lazily if needed after.
  closeDb();
  const r = spawnSync('npx', ['tsx', script], { encoding: 'utf-8' });
  if (r.status === 0) {
    const last = (r.stdout || '').trim().split('\n').filter(Boolean).pop() ?? '';
    ok('Vault', `regenerated — ${last}`);
  } else {
    warn('Vault', `regen failed (exit ${r.status}): ${(r.stderr || r.error?.message || '').trim().slice(0, 200)}`);
  }
}

// ─── List / status helpers ────────────────────────────────────────────────────
function listTasks() {
  if (!fs.existsSync(PIPE_DIR)) { console.log('No tasks found.'); return; }
  const dirs = fs.readdirSync(PIPE_DIR)
    .filter(f => fs.existsSync(path.join(PIPE_DIR, f, 'state.json')))
    .sort().reverse().slice(0, 20);
  if (!dirs.length) { console.log('No tasks found.'); return; }

  header('Pipeline Tasks');
  for (const taskId of dirs) {
    const task = readTask(taskId);
    const completed = Object.values(task.agents).filter(a => a.status === 'complete').length;
    const total = Object.keys(task.agents).length;
    const statusColor = task.status === 'complete' ? green(task.status)
      : task.status === 'failed' ? red(task.status) : cyan(task.status);
    console.log(`  ${dim(taskId)}  ${bold(task.target.name.padEnd(30))}  ${statusColor}  ${dim(`${completed}/${total} agents`)}`);
  }
  console.log();
}

function showStatus(taskId: string) {
  const task = readTask(taskId);
  header(`Task: ${task.taskId}`);
  console.log(`  ${bold('Target:')} ${task.target.name} (${task.target.type})`);
  console.log(`  ${bold('Status:')} ${task.status}`);
  console.log(`  ${bold('Updated:')} ${task.updatedAt.slice(0, 19)}\n`);
  console.log(`  ${bold('Agents:')}`);
  for (const [name, result] of Object.entries(task.agents)) {
    const icon = result.status === 'complete' ? green('✓')
      : result.status === 'failed'   ? red('✗')
      : result.status === 'running'  ? cyan('⟳')
      : result.status === 'skipped'  ? dim('—') : dim('·');
    console.log(`    ${icon}  ${name.padEnd(16)} ${dim(result.status)}`);
  }
  console.log();
}

// ─── Main pipeline orchestrator ───────────────────────────────────────────────
async function runPipeline(targetName: string, opts: { force?: boolean; skipVaultRegen?: boolean } = {}) {
  const cached = !opts.force && findFreshTask(targetName);
  if (cached) {
    header(`CivicLens Pipeline — ${targetName}`);
    const age = (() => {
      const state = readTask(cached);
      const mins = Math.floor((Date.now() - new Date(state.updatedAt).getTime()) / 60000);
      return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h`;
    })();
    ok('Cache hit', `using task ${cached} (${age} old, < 24h)`);
    console.log(`\n${c.cyan}${'─'.repeat(58)}${c.reset}`);
    console.log(`  ${bold('Decision:')} ${green('APPROVED (cached)')}`);
    console.log(`  ${dim('Task:')} ${cached}`);
    console.log(`  ${dim('Rebuild site:')} ${dim('npx tsx render/build.ts')}`);
    console.log();
    return;
  }

  const taskId = `task-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const task = initTask(taskId, targetName);

  const SUMMARIZER_MODEL = process.env.LLM_SUMMARIZER_MODEL ?? process.env.SUMMARIZER_MODEL ?? 'claude-sonnet-4-6';
  header(`CivicLens Pipeline — ${targetName}`);
  console.log(`  ${dim('Task ID:')} ${taskId}`);
  console.log(`  ${dim('Summarizer model:')} ${process.env.CIVICLENS_SUMMARIZER === '0' ? 'skipped' : SUMMARIZER_MODEL}\n`);

  setStatus(task, 'researching');
  const researchOk = await runResearcher(task);
  if (!researchOk) {
    fail('Pipeline', 'Researcher failed — aborting');
    return;
  }
  try { await syncTask(task.taskId); }
  catch (e: any) { warn('DB', `sync-task failed: ${e.message}`); }

  setStatus(task, 'validating');
  let checkOk = await runDataChecker(task);
  if (!checkOk) {
    warn('Brain', 'Data check failed — retrying researcher (1/2)…');
    task.agents.researcher.retries++;
    const retry1 = await runResearcher(task);
    if (retry1) checkOk = await runDataChecker(task);
    if (!checkOk) {
      fail('Pipeline', 'Data Checker failed after retry — aborting');
      setStatus(task, 'failed');
      return;
    }
  }

  setStatus(task, 'predicting');
  const predOk = await runPredictor(task);
  if (!predOk) {
    warn('Brain', 'Predictor failed — continuing without calibration data');
  }

  setStatus(task, 'analyzing-trades');
  const tradeOk = await runTradeAnalyst(task);
  if (!tradeOk) {
    warn('Brain', 'Trade Analyst failed — continuing without trade section');
  }

  // Summarizer is a semantic sidecar: its narrative ships nowhere on the public
  // site (facts render from DuckDB), so it must never block deterministic facts
  // from publishing. Soft like the Trade Analyst; skippable via env.
  if (process.env.CIVICLENS_SUMMARIZER === '0') {
    markAgent(task, 'summarizer', 'skipped');
    warn('Brain', 'Summarizer skipped (CIVICLENS_SUMMARIZER=0)');
  } else {
    setStatus(task, 'summarizing');
    let sumOk = await runSummarizer(task);
    if (!sumOk) {
      warn('Brain', 'Summarizer failed — retrying (1/2)…');
      task.agents.summarizer.retries++;
      sumOk = await runSummarizer(task);
      if (!sumOk) {
        warn('Brain', 'Summarizer failed after retry — continuing without summary');
      }
    }
  }

  setStatus(task, 'reviewing-code');
  const codeCheckOk = await runCodeChecker(task);
  if (!codeCheckOk) {
    warn('Brain', 'Neutrality check failed — continuing to Final Reviewer with warnings');
  }

  setStatus(task, 'final-review');
  await runFinalReviewer(task);
  let postSync: Awaited<ReturnType<typeof syncTask>> | null = null;
  try { postSync = await syncTask(task.taskId); }
  catch (e: any) { warn('DB', `post-review sync failed: ${e.message}`); }

  const finalReview = readPipe<any>(taskId, 'final-review', FinalReviewReportSchema);
  const allFiles = [
    'researcher','data-checker','predictor',
    'trade-analyst',
    'summarizer','code-checker','final-review',
  ].map(n => pipeFile(taskId, n));

  console.log(`\n${c.cyan}${'─'.repeat(58)}${c.reset}`);
  console.log(`  ${bold('Decision:')} ${
    finalReview.decision === 'approved'               ? green('APPROVED') :
    finalReview.decision === 'approved_with_warnings' ? yellow('APPROVED WITH WARNINGS') :
    red('REJECTED')
  }`);
  console.log(`  ${dim('Output:')} ~/Developer/civiclens/pipeline/${taskId}/`);
  console.log(`  ${dim('Files:')} ${allFiles.map(f => path.basename(f)).join(', ')}`);

  if (postSync?.fecResolved === 'unresolved' || postSync?.fecResolved === 'error') {
    console.log();
    warn('FEC ID', `${postSync.fecResolved} for ${task.target.name} (${postSync.fecReason ?? 'unknown'})`);
    console.log(`  ${dim('→ Outside-spending section will render empty until resolved.')}`);
    console.log(`  ${dim('→ Add to FEC_OVERRIDES in db/backfill-fec-candidate.ts, or retry sync after FEC is reachable.')}`);
  }

  if (finalReview.readyToApply) {
    console.log(`\n  ${cyan('Rebuild site:')} ${dim('npx tsx render/build.ts')}`);
  }

  if (!opts.skipVaultRegen) regenerateVault();
  console.log();
}

// ─── Batch runner ─────────────────────────────────────────────────────────────
async function runBatch(namesArg: string, concurrency = 3) {
  let names: string[];
  if (fs.existsSync(namesArg)) {
    names = fs.readFileSync(namesArg, 'utf-8')
      .split('\n').map(s => s.trim()).filter(Boolean);
  } else {
    names = namesArg.split(',').map(s => s.trim()).filter(Boolean);
  }

  if (names.length === 0) {
    console.error(red('No politicians supplied — pass "A,B,C" or a file path.'));
    process.exit(1);
  }

  header(`CivicLens Batch — ${names.length} politicians (concurrency ${concurrency})`);

  const results: Array<{ name: string; ok: boolean; error?: string }> = [];
  const queue = [...names];
  const runners: Promise<void>[] = [];

  const worker = async () => {
    while (queue.length > 0) {
      const name = queue.shift();
      if (!name) break;
      try {
        await runPipeline(name, { skipVaultRegen: true });
        results.push({ name, ok: true });
      } catch (e: any) {
        results.push({ name, ok: false, error: e.message });
      }
    }
  };

  for (let i = 0; i < Math.min(concurrency, names.length); i++) {
    runners.push(worker());
  }
  await Promise.all(runners);

  console.log(`\n${c.cyan}${'─'.repeat(58)}${c.reset}`);
  console.log(`  ${bold('Batch complete')} — ${results.filter(r => r.ok).length}/${results.length} succeeded`);
  for (const r of results) {
    if (r.ok) ok(r.name.slice(0, 18), 'done');
    else      fail(r.name.slice(0, 18), r.error?.slice(0, 60) ?? 'unknown error');
  }

  if (results.some(r => r.ok)) regenerateVault();
  console.log();
}

// ─── Append + run + auto-apply ────────────────────────────────────────────────
async function appendAndRun(name: string) {
  const namesPath = NAMES_PATH;
  const existing = fs.existsSync(namesPath)
    ? fs.readFileSync(namesPath, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean)
    : [];

  const already = existing.some(n => n.toLowerCase() === name.toLowerCase());
  if (already) {
    ok('names.txt', `"${name}" already present — skipping append`);
  } else {
    fs.appendFileSync(namesPath, (existing.length > 0 ? '\n' : '') + name + '\n');
    ok('names.txt', `appended "${name}" (total ${existing.length + 1})`);
  }

  await runPipeline(name);

  const taskId = findFreshTask(name);
  if (!taskId) {
    warn('append', 'no approved task for this name');
    return;
  }
  // The member is already in DuckDB via syncTask (inside runPipeline). The
  // legacy seed.ts apply step is gone — rebuild the static site to publish.
  console.log(`\n  ${cyan('›')}  ${bold('In DuckDB.')} ${dim('Rebuild site: npx tsx render/build.ts')}`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────
const [,, arg, arg2, arg3] = process.argv;

if (!arg || arg === '--help') {
  console.log(`
${bold('CivicLens Pipeline Runner')}

  ${cyan('npx tsx agents/pipeline.ts "Politician Name" [--force]')} run full pipeline (--force bypasses 24h cache)
  ${cyan('npx tsx agents/pipeline.ts --append "Name"')}        append to names.txt and run (syncs to DuckDB)
  ${cyan('npx tsx agents/pipeline.ts --batch "A,B,C"')}        run multiple in parallel
  ${cyan('npx tsx agents/pipeline.ts --batch names.txt [n]')} batch from file (concurrency n, default 3)
  ${cyan('npx tsx agents/pipeline.ts --list')}                 list recent tasks
  ${cyan('npx tsx agents/pipeline.ts --status <task-id>')}     show task details
  ${cyan('npx tsx agents/pipeline.ts --load-pfd <year> [--dry-run]')} load House Clerk PFDs for year into DuckDB
  ${cyan('npx tsx agents/pipeline.ts --load-senate-ptr [--dry-run]')} load Senate EFDS PTRs into DuckDB
  ${cyan('npx tsx agents/pipeline.ts --load-fec-ie <cycle[,cycle]> [--dry-run]')} load FEC Super PAC IE into DuckDB
  ${cyan('npx tsx agents/pipeline.ts --load-opensecrets <cycle[,cycle]> [--dry-run]')} parse cached OpenSecrets industry HTML into DuckDB
  ${cyan('npx tsx agents/pipeline.ts --load-bills [--api-pass] [--api-limit N] [--limit N]')} backfill votes.bill_id + fetch summaries
  ${cyan('npx tsx agents/pipeline.ts --load-sponsored [member-id]')} authoritative sponsor rows + inline policyArea (run AFTER load-from-tasks)
  ${cyan('npx tsx agents/pipeline.ts --load-lda [args...]')}        Senate LDA lobbying (full options in db/load-lda.ts; use --years 2018-2026 etc)
  ${cyan('npx tsx agents/pipeline.ts --load-district-contracts [member-id] [--cy 2023,2024,2025] [--force] [--dry-run]')} USAspending NAICS rollups per House district
  ${cyan('npx tsx agents/pipeline.ts --render')}                     build static site at ~/Developer/civiclens/site/
  ${cyan('npx tsx agents/pipeline.ts --refresh-research "Name"')}    fetch researcher data only (no LLM agents, no predictor) and sync to DB
`);
} else if (arg === '--list') {
  listTasks();
} else if (arg === '--status') {
  if (!arg2) { console.error('Usage: --status <task-id>'); process.exit(1); }
  showStatus(arg2);
} else if (arg === '--refresh-research') {
  if (!arg2) { console.error('Usage: --refresh-research "Politician Name"'); process.exit(1); }
  (async () => {
    const taskId = `task-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const task = initTask(taskId, arg2);
    setStatus(task, 'researching');
    const researchOk = await runResearcher(task);
    if (!researchOk) {
      setStatus(task, 'failed');
      console.error(red('Researcher failed.'));
      process.exit(1);
    }
    try { await syncTask(task.taskId); }
    catch (e: any) { warn('DB', `sync-task failed: ${e.message}`); }
    setStatus(task, 'research-only' as any);
    console.log(`\n  ${green('✓')} ${bold('Researcher refresh complete')} for ${arg2}`);
    console.log(`  ${dim('Task:')} ${taskId}`);
    process.exit(0);
  })().catch(e => { console.error(red(`\nFatal: ${e.message}`)); process.exit(1); });
} else if (arg === '--render') {
  (async () => {
    const { buildAll } = await import('../render/build.js');
    await buildAll();
    process.exit(0);
  })().catch(e => { console.error(red(`\nFatal: ${e.message}`)); process.exit(1); });
} else if (arg === '--load-pfd') {
  if (!arg2) { console.error('Usage: --load-pfd <year[,year,...]> [--dry-run]'); process.exit(1); }
  const years = arg2.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
  if (years.length === 0) { console.error('--load-pfd: years must be numeric'); process.exit(1); }
  const dryRun = arg3 === '--dry-run' || process.argv.includes('--dry-run');
  (async () => {
    const { loadPfdYears } = await import('../db/load-pfd.js');
    const { totalUnmatched } = await loadPfdYears(years, { dryRun });
    process.exit(totalUnmatched > 0 ? 1 : 0);
  })().catch(e => { console.error(red(`\nFatal: ${e.message}`)); process.exit(2); });
} else if (arg === '--load-fec-ie') {
  const dryRun = process.argv.includes('--dry-run');
  const cycleArg = arg2 && !arg2.startsWith('--') ? arg2 : '2024';
  (async () => {
    const { loadFecIe, parseArgs } = await import('../db/load-fec-ie.js');
    const { cycles } = parseArgs([cycleArg]);
    const { results, errored } = await loadFecIe(cycles, { dryRun });
    const withIe = results.filter((r: any) => !r.error && r.aggregates > 0).length;
    console.log(`\nFEC IE load: ${results.length} member-cycle rows, ${withIe} with IE, ${errored} errored${dryRun ? ' (dry-run)' : ''}`);
    process.exit(errored > 0 ? 1 : 0);
  })().catch(e => { console.error(red(`\nFatal: ${e.message}`)); process.exit(2); });
} else if (arg === '--load-opensecrets') {
  const dryRun = process.argv.includes('--dry-run');
  const cycleArg = arg2 && !arg2.startsWith('--') ? arg2 : '2024';
  (async () => {
    const { loadOpenSecrets, parseArgs } = await import('../db/load-opensecrets.js');
    const { cycles } = parseArgs([cycleArg]);
    const { results, errored } = await loadOpenSecrets(cycles, { dryRun });
    const ok = results.filter((r: any) => !r.error).length;
    console.log(`\nOpenSecrets load: ${results.length} member-cycle file(s), ${ok} loaded, ${errored} errored${dryRun ? ' (dry-run)' : ''}`);
    process.exit(errored > 0 && results.every((r: any) => r.error) ? 1 : 0);
  })().catch(e => { console.error(red(`\nFatal: ${e.message}`)); process.exit(2); });
} else if (arg === '--load-bills') {
  (async () => {
    const { main: loadBills } = await import('../db/load-bill-summaries.js');
    const pargs = process.argv.slice(2);
    const limitIdx    = pargs.indexOf('--limit');
    const apiLimitIdx = pargs.indexOf('--api-limit');
    const limit       = limitIdx    >= 0 ? parseInt(pargs[limitIdx    + 1] ?? '', 10) : undefined;
    const apiLimit    = apiLimitIdx >= 0 ? parseInt(pargs[apiLimitIdx + 1] ?? '', 10) : undefined;
    const apiPass     = pargs.includes('--api-pass');
    await loadBills({ limit, apiPass, apiLimit });
    process.exit(0);
  })().catch(e => { console.error(red(`\nFatal: ${e.message}`)); process.exit(1); });
} else if (arg === '--load-ticker-sectors') {
  (async () => {
    const { loadTickerSectors } = await import('../db/load-ticker-sectors.js');
    const li = process.argv.indexOf('--limit');
    const limit = li >= 0 ? parseInt(process.argv[li + 1] ?? '', 10) : undefined;
    await loadTickerSectors({ limit });
    process.exit(0);
  })().catch(e => { console.error(red(`\nFatal: ${e.message}`)); process.exit(1); });
} else if (arg === '--load-sector-crosswalk') {
  (async () => {
    const { loadSectorCrosswalk } = await import('../db/load-sector-crosswalk.js');
    await loadSectorCrosswalk();
    process.exit(0);
  })().catch(e => { console.error(red(`\nFatal: ${e.message}`)); process.exit(1); });
} else if (arg === '--load-district-contracts') {
  (async () => {
    const { loadDistrictContracts, parseArgs } = await import('../db/load-district-contracts.js');
    const { errored } = await loadDistrictContracts(parseArgs(process.argv.slice(3)));
    process.exit(errored > 0 ? 1 : 0);
  })().catch(e => { console.error(red(`\nFatal: ${e.message}`)); process.exit(1); });
} else if (arg === '--load-bill-subjects') {
  (async () => {
    const { loadBillSubjects } = await import('../db/load-bill-subjects.js');
    const li = process.argv.indexOf('--limit');
    const limit = li >= 0 ? parseInt(process.argv[li + 1] ?? '', 10) : undefined;
    await loadBillSubjects({ limit });
    process.exit(0);
  })().catch(e => { console.error(red(`\nFatal: ${e.message}`)); process.exit(1); });
} else if (arg === '--load-sponsored') {
  (async () => {
    const { loadSponsored } = await import('../db/load-sponsored.js');
    const memberId = arg2 && !arg2.startsWith('--') ? arg2 : null;
    await loadSponsored({ memberId });
    process.exit(0);
  })().catch(e => { console.error(red(`\nFatal: ${e.message}`)); process.exit(1); });
} else if (arg === '--load-lda') {
  // Delegate to the standalone LDA loader with all remaining CLI args
  (async () => {
    const { spawnSync } = await import('child_process');
    const rest = process.argv.slice(3); // after --load-lda
    const res = spawnSync('npx', ['tsx', 'db/load-lda.ts', ...rest], { stdio: 'inherit' });
    process.exit(res.status ?? 1);
  })().catch(e => { console.error(red(`\nFatal: ${e.message}`)); process.exit(1); });
} else if (arg === '--load-senate-ptr') {
  const dryRun = process.argv.includes('--dry-run');
  (async () => {
    const { loadSenatePtrs } = await import('../db/load-senate-ptr.js');
    const { filers, totalTx, unmatched } = await loadSenatePtrs({ dryRun });
    const nameW = Math.max(20, ...filers.map((f: any) => f.name.length));
    const memberW = Math.max(20, ...filers.map((f: any) => (f.memberId ?? 'unmatched').length));
    const line = '─'.repeat(nameW + memberW + 30);
    console.log(`\nLoading Senate PTRs${dryRun ? ' (dry-run)' : ''}…\n`);
    console.log(line);
    for (const f of filers) {
      const conf = f.confidence ? f.confidence.toFixed(2) : ' — ';
      console.log(`${f.name.padEnd(nameW)}  ${(f.memberId ?? 'UNMATCHED').padEnd(memberW)}  ${conf}  ${f.method.padEnd(20)}  ${f.txCount}`);
    }
    console.log(line);
    console.log(`Total: ${filers.length} filer(s), ${totalTx} transactions, ${unmatched} unmatched`);
    process.exit(unmatched > 0 ? 1 : 0);
  })().catch(e => { console.error(red(`\nFatal: ${e.message}`)); process.exit(1); });
} else if (arg === '--append') {
  if (!arg2) { console.error('Usage: --append "Politician Name"'); process.exit(1); }
  appendAndRun(arg2).catch(e => {
    console.error(red(`\nFatal: ${e.message}`));
    process.exit(1);
  });
} else if (arg === '--batch') {
  if (!arg2) { console.error('Usage: --batch "A,B,C" [concurrency]  OR  --batch names.txt [concurrency]'); process.exit(1); }
  const concurrency = arg3 ? Math.max(1, parseInt(arg3, 10)) : 3;
  runBatch(arg2, concurrency).catch(e => {
    console.error(red(`\nFatal: ${e.message}`));
    process.exit(1);
  });
} else {
  const force = process.argv.includes('--force');
  runPipeline(arg, { force }).catch(e => {
    console.error(red(`\nFatal: ${e.message}`));
    process.exit(1);
  });
}
