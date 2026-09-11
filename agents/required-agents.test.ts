/**
 * Required-agent gating tests.
 *
 * Stratum 4 (Chris Van Hollen): the summarizer's Claude CLI timed out at 120s,
 * the pipeline's built-in retry timed out again, and the run then continued
 * through the code checker and final reviewer to an APPROVED / ready-to-apply
 * decision with no summary on disk.
 *
 * The generic rule these tests pin: once the built-in retry is exhausted, a
 * REQUIRED agent's failure ends the run non-zero. It is never downgraded to a
 * warning, and it never reaches an approval decision. A soft sidecar
 * (predictor, trade-analyst) keeps its existing warn-and-continue behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_AGENTS, requiredAgentFailures, pipelineExitCode } from './required-agents.js';
import type { AgentName, AgentStatus, PipelineTask } from '../lib/types.js';

/**
 * An in-memory task, mirroring initTask's agent map.
 *
 * Deliberately NOT initTask(): that writes state.json under agents/shared.ts
 * PIPE_DIR, which is resolved to a module-load-time const — so an env override
 * set inside a test arrives too late and the run litters the real pipeline/
 * directory with task-* dirs. The functions under test are pure reads of
 * task.agents, so no filesystem is needed.
 */
const ALL_AGENTS: AgentName[] = [
  'researcher', 'data-checker', 'predictor', 'trade-analyst',
  'summarizer', 'code-checker', 'final-reviewer',
];

function task(id: string): PipelineTask {
  const now = new Date().toISOString();
  const agents = Object.fromEntries(
    ALL_AGENTS.map(a => [a, { status: 'pending' as AgentStatus, retries: 0 }]),
  ) as PipelineTask['agents'];
  return {
    taskId: id, createdAt: now, updatedAt: now, status: 'initializing',
    target: { name: 'Jane Doe', type: 'politician' }, agents,
  };
}

/** In-memory equivalent of shared.ts markAgent (no state.json write). */
function markAgent(t: PipelineTask, agent: AgentName, status: AgentStatus, output?: unknown): void {
  t.agents[agent] = { ...t.agents[agent], status, output };
}

test('the summarizer is a required agent', () => {
  assert.ok(
    (REQUIRED_AGENTS as readonly string[]).includes('summarizer'),
    'the summarizer produces a required artifact family and must gate the run',
  );
});

test('a summarizer that failed after its retry is reported as a required failure', () => {
  const t = task('task-red-1');
  // Exactly the observed shape: everything upstream succeeded, and the
  // summarizer consumed its one retry and still failed.
  for (const a of REQUIRED_AGENTS) {
    if (a !== 'summarizer') markAgent(t, a, 'complete');
  }
  t.agents.summarizer.retries = 1;
  markAgent(t, 'summarizer', 'failed', { error: 'claude CLI timed out after 120000ms' });

  const failures = requiredAgentFailures(t);
  assert.deepEqual(failures, ['summarizer']);
});

test('an exhausted-retry summarizer failure makes the pipeline exit non-zero', () => {
  const t = task('task-red-2');
  t.agents.summarizer.retries = 1;
  markAgent(t, 'summarizer', 'failed', { error: 'claude CLI timed out after 120000ms' });

  assert.notEqual(
    pipelineExitCode(t), 0,
    'the run must fail closed, not continue to an approval decision',
  );
});

test('a required agent that never ran (pending) also fails the run — no silent absence', () => {
  const t = task('task-red-3');
  // Nothing marked at all: the artifact is simply absent.
  assert.ok(requiredAgentFailures(t).includes('summarizer'),
    'an unproduced required artifact is a failure, not a pass');
  assert.notEqual(pipelineExitCode(t), 0);
});

test('an explicitly skipped summarizer (CIVICLENS_SUMMARIZER=0) is not a required failure', () => {
  const t = task('task-green-skip');
  markAgent(t, 'summarizer', 'skipped');
  for (const a of REQUIRED_AGENTS) {
    if (a !== 'summarizer') markAgent(t, a, 'complete');
  }
  assert.deepEqual(requiredAgentFailures(t), [],
    'a deliberate operator opt-out is an explicit, recorded state — not a silent loss');
  assert.equal(pipelineExitCode(t), 0);
});

test('a failed SOFT sidecar does not fail the run', () => {
  const t = task('task-green-soft');
  for (const a of REQUIRED_AGENTS) markAgent(t, a, 'complete');
  markAgent(t, 'predictor', 'failed', { error: 'calibration unavailable' });
  markAgent(t, 'trade-analyst', 'failed', { error: 'no trades' });

  assert.deepEqual(requiredAgentFailures(t), [],
    'predictor and trade-analyst stay warn-and-continue sidecars');
  assert.equal(pipelineExitCode(t), 0);
});

test('a fully complete run exits zero', () => {
  const t = task('task-green-all');
  for (const a of REQUIRED_AGENTS) markAgent(t, a, 'complete');
  assert.deepEqual(requiredAgentFailures(t), []);
  assert.equal(pipelineExitCode(t), 0);
});
