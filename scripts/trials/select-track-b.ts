#!/usr/bin/env node
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type StratumId = '1' | '2' | '3' | '4' | '5' | '6';

export interface ProbeEvidence {
  year: number;
  docId: string;
  hasUsableText: boolean;
}

export interface TrackBCandidate {
  bioguide: string;
  name: string;
  chamber: 'house' | 'senate';
  fecIds: string[];
  housePtrByYear: Record<number, number>;
  housePtrDocIdsByYear?: Record<number, string[]>;
  senatePtrCount: number | null;
  probes: Partial<Record<'text' | 'scanned', ProbeEvidence>>;
}

export interface RankedCandidate extends TrackBCandidate {
  digest: string;
  rank: number;
}

export interface Selection {
  stratum: StratumId;
  bioguide: string;
  name: string;
  digest: string;
  rank: number;
  disqualified: Array<{ bioguide: string; name: string; rank: number; reason: string }>;
}

export function candidateArrayFromInput(input: unknown): TrackBCandidate[] {
  if (Array.isArray(input)) return input as TrackBCandidate[];
  if (input && typeof input === 'object' && Array.isArray((input as any).candidates)) {
    return (input as any).candidates as TrackBCandidate[];
  }
  throw new Error('candidate input must be an array or an object with a candidates array');
}

const ASSIGNMENT_ORDER: StratumId[] = ['1', '2', '6', '3', '4', '5'];

export function rankForStratum(
  candidates: TrackBCandidate[],
  seed: string,
  stratumId: StratumId,
): RankedCandidate[] {
  return candidates
    .map(candidate => ({
      ...candidate,
      digest: createHmac('sha256', seed).update(`${stratumId}${candidate.bioguide}`).digest('hex'),
    }))
    .sort((a, b) => a.digest.localeCompare(b.digest) || a.bioguide.localeCompare(b.bioguide))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function totalHousePtrs(candidate: TrackBCandidate): number {
  return Object.values(candidate.housePtrByYear).reduce((sum, count) => sum + count, 0);
}

function baseEligible(candidate: TrackBCandidate, stratum: StratumId): boolean {
  switch (stratum) {
    case '1': return candidate.chamber === 'senate';
    case '2': return candidate.chamber === 'house' && totalHousePtrs(candidate) === 0;
    case '3': return candidate.chamber === 'house'
      && (candidate.housePtrByYear[2025] ?? 0) >= 10;
    case '4': return candidate.chamber === 'senate';
    case '5': return candidate.fecIds.length === 0;
    case '6': return candidate.chamber === 'house'
      && totalHousePtrs(candidate) > 0;
  }
}

function disqualificationReason(candidate: TrackBCandidate, stratum: StratumId): string | null {
  switch (stratum) {
    case '1':
      if (candidate.senatePtrCount === null) return 'missing-senate-evidence';
      return candidate.senatePtrCount > 0 ? null : 'senate-ptr-count=0';
    case '3':
      if (!candidate.probes.text) return 'missing-text-probe';
      return candidate.probes.text.hasUsableText ? null : 'probe-no-usable-text';
    case '4':
      if (candidate.senatePtrCount === null) return 'missing-senate-evidence';
      return candidate.senatePtrCount === 0 ? null : `senate-ptr-count=${candidate.senatePtrCount}`;
    case '6':
      if (!candidate.probes.scanned) return 'missing-scanned-probe';
      return candidate.probes.scanned.hasUsableText ? 'probe-has-usable-text' : null;
    case '2':
    case '5':
      return null;
  }
}

export function selectForStratum(
  candidates: TrackBCandidate[],
  seed: string,
  stratum: StratumId,
  used: Set<string>,
): {
  selected: RankedCandidate | null;
  baseEligibleCount: number;
  disqualified: Array<RankedCandidate & { reason: string }>;
} {
  const ranked = rankForStratum(candidates.filter(candidate => baseEligible(candidate, stratum)), seed, stratum);
  const disqualified: Array<RankedCandidate & { reason: string }> = [];
  for (const candidate of ranked) {
    const reason = used.has(candidate.bioguide)
      ? 'already-selected'
      : disqualificationReason(candidate, stratum);
    if (!reason) return { selected: candidate, baseEligibleCount: ranked.length, disqualified };
    disqualified.push({ ...candidate, reason });
  }
  return { selected: null, baseEligibleCount: ranked.length, disqualified };
}

export type SelectionResult =
  | { status: 'selected'; assignmentOrder: StratumId[]; selections: Selection[] }
  | {
      status: 'no-candidate' | 'selection-conflict';
      assignmentOrder: StratumId[];
      selections: Selection[];
      failedStratum: StratumId;
      originalEligibleCount: number;
    };

export function selectTrackB(candidates: TrackBCandidate[], seed: string): SelectionResult {
  const used = new Set<string>();
  const selections: Selection[] = [];

  for (const stratum of ASSIGNMENT_ORDER) {
    const result = selectForStratum(candidates, seed, stratum, used);
    const selected = result.selected;
    if (!selected) {
      const hadMatchingCandidate = result.disqualified.some(row =>
        row.reason === 'already-selected' || disqualificationReason(row, stratum) === null);
      return {
        status: result.baseEligibleCount === 0 || !hadMatchingCandidate
          ? 'no-candidate'
          : 'selection-conflict',
        assignmentOrder: [...ASSIGNMENT_ORDER],
        selections,
        failedStratum: stratum,
        originalEligibleCount: result.baseEligibleCount,
      };
    }
    used.add(selected.bioguide);
    selections.push({
      stratum,
      bioguide: selected.bioguide,
      name: selected.name,
      digest: selected.digest,
      rank: selected.rank,
      disqualified: result.disqualified.map(row => ({
        bioguide: row.bioguide,
        name: row.name,
        rank: row.rank,
        reason: row.reason,
      })),
    });
  }

  return { status: 'selected', assignmentOrder: [...ASSIGNMENT_ORDER], selections };
}

function parseArgs(argv: string[]): { candidates: string; seed: string; output?: string } {
  let candidates = '';
  let seed = '';
  let output: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--candidates') candidates = argv[++index] ?? '';
    else if (argv[index] === '--seed') seed = argv[++index] ?? '';
    else if (argv[index] === '--output') output = argv[++index];
  }
  if (!candidates || !seed) {
    throw new Error('usage: select-track-b --candidates candidates.json --seed <seed> [--output manifest.json]');
  }
  return { candidates, seed, output };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const candidates = candidateArrayFromInput(JSON.parse(readFileSync(resolve(args.candidates), 'utf8')));
  const result = selectTrackB(candidates, args.seed);
  const text = `${JSON.stringify({ seed: args.seed, ...result }, null, 2)}\n`;
  if (args.output) writeFileSync(resolve(args.output), text);
  else process.stdout.write(text);
  process.exitCode = result.status === 'selected' ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
