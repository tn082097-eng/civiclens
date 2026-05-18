import * as fs from 'fs';
import type { PipelineTask } from '../lib/types.js';
import { SEED_PATH, ok, readPipe, writePipe, markAgent } from './shared.js';

export async function runCoder(task: PipelineTask): Promise<boolean> {
  markAgent(task, 'coder', 'running');

  const researcher = readPipe<any>(task.taskId, 'researcher');
  const d = researcher.data;

  const seedContent = fs.existsSync(SEED_PATH) ? fs.readFileSync(SEED_PATH, 'utf-8') : '';
  const hasExisting = [`slug: "${d.id}"`, `slug: '${d.id}'`].some(p => seedContent.includes(p));
  const action = hasExisting ? 'update' : 'insert';

  const SECTION_MAP: Record<string, string> = {
    executive: 'Executive Branch',
    cabinet:   'Cabinet',
    senate:    'Senate',
    house:     'House',
    governor:  'Governors',
    state:     'State & Local',
  };
  const section = SECTION_MAP[d.chamber] ?? 'Unknown';

  const output = {
    taskId: task.taskId,
    generatedAt: new Date().toISOString(),
    action,
    politicianId: d.id,
    section,
    changedFields: ['bio', 'bills', 'votes', 'donors'],
  };

  writePipe(task.taskId, 'coder', output);
  markAgent(task, 'coder', 'complete', { action, politicianId: d.id });
  ok('Coder', `${action} ${d.id} → ${section}`);
  return true;
}
