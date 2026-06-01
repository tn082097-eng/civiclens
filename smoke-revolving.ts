import { loadHermesEnv } from './agents/shared.js';
loadHermesEnv();
import { runRevolvingDoor } from './agents/revolving-door.js';
import type { PipelineTask } from './lib/types.js';

const task: PipelineTask = {
  taskId: 'smoke-revolving-' + Date.now(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: 'connecting',
  target: { type: 'politician', name: process.argv[2] ?? 'Marjorie Taylor Greene' },
  agents: {
    'revolving-door': { status: 'pending', retries: 0 },
  } as any,
  brainLog: [],
};

console.log('Running revolving-door smoke test for:', task.target.name);
const ok = await runRevolvingDoor(task);
console.log('Returned:', ok);

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PIPE_DIR } from './lib/paths.js';
const outPath = join(PIPE_DIR, task.taskId, 'revolving-door.json');
try {
  const out = JSON.parse(readFileSync(outPath, 'utf-8'));
  console.log('---OUTPUT---');
  console.log('riskLevel:', out.riskLevel);
  console.log('total:', out.totalConnections);
  console.log('highRisk:', out.highRiskCount);
  console.log('directCount:', out.directMatches.length);
  console.log('committeeCount:', out.committeeMatches.length);
  console.log('narrative:', out.revolvingDoorNarrative);
} catch (e: any) {
  console.error('Output file missing:', outPath, e.message);
}
