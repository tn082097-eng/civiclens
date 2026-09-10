#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import {
  buildAliasMap,
  buildIndex,
  normalizeName,
  type LegislatorIdentity,
} from '../../lib/legislators.js';
import type { ProbeEvidence, TrackBCandidate } from './select-track-b.js';

export interface HousePtrRecord {
  year: number;
  docId: string;
  first: string;
  last: string;
  stateDistrict: string;
}

export interface CandidateInputs {
  current: Map<string, LegislatorIdentity>;
  housePtrs: HousePtrRecord[];
  excludedBioguides: Map<string, string[]>;
  senateCounts: Map<string, number>;
  probes: Map<string, Partial<Record<'text' | 'scanned', ProbeEvidence>>>;
}

export function deriveExcludedBioguides(
  current: Map<string, LegislatorIdentity>,
  names: string[],
  productionBioguides: string[],
): { excluded: Map<string, string[]>; unresolvedNames: string[] } {
  const reasons = new Map<string, Set<string>>();
  const add = (bioguide: string, reason: string) => {
    const set = reasons.get(bioguide) ?? new Set<string>();
    set.add(reason);
    reasons.set(bioguide, set);
  };
  for (const bioguide of productionBioguides) {
    if (current.has(bioguide)) add(bioguide, 'production-db');
  }
  const aliases = buildAliasMap(current);
  const unresolvedNames: string[] = [];
  for (const name of names) {
    const matches = aliases.get(normalizeName(name));
    if (!matches || matches.size === 0) {
      unresolvedNames.push(name);
      continue;
    }
    for (const bioguide of matches) add(bioguide, `names.txt:${name}`);
  }
  const excluded = new Map(
    [...reasons.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bioguide, values]) => [bioguide, [...values].sort()]),
  );
  return { excluded, unresolvedNames: unresolvedNames.sort() };
}

function xmlValue(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>|<${tag}\\s*/>`));
  return (match?.[1] ?? '').trim();
}

export function parseHouseIndex(xml: string, fallbackYear: number): HousePtrRecord[] {
  const records: HousePtrRecord[] = [];
  const memberPattern = /<Member>([\s\S]*?)<\/Member>/g;
  let match: RegExpExecArray | null;
  while ((match = memberPattern.exec(xml)) !== null) {
    const block = match[1];
    if (xmlValue(block, 'FilingType') !== 'P') continue;
    records.push({
      year: Number(xmlValue(block, 'Year')) || fallbackYear,
      docId: xmlValue(block, 'DocID'),
      first: xmlValue(block, 'First'),
      last: xmlValue(block, 'Last'),
      stateDistrict: xmlValue(block, 'StateDst').toUpperCase().replace(/[^A-Z0-9]/g, ''),
    });
  }
  return records;
}

function normalizedToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)[0] ?? '';
}

function houseRecordMatches(record: HousePtrRecord, member: LegislatorIdentity): boolean {
  if (member.chamber !== 'House' || member.district === null) return false;
  const representedInFilingYear = member.houseTerms.some(term => {
    const startYear = Number(term.start.slice(0, 4));
    const endYear = Number(term.end.slice(0, 4));
    return term.stateDistrict === record.stateDistrict &&
      Number.isInteger(startYear) && Number.isInteger(endYear) &&
      startYear <= record.year && record.year <= endYear;
  });
  if (!representedInFilingYear) return false;
  if (normalizedToken(record.last) !== normalizedToken(member.last)) return false;
  const recordFirst = normalizedToken(record.first);
  const allowedFirst = [member.first, member.nickname ?? '', member.officialFull]
    .map(normalizedToken)
    .filter(Boolean);
  return allowedFirst.some(first => recordFirst.startsWith(first) || first.startsWith(recordFirst));
}

export function buildTrackBCandidates(inputs: CandidateInputs): {
  candidates: TrackBCandidate[];
  excluded: Array<{ bioguide: string; reasons: string[] }>;
} {
  const candidates: TrackBCandidate[] = [];
  const excluded: Array<{ bioguide: string; reasons: string[] }> = [];

  for (const member of [...inputs.current.values()].sort((a, b) => a.bioguide.localeCompare(b.bioguide))) {
    const reasons = inputs.excludedBioguides.get(member.bioguide);
    if (reasons) {
      excluded.push({ bioguide: member.bioguide, reasons: [...reasons].sort() });
      continue;
    }

    const memberPtrs = inputs.housePtrs.filter(record => houseRecordMatches(record, member));
    const docsByYear: Record<number, string[]> = {};
    for (const record of memberPtrs) {
      (docsByYear[record.year] ??= []).push(record.docId);
    }
    for (const docs of Object.values(docsByYear)) docs.sort();
    const countsByYear = Object.fromEntries(
      Object.entries(docsByYear).map(([year, docs]) => [year, docs.length]),
    ) as Record<number, number>;

    candidates.push({
      bioguide: member.bioguide,
      name: member.officialFull,
      chamber: member.chamber === 'Senate' ? 'senate' : 'house',
      fecIds: [...member.fec].sort(),
      housePtrByYear: countsByYear,
      housePtrDocIdsByYear: docsByYear,
      senatePtrCount: inputs.senateCounts.get(member.bioguide) ?? null,
      probes: inputs.probes.get(member.bioguide) ?? {},
    });
  }

  return { candidates, excluded };
}

interface CliArgs {
  legislators: string;
  houseIndexes: Array<{ year: number; path: string }>;
  sourceDb: string;
  names: string;
  senateEvidence?: string;
  probeEvidence?: string;
  output: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { legislators: '', houseIndexes: [], sourceDb: '', names: '', output: '' };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    const value = argv[++index] ?? '';
    if (key === '--legislators') args.legislators = value;
    else if (key === '--house-index') {
      const match = value.match(/^(\d{4})=(.+)$/);
      if (!match) throw new Error('--house-index must be YEAR=PATH');
      args.houseIndexes.push({ year: Number(match[1]), path: match[2] });
    } else if (key === '--source-db') args.sourceDb = value;
    else if (key === '--names') args.names = value;
    else if (key === '--senate-evidence') args.senateEvidence = value;
    else if (key === '--probe-evidence') args.probeEvidence = value;
    else if (key === '--output') args.output = value;
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!args.legislators || args.houseIndexes.length === 0 || !args.sourceDb || !args.names || !args.output) {
    throw new Error('required: --legislators, --house-index YEAR=PATH, --source-db, --names, --output');
  }
  return args;
}

function readOptionalObject<T>(path: string | undefined): Record<string, T> {
  if (!path || !existsSync(resolve(path))) return {};
  return JSON.parse(readFileSync(resolve(path), 'utf8')) as Record<string, T>;
}

async function productionBioguides(path: string): Promise<string[]> {
  const instance = await DuckDBInstance.create(resolve(path), { access_mode: 'READ_ONLY' });
  const conn = await instance.connect();
  try {
    const result = await conn.run(
      'SELECT bioguide_id FROM members WHERE bioguide_id IS NOT NULL ORDER BY bioguide_id',
    );
    return ((await result.getRowObjects()) as Array<{ bioguide_id: string }>)
      .map(row => String(row.bioguide_id));
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const current = buildIndex([resolve(args.legislators)]);
  const housePtrs = args.houseIndexes.flatMap(input =>
    parseHouseIndex(readFileSync(resolve(input.path), 'utf8'), input.year));
  const names = readFileSync(resolve(args.names), 'utf8').split('\n').map(name => name.trim()).filter(Boolean);
  const exclusions = deriveExcludedBioguides(current, names, await productionBioguides(args.sourceDb));
  const senateObject = readOptionalObject<number>(args.senateEvidence);
  const probeObject = readOptionalObject<Partial<Record<'text' | 'scanned', ProbeEvidence>>>(args.probeEvidence);
  const result = buildTrackBCandidates({
    current,
    housePtrs,
    excludedBioguides: exclusions.excluded,
    senateCounts: new Map(Object.entries(senateObject)),
    probes: new Map(Object.entries(probeObject)),
  });
  writeFileSync(resolve(args.output), `${JSON.stringify({
    candidates: result.candidates,
    excluded: result.excluded,
    unresolvedNames: exclusions.unresolvedNames,
  }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
