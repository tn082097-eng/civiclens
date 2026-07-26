/**
 * Shared ingestion scope contract (Phase 1A of the member-scope repair).
 *
 * Every affected loader takes an `IngestScope` and MUST require exactly one of
 * `--member <slug|name>`, `--bioguide <id>`, or `--all`. No selector fails
 * closed (usage error) — it never silently means "all". Member mode resolves to
 * exactly one canonical member (by bioguide_id) BEFORE any network call or DB
 * mutation; unknown/ambiguous targets fail before work.
 *
 * Canonical identity is bioguide_id; slug/member_id is a projection resolved
 * from the members table. A member must already exist (loaders enrich existing
 * members — member creation is load-from-tasks, not these loaders).
 */
import { getDb } from '../db/init.js';
import {
  getLegislatorIndex, getAllAliases, type LegislatorIdentity,
} from './legislators.js';
import { resolveIdentity } from './resolve-member.js';

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

/** Parsed-but-unresolved scope (straight from argv). */
export type RawScope =
  | { kind: 'all' }
  | { kind: 'member'; selector: string; by: 'member' | 'bioguide' };

/** Resolved scope handed to loaders — a member target is fully canonical. */
export type IngestScope =
  | { kind: 'all' }
  | {
      kind: 'member';
      slug: string;
      bioguideId: string;
      memberId: string;
      chamber: 'house' | 'senate';
    };

export interface MemberRow {
  memberId: string;
  chamber: 'house' | 'senate';
}

export const SCOPE_USAGE =
  'exactly one of --member <slug|name>, --bioguide <id>, or --all is required ' +
  '(no selector is not allowed — it never means all)';

/**
 * Parse scope flags out of argv. Fails closed: zero selectors → error; both a
 * member selector and --all → error. Returns a RawScope (still needs
 * resolveScope before use). Leaves non-scope args (e.g. --dry-run, cycles) for
 * the caller's own parser.
 */
export function parseScopeArgs(argv: string[]): RawScope {
  let all = false;
  let member: string | undefined;
  let bioguide: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') {
      all = true;
    } else if (a === '--member') {
      // A repeated selector is ambiguous input — fail loud, never last-wins.
      if (member !== undefined) {
        throw new ScopeError(`--member given more than once (ambiguous target) — ${SCOPE_USAGE}`);
      }
      member = argv[++i];
      if (member === undefined || member.startsWith('--')) {
        throw new ScopeError(`--member requires a value — ${SCOPE_USAGE}`);
      }
    } else if (a === '--bioguide') {
      if (bioguide !== undefined) {
        throw new ScopeError(`--bioguide given more than once (ambiguous target) — ${SCOPE_USAGE}`);
      }
      bioguide = argv[++i];
      if (bioguide === undefined || bioguide.startsWith('--')) {
        throw new ScopeError(`--bioguide requires a value — ${SCOPE_USAGE}`);
      }
    }
  }

  const memberSelectors = [member, bioguide].filter(v => v !== undefined).length;
  if (all && memberSelectors > 0) {
    throw new ScopeError(`--all cannot be combined with --member/--bioguide — ${SCOPE_USAGE}`);
  }
  if (memberSelectors > 1) {
    throw new ScopeError(`--member and --bioguide are mutually exclusive — ${SCOPE_USAGE}`);
  }
  if (all) return { kind: 'all' };
  if (member !== undefined) return { kind: 'member', selector: member, by: 'member' };
  if (bioguide !== undefined) return { kind: 'member', selector: bioguide, by: 'bioguide' };
  throw new ScopeError(`no scope selector — ${SCOPE_USAGE}`);
}

interface ResolveDeps {
  index?: Map<string, LegislatorIdentity>;
  aliasMap?: Map<string, Set<string>>;
  /** bioguide → members-table row (undefined = not in DB). Injectable for tests. */
  memberLookup?: (bioguide: string) => MemberRow | undefined | Promise<MemberRow | undefined>;
}

/** Default DB member lookup: bioguide → { memberId, chamber } from the members table. */
async function dbMemberLookup(bioguide: string): Promise<MemberRow | undefined> {
  const conn = await getDb();
  const r = await conn.run(
    `SELECT member_id, chamber FROM members WHERE bioguide_id = ? LIMIT 1`,
    [bioguide],
  );
  const rows = (await r.getRowObjects()) as any[];
  if (rows.length === 0) return undefined;
  const chamber = String(rows[0].chamber ?? '').toLowerCase();
  return {
    memberId: String(rows[0].member_id),
    chamber: chamber === 'senate' ? 'senate' : 'house',
  };
}

/**
 * Resolve a RawScope to an IngestScope. For a member target: resolve the
 * selector to exactly one canonical bioguide (fail on unknown/ambiguous), then
 * look up its members-table row (fail loud if the member doesn't exist yet).
 * Throws ScopeError before any loader does network/DB work.
 */
export async function resolveScope(
  raw: RawScope,
  deps: ResolveDeps = {},
): Promise<IngestScope> {
  if (raw.kind === 'all') return { kind: 'all' };

  const index = deps.index ?? getLegislatorIndex();
  const aliasMap = deps.aliasMap ?? getAllAliases();
  const input = raw.by === 'bioguide' ? { bioguide: raw.selector } : { name: raw.selector };

  // Pure identity resolution (bioguide only) — no DB touch here. The canonical
  // member_id/chamber come from the injectable memberLookup below, so a member
  // target never depends on the slug cache or opens DB_PATH implicitly.
  const resolved = resolveIdentity(input, index, aliasMap);
  if (resolved.ok === false) {
    if (resolved.reason === 'ambiguous') {
      throw new ScopeError(
        `"${raw.selector}" is ambiguous — candidates: ${resolved.candidates.join(', ')}. ` +
        `Disambiguate with --bioguide <id>.`,
      );
    }
    throw new ScopeError(
      `"${raw.selector}" did not resolve to a known legislator (unresolved) — ` +
      `check the spelling or pass --bioguide <id>. Never guessing an identity.`,
    );
  }

  const lookup = deps.memberLookup ?? dbMemberLookup;
  const row = await lookup(resolved.bioguide);
  if (!row) {
    throw new ScopeError(
      `"${raw.selector}" resolved to bioguide ${resolved.bioguide} but is not in the members ` +
      `table — the member must be created first (load-from-tasks) before enrichment loaders run.`,
    );
  }

  return {
    kind: 'member',
    slug: row.memberId,
    bioguideId: resolved.bioguide,
    memberId: row.memberId,
    chamber: row.chamber,
  };
}

/** One-line human banner a loader prints before member-mode work (contract A). */
export function describeScope(scope: IngestScope, extra?: string): string {
  if (scope.kind === 'all') return `scope: ALL members${extra ? ` (${extra})` : ''}`;
  return (
    `scope: member ${scope.slug} [${scope.bioguideId}, ${scope.chamber}]` +
    `${extra ? ` (${extra})` : ''}`
  );
}
