/**
 * Deterministic member identity from local unitedstates/congress-legislators YAML.
 * Source of truth for resolveMember(). Never hits the network.
 *
 * Usage:
 *   import { getLegislatorIndex, getMemberAliases } from '../lib/legislators.js';
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { LEGISLATORS_CACHE } from './paths.js';

export interface LegislatorIdentity {
  bioguide: string;
  officialFull: string;
  first: string;
  last: string;
  nickname: string | null;
  fec: string[];
  chamber: 'House' | 'Senate';
  state: string;
  district: string | null;
  termStart: string; // YYYY-MM-DD
  termEnd: string;   // YYYY-MM-DD
}

const DEFAULT_FILES = [
  join(LEGISLATORS_CACHE, 'legislators-historical.yaml'),
  join(LEGISLATORS_CACHE, 'legislators-current.yaml'),
];

/** Build a bioguide → identity index from the given YAML files, in order.
 *  Later files win on bioguide collision (pass historical before current). Pure. */
export function buildIndex(paths: string[]): Map<string, LegislatorIdentity> {
  const map = new Map<string, LegislatorIdentity>();
  for (const file of paths) {
    let data: any[];
    try { data = parseYaml(readFileSync(file, 'utf-8')) as any[]; }
    catch { continue; }  // one of current/historical may be absent
    for (const p of data ?? []) {
      const bio = p?.id?.bioguide;
      if (!bio) continue;
      const name = p.name ?? {};
      const terms: any[] = p.terms ?? [];
      const lastTerm = terms.at(-1) ?? {};
      const firstTerm = terms[0] ?? {};
      const chamber: 'House' | 'Senate' =
        String(lastTerm.type).toLowerCase().startsWith('sen') ? 'Senate' : 'House';
      map.set(bio, {
        bioguide: bio,
        officialFull: name.official_full ?? `${name.first ?? ''} ${name.last ?? ''}`.trim(),
        first: name.first ?? '',
        last: name.last ?? '',
        nickname: name.nickname ?? null,
        fec: Array.isArray(p.id?.fec) ? p.id.fec : [],
        chamber,
        state: lastTerm.state ?? '',
        district: lastTerm.district === undefined || lastTerm.district === null
          ? null : String(lastTerm.district),
        termStart: firstTerm.start ?? '',
        termEnd: lastTerm.end ?? '',
      });
    }
  }
  return map;
}

let identityIndex: Map<string, LegislatorIdentity> | null = null;
export function getLegislatorIndex(): Map<string, LegislatorIdentity> {
  if (!identityIndex) identityIndex = buildIndex(DEFAULT_FILES);
  return identityIndex;
}

/** Lowercase; commas/periods/quotes → spaces (handles "Last, First" and "F. Last");
 *  collapse whitespace; drop single-letter tokens (middle initials). */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,'"]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1)
    .join(' ')
    .trim();
}

/** All normalized alias forms for one legislator. No surname-only form (ambiguity hazard). */
export function generateAliasesFor(leg: LegislatorIdentity): string[] {
  const forms = new Set<string>();
  const add = (s: string) => { const n = normalizeName(s); if (n) forms.add(n); };
  if (leg.officialFull) add(leg.officialFull);
  if (leg.first && leg.last) { add(`${leg.first} ${leg.last}`); add(`${leg.last}, ${leg.first}`); }
  if (leg.nickname && leg.last) { add(`${leg.nickname} ${leg.last}`); add(`${leg.last}, ${leg.nickname}`); }
  return [...forms];
}

/** normalized alias → set of bioguides. A Set so collisions are detectable, not overwritten. Pure. */
export function buildAliasMap(index: Map<string, LegislatorIdentity>): Map<string, Set<string>> {
  const aliasMap = new Map<string, Set<string>>();
  for (const leg of index.values()) {
    for (const a of generateAliasesFor(leg)) {
      let set = aliasMap.get(a);
      if (!set) { set = new Set(); aliasMap.set(a, set); }
      set.add(leg.bioguide);
    }
  }
  return aliasMap;
}

let aliasCache: Map<string, Set<string>> | null = null;
export function getAllAliases(): Map<string, Set<string>> {
  if (!aliasCache) aliasCache = buildAliasMap(getLegislatorIndex());
  return aliasCache;
}
