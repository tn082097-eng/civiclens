#!/usr/bin/env node
/**
 * Pipeline State Manager
 * Usage:
 *   npx tsx ~/.hermes/civiclens/lib/state.ts init <task-id> <target-json>
 *   npx tsx ~/.hermes/civiclens/lib/state.ts read <task-id>
 *   npx tsx ~/.hermes/civiclens/lib/state.ts update <task-id> <agent> <result-json>
 *   npx tsx ~/.hermes/civiclens/lib/state.ts status <task-id>
 *   npx tsx ~/.hermes/civiclens/lib/state.ts list
 *   npx tsx ~/.hermes/civiclens/lib/state.ts log <task-id> <decision> <reasoning>
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PipelineTask, AgentName, AgentResult, BrainLogEntry } from './types.js';

const PIPELINE_DIR = path.join(process.env.HOME!, '.hermes/civiclens', 'pipeline');

function taskDir(taskId: string) {
  return path.join(PIPELINE_DIR, taskId);
}

function taskFile(taskId: string) {
  return path.join(taskDir(taskId), 'state.json');
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function readTask(taskId: string): PipelineTask {
  const file = taskFile(taskId);
  if (!fs.existsSync(file)) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeTask(task: PipelineTask) {
  ensureDir(taskDir(task.taskId));
  task.updatedAt = new Date().toISOString();
  fs.writeFileSync(taskFile(task.taskId), JSON.stringify(task, null, 2));
}

const defaultAgentResult = (): AgentResult => ({
  status: 'pending',
  retries: 0,
});

function initTask(taskId: string, target: PipelineTask['target']): PipelineTask {
  const task: PipelineTask = {
    taskId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'initializing',
    target,
    agents: {
      brain:               defaultAgentResult(),
      researcher:          defaultAgentResult(),
      'data-checker':      defaultAgentResult(),
      'connection-mapper': defaultAgentResult(),
      summarizer:          defaultAgentResult(),
      coder:               defaultAgentResult(),
      'code-checker':      defaultAgentResult(),
      visualizer:          defaultAgentResult(),
      'final-reviewer':    defaultAgentResult(),
      publisher:           defaultAgentResult(),
    },
    brainLog: [],
  };
  writeTask(task);
  return task;
}

function updateAgent(taskId: string, agent: AgentName, result: Partial<AgentResult>) {
  const task = readTask(taskId);
  task.agents[agent] = {
    ...task.agents[agent],
    ...result,
    completedAt: new Date().toISOString(),
  };
  writeTask(task);
}

function appendLog(taskId: string, entry: Omit<BrainLogEntry, 'timestamp'>) {
  const task = readTask(taskId);
  task.brainLog.push({ ...entry, timestamp: new Date().toISOString() });
  writeTask(task);
}

function printStatus(taskId: string) {
  const task = readTask(taskId);
  console.log(`\nTask: ${task.taskId}`);
  console.log(`Target: ${task.target.name} (${task.target.type})`);
  console.log(`Status: ${task.status}`);
  console.log(`Updated: ${task.updatedAt}\n`);
  console.log('Agents:');
  for (const [name, result] of Object.entries(task.agents)) {
    const icon = result.status === 'complete' ? '✓' :
                 result.status === 'failed'   ? '✗' :
                 result.status === 'running'  ? '⟳' :
                 result.status === 'skipped'  ? '—' : '·';
    console.log(`  ${icon} ${name.padEnd(16)} ${result.status}`);
  }
  if (task.brainLog.length > 0) {
    console.log('\nBrain Log:');
    for (const entry of task.brainLog.slice(-5)) {
      console.log(`  [${entry.timestamp.slice(11, 19)}] ${entry.decision}`);
      console.log(`           → ${entry.reasoning}`);
    }
  }
}

function listTasks() {
  if (!fs.existsSync(PIPELINE_DIR)) {
    console.log('No tasks found.');
    return;
  }
  const tasks = fs.readdirSync(PIPELINE_DIR).filter(f =>
    fs.existsSync(path.join(PIPELINE_DIR, f, 'state.json'))
  );
  if (tasks.length === 0) {
    console.log('No tasks found.');
    return;
  }
  for (const taskId of tasks) {
    const task = readTask(taskId);
    console.log(`${taskId}  ${task.target.name}  ${task.status}  ${task.updatedAt.slice(0, 19)}`);
  }
}

// CLI entrypoint
const [,, command, ...args] = process.argv;

switch (command) {
  case 'init': {
    const [taskId, targetJson] = args;
    const target = JSON.parse(targetJson);
    const task = initTask(taskId, target);
    console.log(JSON.stringify(task, null, 2));
    break;
  }
  case 'read': {
    const task = readTask(args[0]);
    console.log(JSON.stringify(task, null, 2));
    break;
  }
  case 'update': {
    const [taskId, agent, resultJson] = args;
    updateAgent(taskId, agent as AgentName, JSON.parse(resultJson));
    console.log(`Updated ${agent} for task ${taskId}`);
    break;
  }
  case 'status': {
    printStatus(args[0]);
    break;
  }
  case 'list': {
    listTasks();
    break;
  }
  case 'log': {
    const [taskId, decision, reasoning, nextStep] = args;
    appendLog(taskId, { decision, reasoning, nextStep: nextStep as AgentName });
    console.log('Logged.');
    break;
  }
  default: {
    console.error(`Unknown command: ${command}`);
    console.error('Commands: init, read, update, status, list, log');
    process.exit(1);
  }
}
