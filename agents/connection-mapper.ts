import { loadCorpus } from '../db/sync-task.js';
import type { PipelineTask } from '../lib/types.js';
import {
  LLM_MODEL, ok, fail, warn, info, spin,
  readPipe, writePipe, markAgent,
  loadSkill, llm, extractJson,
} from './shared.js';

// Donor-name normalization — single source for matching across Researcher, Mapper, etc.
export function normalizeDonorName(raw: string): string {
  return (raw ?? '')
    .toUpperCase()
    .replace(/\b(JR|SR|II|III|IV|ESQ|PHD|MD)\b\.?/g, '')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeSharedDonors(
  subject: any,
  corpus: Array<{ taskId: string; data: any }>,
): any[] {
  const subjectDonors = new Map<string, any>();
  for (const dn of subject.donors ?? []) {
    const k = normalizeDonorName(dn.name);
    if (k) subjectDonors.set(k, dn);
  }
  if (subjectDonors.size === 0) return [];

  const merged = new Map<string, any>();
  for (const { data } of corpus) {
    const slug = data.id;
    for (const od of data.donors ?? []) {
      const k = normalizeDonorName(od.name);
      if (!k) continue;
      const sd = subjectDonors.get(k);
      if (!sd) continue;
      const entry = merged.get(k) ?? {
        donorName:     sd.name,
        sharedWith:    new Set<string>(),
        subjectAmount: sd.amount ?? 0,
        otherAmount:   0,
        sourceUrl:     sd.sourceUrl ?? od.sourceUrl ?? '',
      };
      entry.sharedWith.add(slug);
      entry.otherAmount += (od.amount ?? 0);
      merged.set(k, entry);
    }
  }
  return [...merged.values()]
    .map(e => ({ ...e, sharedWith: [...e.sharedWith] }))
    .sort((a, b) => (b.subjectAmount + b.otherAmount) - (a.subjectAmount + a.otherAmount));
}

// Deterministic committee-membership intersection. Committees are identified by
// code (e.g. "SSJU" or "SSJU22") — no normalization needed.
export function computeSharedCommittees(
  subject: any,
  corpus: Array<{ taskId: string; data: any }>,
): any[] {
  const subjectComm = new Map<string, any>();
  for (const c of subject.committees ?? []) {
    if (c.code) subjectComm.set(c.code, c);
  }
  if (subjectComm.size === 0) return [];

  const merged = new Map<string, any>();
  for (const { data } of corpus) {
    const slug = data.id;
    for (const oc of data.committees ?? []) {
      if (!oc.code) continue;
      const sc = subjectComm.get(oc.code);
      if (!sc) continue;
      const entry = merged.get(oc.code) ?? {
        code:           oc.code,
        name:           sc.name,
        chamber:        sc.chamber,
        isSubcommittee: sc.isSubcommittee,
        subjectRole:    sc.role,
        sharedWith:     new Set<string>(),
        perOther:       {} as Record<string, string>,
        sourceUrl:      sc.sourceUrl ?? oc.sourceUrl ?? '',
      };
      entry.sharedWith.add(slug);
      entry.perOther[slug] = oc.role;
      merged.set(oc.code, entry);
    }
  }

  const leadershipWeight = (role: string) =>
    role === 'Chair' ? 2 : role === 'Ranking Member' ? 1 : 0;
  return [...merged.values()]
    .map(e => ({ ...e, sharedWith: [...e.sharedWith] }))
    .sort((a, b) => {
      const sizeDiff = b.sharedWith.length - a.sharedWith.length;
      if (sizeDiff !== 0) return sizeDiff;
      return leadershipWeight(b.subjectRole) - leadershipWeight(a.subjectRole);
    });
}

export async function runConnectionMapper(task: PipelineTask): Promise<boolean> {
  markAgent(task, 'connection-mapper', 'running');

  const skill = loadSkill('connection-mapper');
  if (skill.source === 'none') {
    fail('Connection Mapper', 'no skill definition found at skills/connection-mapper/');
    markAgent(task, 'connection-mapper', 'failed');
    return false;
  }

  const researcher = readPipe<any>(task.taskId, 'researcher');
  const d = researcher.data;
  const subjectId   = d.id   as string;
  const subjectName = d.name as string;

  const otherRaw = await loadCorpus(d.id);
  const comparedAgainst = otherRaw.map(({ taskId, data }) => ({
    id: data.id, name: data.name, taskId,
  }));
  const corpusAsOf = otherRaw.map(({ taskId, data, mtime }) => ({
    id: data.id, taskId, researcherMtime: new Date(mtime).toISOString(),
  }));

  spin('Connection Mapper', `stage 1: matching vs ${comparedAgainst.length} politician(s)…`);
  const sharedDonors     = computeSharedDonors(d, otherRaw);
  const sharedCommittees = computeSharedCommittees(d, otherRaw);
  process.stdout.write('\n');

  let hiddenConnections: any[] = [];
  let indirectLinks:     any[] = [];
  let directLinks:       any[] = [];
  let networkSummary = '';

  const hasStage1Matches = sharedDonors.length > 0 || sharedCommittees.length > 0;
  if (!hasStage1Matches || comparedAgainst.length === 0) {
    networkSummary = comparedAgainst.length === 0
      ? `No other politicians in the corpus to compare ${subjectName} against.`
      : `No verified shared donors or committees between ${subjectName} and ${comparedAgainst.length} compared politician(s). Stage 2 skipped — model has no verified facts to narrate.`;
    info('Connection Mapper', 'stage 2 skipped (no verified matches)');
  } else {
    spin('Connection Mapper', `stage 2: narrative via ${LLM_MODEL}…`);
    const otherById = new Map(otherRaw.map(({ data }) => [data.id, data]));
    const narrativeInput = {
      subject: { id: d.id, name: d.name, party: d.party, state: d.state, chamber: d.chamber },
      sharedDonors,
      sharedCommittees,
      relatedPoliticians: [...new Set([
        ...sharedDonors.flatMap((s: any) => s.sharedWith),
        ...sharedCommittees.flatMap((s: any) => s.sharedWith),
      ])]
        .map(slug => {
          const o = otherById.get(slug);
          return o ? { id: o.id, name: o.name, party: o.party, state: o.state, chamber: o.chamber } : null;
        })
        .filter(Boolean),
    };

    const userPrompt = `The shared donors AND shared committees below are PRE-VERIFIED by deterministic matching. You may not add, remove, or rename any donor or committee. Your job is narrative only.

VERIFIED FACTS:
${JSON.stringify(narrativeInput, null, 2)}

Return ONE JSON object — no markdown, no prose — with exactly these keys:
{
  "directLinks":       [{"from": "${subjectId}", "to": "slug", "toName": "", "type": "shared-donor|committee-colleague|committee-leadership|party-ally|state-colleague", "strength": 0.0, "evidence": "one sentence referencing a specific shared donor or committee above"}],
  "hiddenConnections": [{"from": "${subjectId}", "to": "slug", "toName": "", "via": "donor/PAC/committee name from list above", "type": "", "strength": 0.0, "evidence": "two sentences of factual reasoning — cite donor or committee names from the lists"}],
  "indirectLinks":     [{"via": "mechanism", "to": "slug", "toName": "", "linkType": "", "strength": 0.0}],
  "networkSummary":    "2-3 neutral sentences citing specific donor names or committee names from the verified lists"
}

Rules:
- Every edge must reference a slug that appears in relatedPoliticians.
- Every evidence string must cite a donor name from sharedDonors OR a committee code/name from sharedCommittees.
- Use "committee-leadership" when subject and target are both Chair or Ranking Member of the same committee (asymmetric power dynamic worth surfacing).
- Use "committee-colleague" when both are ordinary members of the same committee.
- If you cannot support an edge with verified data, omit that edge.`;

    try {
      const r = await llm(
        [
          { role: 'system', content: skill.systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        { maxTokens: 1500, timeoutMs: 60_000 },
      );
      process.stdout.write('\n');
      const parsed = extractJson(r) as any;
      if (parsed && typeof parsed === 'object') {
        directLinks       = Array.isArray(parsed.directLinks)       ? parsed.directLinks       : [];
        hiddenConnections = Array.isArray(parsed.hiddenConnections) ? parsed.hiddenConnections : [];
        indirectLinks     = Array.isArray(parsed.indirectLinks)     ? parsed.indirectLinks     : [];
        networkSummary    = typeof parsed.networkSummary === 'string' ? parsed.networkSummary : '';
      }
    } catch (e: any) {
      process.stdout.write('\n');
      warn('Connection Mapper', `stage 2 failed: ${e.message}`);
    }

    const allowedSlugs = new Set(narrativeInput.relatedPoliticians.map((p: any) => p.id));
    const filterEdges = (arr: any[]) => arr.filter(e => allowedSlugs.has(e.to));
    directLinks       = filterEdges(directLinks);
    hiddenConnections = filterEdges(hiddenConnections);
    indirectLinks     = filterEdges(indirectLinks);
  }

  const output = {
    taskId:            task.taskId,
    analyzedAt:        new Date().toISOString(),
    subjectId,
    subjectName,
    comparedAgainst,
    corpusAsOf,
    sharedDonors,
    sharedCommittees,
    directLinks,
    hiddenConnections,
    indirectLinks,
    networkSummary,
  };

  writePipe(task.taskId, 'connection-mapper', output);
  markAgent(task, 'connection-mapper', 'complete', {
    hiddenCount:          output.hiddenConnections.length,
    indirectCount:        output.indirectLinks.length,
    sharedCommitteeCount: output.sharedCommittees.length,
  });

  ok('Connection Mapper', `vs ${comparedAgainst.length} → ${output.sharedDonors.length} shared donors, ${output.sharedCommittees.length} shared committees, ${output.hiddenConnections.length} hidden, ${output.indirectLinks.length} indirect`);
  return true;
}
