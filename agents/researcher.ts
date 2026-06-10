import { fetchPolitician } from '../skills/researcher/fetch.js';
import type { PipelineTask } from '../lib/types.js';
import {
  ok, fail, warn, spin,
  writePipe, markAgent,
} from './shared.js';

export async function runResearcher(task: PipelineTask): Promise<boolean> {
  const name = task.target.name;
  markAgent(task, 'researcher', 'running');
  spin('Researcher', `fetching live data for ${name}…`);

  let live: Awaited<ReturnType<typeof fetchPolitician>> = null;
  try {
    live = await fetchPolitician(name);
  } catch (e: any) {
    process.stdout.write('\n');
    fail('Researcher', `live fetch threw: ${e.message}`);
    markAgent(task, 'researcher', 'failed', { error: e.message });
    return false;
  }

  if (!live) {
    process.stdout.write('\n');
    fail('Researcher', `no primary-source data for "${name}" — failing (stub data disabled)`);
    markAgent(task, 'researcher', 'failed', { error: 'no primary-source data available' });
    return false;
  }

  process.stdout.write('\n');
  for (const w of live.warnings) warn('Researcher', w);

  const id = name.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const politicianData = {
    id,
    name,
    party:    live.party,
    state:    live.state,
    chamber:  live.chamber,
    role:     live.role,
    bioguideId:       (live as any).bioguideId ?? null,
    district:         (live as any).district ?? null,
    firstElectedYear: (live as any).firstElectedYear ?? null,
    fecCandidateId:   (live as any).fecCandidateId ?? null,
    bio:      live.bio,
    inOffice: live.inOffice,
    bills:    live.bills,
    votes:    live.votes,
    donors:   live.donors,
    controversies: [] as any[],
    connections:   [] as any[],
    committees:       live.committees,
    upcomingMeetings: live.upcomingMeetings,
  };

  for (const bill of politicianData.bills) {
    if (!bill.summary || bill.summary.length < 20) bill.summary = bill.title;
  }

  ok('Researcher', `${live.source}: ${live.bills.length} bills, ${live.votes.length} votes, ${live.donors.length} donors`);

  // No top-level confidence number: the old 0.97/0.95 constants were
  // pseudo-precision, not computed from anything. `source` is the provenance.
  const output = {
    source: live.source,
    fetchedAt: new Date().toISOString(),
    target: { name, type: 'politician' },
    warnings: live.warnings,
    data: politicianData,
  };

  writePipe(task.taskId, 'researcher', output);
  markAgent(task, 'researcher', 'complete', { politicianId: politicianData.id, source: live.source });
  return true;
}
