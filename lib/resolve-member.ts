import { getLegislatorIndex, getAllAliases, normalizeName, type LegislatorIdentity } from './legislators.js';
import { getDb } from '../db/init.js';

type ResolveReject =
  | { ok: false; reason: 'unresolved' }
  | { ok: false; reason: 'ambiguous'; candidates: string[] };

export type ResolveResult =
  | { ok: true; bioguide: string; slug: string }
  | ResolveReject;

export type IdentityResult =
  | { ok: true; bioguide: string }
  | ResolveReject;

/** Pure name/bioguide → bioguide. Exact only; >1 → ambiguous; 0 → unresolved. No guessing. */
export function resolveIdentity(
  input: { name?: string; bioguide?: string },
  index: Map<string, LegislatorIdentity>,
  aliasMap: Map<string, Set<string>>,
): IdentityResult {
  if (input.bioguide && index.has(input.bioguide)) {
    return { ok: true, bioguide: input.bioguide };
  }
  if (input.name) {
    const hits = aliasMap.get(normalizeName(input.name));
    if (hits && hits.size > 1) return { ok: false, reason: 'ambiguous', candidates: [...hits] };
    if (hits && hits.size === 1) return { ok: true, bioguide: [...hits][0] };
  }
  return { ok: false, reason: 'unresolved' };
}

export function deriveSlug(full: string): string {
  return full
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const slugCache = new Map<string, string>();

async function dbSlugLookup(bioguide: string): Promise<string | undefined> {
  try {
    const conn = await getDb();
    const row = await conn.run(`SELECT member_id FROM members WHERE bioguide_id = ? LIMIT 1`, [bioguide]);
    const rows = await row.getRowObjects();
    if (rows.length > 0) return String((rows[0] as any).member_id);
  } catch { /* DB not ready — derive instead */ }
  return undefined;
}

/** Resolve a raw name/bioguide to {bioguide, slug}. Slug prefers the existing DB member_id
 *  (never rename bernie-sanders); derives first-last only for a brand-new member.
 *  `opts.index`/`opts.aliasMap` override the legislator singletons for deterministic
 *  tests (fixture in, no legislators-cache dependency); `opts.slugLookup` overrides
 *  the DB slug lookup. When either override is supplied the process-wide slugCache is
 *  bypassed so injected inputs give deterministic, contamination-free results. */
export async function resolveMember(
  raw: string | { name?: string; bioguide?: string },
  opts?: {
    index?: Map<string, LegislatorIdentity>;
    aliasMap?: Map<string, Set<string>>;
    slugLookup?: (bioguide: string) => string | undefined;
  },
): Promise<ResolveResult> {
  const input = typeof raw === 'string' ? { name: raw } : raw;
  const index = opts?.index ?? getLegislatorIndex();
  const aliasMap = opts?.aliasMap ?? getAllAliases();
  const ident = resolveIdentity(input, index, aliasMap);
  if (ident.ok === false) return ident;

  const bio = ident.bioguide;
  // Injected inputs must be deterministic across calls: skip the shared cache so
  // a prior call's slug can't leak into a fixture-driven one (and vice versa).
  const injected = !!(opts?.index || opts?.aliasMap || opts?.slugLookup);

  let slug = injected ? undefined : slugCache.get(bio);
  if (!slug) {
    slug = opts?.slugLookup ? opts.slugLookup(bio) : await dbSlugLookup(bio);
  }
  if (!slug) {
    const leg = index.get(bio)!;
    slug = deriveSlug(leg.officialFull || `${leg.first} ${leg.last}`);
  }
  if (!injected) slugCache.set(bio, slug);
  return { ok: true, bioguide: bio, slug };
}
