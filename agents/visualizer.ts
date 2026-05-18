import type { PipelineTask } from '../lib/types.js';
import { ok, fail, readPipe, writePipe, markAgent } from './shared.js';
import { normalizeDonorName } from './connection-mapper.js';

export async function runVisualizer(task: PipelineTask): Promise<boolean> {
  markAgent(task, 'visualizer', 'running');

  let mapper: any;
  let researcher: any;
  try {
    mapper     = readPipe<any>(task.taskId, 'connection-mapper');
    researcher = readPipe<any>(task.taskId, 'researcher');
  } catch (e: any) {
    fail('Visualizer', `missing input: ${e.message}`);
    markAgent(task, 'visualizer', 'failed', { error: e.message });
    return false;
  }

  const nodes: any[] = [];
  const edges: any[] = [];
  const nodeIds = new Set<string>();

  // 1. Subject node
  nodes.push({
    id: mapper.subjectId,
    label: mapper.subjectName,
    attributes: { type: 'politician', size: 14 },
  });
  nodeIds.add(mapper.subjectId);

  // 2. One node per unique `to` slug in directLinks + hiddenConnections
  const politicianSlugs = new Map<string, string>();
  for (const link of [...(mapper.directLinks ?? []), ...(mapper.hiddenConnections ?? [])]) {
    if (link?.to && !politicianSlugs.has(link.to)) {
      politicianSlugs.set(link.to, link.toName ?? link.to);
    }
  }
  for (const [slug, label] of politicianSlugs) {
    nodes.push({ id: slug, label, attributes: { type: 'politician', size: 10 } });
    nodeIds.add(slug);
  }

  // 3. One node per unique donorName in sharedDonors
  const donorTypeByName = new Map<string, string>();
  for (const d of researcher.data?.donors ?? []) {
    if (d?.name) donorTypeByName.set(normalizeDonorName(d.name), d.type ?? 'donor');
  }
  const donorIdBySharedEntry = new Map<any, string>();
  for (const sd of mapper.sharedDonors ?? []) {
    const donorId = `donor:${normalizeDonorName(sd.donorName).toLowerCase().replace(/\s+/g, '-')}`;
    if (nodeIds.has(donorId)) continue;
    const type = donorTypeByName.get(normalizeDonorName(sd.donorName)) ?? 'donor';
    nodes.push({
      id: donorId,
      label: sd.donorName,
      attributes: { type, size: 8, sourceUrl: sd.sourceUrl ?? '' },
    });
    nodeIds.add(donorId);
    donorIdBySharedEntry.set(sd, donorId);
  }

  // 4. Politician edges
  let edgeCounter = 1;
  for (const link of mapper.directLinks ?? []) {
    if (!nodeIds.has(link.to)) continue;
    edges.push({
      id: `e${edgeCounter++}`,
      source: mapper.subjectId,
      target: link.to,
      attributes: {
        type: 'direct',
        strength: typeof link.strength === 'number' ? link.strength : 0.5,
        label: link.evidence ?? link.type ?? 'direct link',
      },
    });
  }
  for (const link of mapper.hiddenConnections ?? []) {
    if (!nodeIds.has(link.to)) continue;
    edges.push({
      id: `e${edgeCounter++}`,
      source: mapper.subjectId,
      target: link.to,
      attributes: {
        type: 'hidden',
        strength: typeof link.strength === 'number' ? link.strength : 0.5,
        label: link.via ?? link.evidence ?? 'hidden link',
      },
    });
  }

  // 5. Donor edges — strength ∝ log(subjectAmount)
  for (const sd of mapper.sharedDonors ?? []) {
    const donorId = donorIdBySharedEntry.get(sd);
    if (!donorId) continue;
    const amount = sd.subjectAmount ?? 0;
    const strength = Math.min(1, Math.log10(amount + 1) / 7);
    edges.push({
      id: `e${edgeCounter++}`,
      source: mapper.subjectId,
      target: donorId,
      attributes: {
        type: 'shared-donor',
        strength,
        label: `$${(amount / 1e3).toFixed(0)}k`,
      },
    });
  }

  const output = {
    taskId:      task.taskId,
    generatedAt: new Date().toISOString(),
    graph: { nodes, edges },
    charts: [],
  };

  writePipe(task.taskId, 'visualizer', output);
  markAgent(task, 'visualizer', 'complete', { nodeCount: nodes.length, edgeCount: edges.length });
  ok('Visualizer', `${nodes.length} nodes, ${edges.length} edges`);
  return true;
}
