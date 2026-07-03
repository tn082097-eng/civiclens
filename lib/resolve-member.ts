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
 *  `opts.slugLookup` overrides the DB lookup for deterministic tests. */
export async function resolveMember(
  raw: string | { name?: string; bioguide?: string },
  opts?: { slugLookup?: (bioguide: string) => string | undefined },
): Promise<ResolveResult> {
  const input = typeof raw === 'string' ? { name: raw } : raw;
  const ident = resolveIdentity(input, getLegislatorIndex(), getAllAliases());
  if (ident.ok === false) return ident;

  const bio = ident.bioguide;
  let slug = slugCache.get(bio);
  if (!slug) {
    slug = opts?.slugLookup ? opts.slugLookup(bio) : await dbSlugLookup(bio);
  }
  if (!slug) {
    const leg = getLegislatorIndex().get(bio)!;
    slug = deriveSlug(leg.officialFull || `${leg.first} ${leg.last}`);
  }
  slugCache.set(bio, slug);
  return { ok: true, bioguide: bio, slug };
}
