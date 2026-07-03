/**
 * CivicLens Live Researcher (v2 — Congress.gov primary, GovTrack fallback)
 *
 * Sources (in priority order):
 *   1. Congress.gov   — member identity, role, bio, sponsored bills
 *   2. OpenFEC        — donors, campaign totals
 *   3. GovTrack       — votes (Congress.gov v3 has no clean member-votes endpoint)
 *
 * Every returned record carries {source, sourceUrl} for provenance.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { resolveMember } from '../../lib/resolve-member.js';
import { LEGISLATORS_CACHE } from '../../lib/paths.js';

// ─── Env loader: read ~/.hermes/.env if keys aren't already exported ─────────
function loadEnvOnce() {
  if (process.env.CONGRESS_API_KEY && process.env.OPENFEC_API_KEY) return;
  const envPath = join(homedir(), '.hermes', '.env');
  try {
    const raw = readFileSync(envPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) continue;
      if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* file missing — keys may come from shell env */ }
}
loadEnvOnce();

const UA = 'CivicLens/1.0 (research pipeline; civiclens.org)';
const CONGRESS_KEY = process.env.CONGRESS_API_KEY ?? '';
const FEC_KEY      = process.env.OPENFEC_API_KEY ?? 'DEMO_KEY';

// ─── HTTP helper with retry/backoff ──────────────────────────────────────────
// Retries on 429, 503, or network errors. Hard 4xx (except 429) are not retried
// since retrying a 404 or 401 just wastes time. Backoff: 500ms, 1500ms, 4500ms.
async function get(url: string, timeoutMs = 15_000, maxAttempts = 3): Promise<any> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.ok) return r.json();
      const retryable = r.status === 429 || r.status === 503;
      if (!retryable || attempt === maxAttempts) {
        throw new Error(`HTTP ${r.status} ${url.split('?')[0]}`);
      }
      lastErr = new Error(`HTTP ${r.status} ${url.split('?')[0]}`);
    } catch (e: any) {
      lastErr = e;
      if (attempt === maxAttempts) break;
      // Don't retry hard HTTP errors (non-retryable status was thrown above)
      const isNetworkErr = !e.message.startsWith('HTTP ') || e.message.includes('429') || e.message.includes('503');
      if (!isNetworkErr) throw e;
    }
    await new Promise(res => setTimeout(res, 500 * Math.pow(3, attempt - 1)));
  }
  throw lastErr!;
}

function normalizeVote(raw: string): 'yea' | 'nay' | 'abstain' | 'absent' {
  const v = raw.toLowerCase();
  if (['yea', 'yes', 'aye'].includes(v)) return 'yea';
  if (['nay', 'no'].includes(v))         return 'nay';
  if (v === 'present')                   return 'abstain';
  return 'absent';
}

function normalizeBillStatus(raw: string): 'introduced' | 'passed' | 'failed' | 'signed' {
  const s = (raw ?? '').toLowerCase();
  if (s.includes('became public law') || s.includes('signed'))             return 'signed';
  if (s.includes('passed') || s.includes('agreed to'))                      return 'passed';
  if (s.includes('failed') || s.includes('vetoed') || s.includes('rejected')) return 'failed';
  return 'introduced';
}

// ─── Name aliases ────────────────────────────────────────────────────────────
// Nickname → legal first-name. Congress.gov records use legal names
// ("Charles Schumer", not "Chuck"). Looked up as a fallback in matchMemberName.
const NAME_ALIASES: Record<string, string> = {
  chuck:  'charles',
  bernie: 'bernard',
  dan:    'daniel',
  don:    'donald',
  bill:   'william',
  bob:    'robert',
  mike:   'michael',
  jim:    'james',
  joe:    'joseph',
  tom:    'thomas',
  ted:    'edward',
  liz:    'elizabeth',
};

// ─── Congress.gov (primary) ───────────────────────────────────────────────────
interface Member { bioguideId: string; name: string; state: string; party: string }
let memberCache: Member[] | null = null;

async function fetchCurrentMembers(): Promise<Member[] | null> {
  if (memberCache) return memberCache;
  if (!CONGRESS_KEY) return null;
  const collected: Member[] = [];
  // Congress.gov paginates; 250/page is the max. Loop until a short page signals
  // the end — previously capped at two pages (500), which silently dropped the
  // last ~35 current members (Congress has 535).
  for (let offset = 0; offset < 2000; offset += 250) {
    try {
      const d = await get(
        `https://api.congress.gov/v3/member?format=json&currentMember=true&limit=250&offset=${offset}&api_key=${CONGRESS_KEY}`
      );
      const members = d.members ?? [];
      for (const m of members) {
        collected.push({
          bioguideId: m.bioguideId,
          name:       m.name ?? '',        // "Last, First Middle"
          state:      m.state ?? '',
          party:      m.partyName ?? '',
        });
      }
      if (members.length < 250) break;
    } catch (e: any) {
      console.warn(`[researcher/fetch] member pagination failed at offset=${offset}; member list truncated to ${collected.length}: ${e?.message ?? e}`);
      break;
    }
  }
  memberCache = collected;
  return memberCache;
}

function matchMemberName(members: NonNullable<typeof memberCache>, name: string) {
  const parts = name.trim().toLowerCase().split(/\s+/);
  const first = parts[0];
  const joined = parts.join(' ');
  // Congress.gov returns "Last, First Middle" — compare both halves.
  // Try the given first name, then its legal-name alias if different (e.g. Chuck → Charles).
  // Last-name check uses endsWith so multi-word surnames match ("Wasserman Schultz").
  const firstCandidates = new Set([first, NAME_ALIASES[first] ?? first]);
  return members.find(m => {
    const [ln, rest] = m.name.toLowerCase().split(',').map(s => s.trim());
    if (!ln || !rest) return false;
    if (!joined.endsWith(' ' + ln)) return false;
    return firstCandidates.has(rest.split(/\s+/)[0]);
  }) ?? null;
}

async function fetchBioguideByName(name: string): Promise<string | null> {
  // First try the currentMember list
  const members = await fetchCurrentMembers();
  if (members) {
    const match = matchMemberName(members, name);
    if (match) return match.bioguideId;
  }
  // Fallback: scan all members without currentMember filter (catches members
  // whose term endYear is set but who are still serving, e.g. Marjorie Taylor Greene)
  if (!CONGRESS_KEY) return null;
  try {
    const parts = name.trim().toLowerCase().split(/\s+/);
    const last = parts[parts.length - 1];
    for (let offset = 0; offset < 3000; offset += 250) {
      const d = await get(
        `https://api.congress.gov/v3/member?format=json&limit=250&offset=${offset}&api_key=${CONGRESS_KEY}`
      );
      const batch: Member[] = (d.members ?? []).map((m: any) => ({
        bioguideId: m.bioguideId,
        name: m.name ?? '',
        state: m.state ?? '',
        party: m.partyName ?? '',
      }));
      // Quick pre-filter: skip batches with no last-name match
      const filtered = batch.filter(m => m.name.toLowerCase().includes(last));
      if (filtered.length > 0) {
        const found = matchMemberName(filtered, name);
        if (found) return found.bioguideId;
      }
      if ((d.members ?? []).length < 250) break;
    }
    return null;
  } catch { return null; }
}

interface CongressMember {
  bioguideId: string;
  party: string;
  state: string;
  chamber: 'senate' | 'house';
  role: string;
  inOffice: boolean;
  firstElectedYear: number | null;
  district: string | null;
  sourceUrl: string;
}

async function fetchCongressMember(bioguideId: string): Promise<CongressMember | null> {
  if (!CONGRESS_KEY) return null;
  try {
    const d = await get(
      `https://api.congress.gov/v3/member/${bioguideId}?format=json&api_key=${CONGRESS_KEY}`
    );
    const m = d.member;
    if (!m) return null;
    const terms = (m.terms ?? []) as Array<Record<string, unknown>>;
    const currentTerm = terms.at(-1) ?? {};
    const firstTerm   = terms[0] ?? {};
    const chamberRaw = String(currentTerm.chamber ?? '').toLowerCase();
    const chamber: 'senate' | 'house' = chamberRaw.includes('senate') ? 'senate' : 'house';
    const party  = (m.partyHistory ?? []).at(-1)?.partyName ?? currentTerm.partyName ?? 'Independent';
    // Prefer 2-letter stateCode from terms (schema requires 2 chars); fall back to top-level state name only if absent.
    const state  = String(currentTerm.stateCode ?? m.state ?? '');
    const firstStart = Number(firstTerm.startYear);
    const districtRaw = currentTerm.district;
    return {
      bioguideId,
      party:    party.startsWith('Democrat') ? 'Democrat' : party.startsWith('Republican') ? 'Republican' : 'Independent',
      state,
      chamber,
      role:     chamber === 'senate' ? 'Senator' : 'Representative',
      inOffice: !m.deathYear && !currentTerm.endYear,
      firstElectedYear: Number.isFinite(firstStart) ? firstStart : null,
      district: districtRaw != null && districtRaw !== '' ? String(districtRaw) : null,
      sourceUrl: `https://www.congress.gov/member/${bioguideId}`,
    };
  } catch { return null; }
}

interface CongressBill {
  title: string;
  summary: string;
  status: 'introduced' | 'passed' | 'failed' | 'signed';
  introducedAt: string;
  source: string;
  sourceUrl: string;
  sponsorRole: 'sponsor' | 'cosponsor';
  confidence: number;
}

async function fetchCongressSponsored(bioguideId: string, limit = 5): Promise<CongressBill[]> {
  if (!CONGRESS_KEY) return [];
  try {
    const d = await get(
      `https://api.congress.gov/v3/member/${bioguideId}/sponsored-legislation?format=json&limit=${limit}&api_key=${CONGRESS_KEY}`
    );
    const out: CongressBill[] = [];
    for (const b of d.sponsoredLegislation ?? []) {
      const congress = b.congress;
      const type     = (b.type ?? '').toLowerCase();     // "hr", "s", "hjres"
      const number   = b.number;
      if (!congress || !type || !number) continue;
      out.push({
        title:        b.title ?? `${b.type} ${number}`,
        summary:      b.title ?? '',
        status:       normalizeBillStatus(b.latestAction?.text ?? 'introduced'),
        introducedAt: (b.introducedDate ?? '').slice(0, 10),
        source:       'congress.gov',
        sourceUrl:    `https://www.congress.gov/bill/${congress}th-congress/${type === 's' ? 'senate-bill' : 'house-bill'}/${number}`,
        sponsorRole:  'sponsor',
        confidence:   0.98,
      });
    }
    return out;
  } catch { return []; }
}

// ─── Legislators index (unitedstates/congress-legislators) ───────────────────
// Canonical bioguide ↔ govtrack ↔ official-full-name mapping for all current
// members of Congress. GovTrack's own API doesn't allow filtering by bioguide,
// so this YAML is how we resolve the link. Parsed once per process.
interface LegislatorEntry {
  bioguide: string;
  govtrack: number | null;
  officialFull: string;
  fec: string[];   // FEC candidate IDs (H*/S*/P* prefix = office), authoritative
}

let legislatorsIndex: Map<string, LegislatorEntry> | null = null;

async function fetchLegislatorsIndex(): Promise<Map<string, LegislatorEntry> | null> {
  if (legislatorsIndex) return legislatorsIndex;
  const map = new Map<string, LegislatorEntry>();

  // Prefer local cache for determinism (no network). Fall back to net only if cache missing.
  const localFiles = [
    join(LEGISLATORS_CACHE || '', 'legislators-historical.yaml'),
    join(LEGISLATORS_CACHE || '', 'legislators-current.yaml'),
  ];

  let loadedFromLocal = false;
  for (const f of localFiles) {
    try {
      const text = readFileSync(f, 'utf-8');
      const data = parseYaml(text) as any[];
      for (const p of data ?? []) {
        const bio = p?.id?.bioguide;
        if (!bio) continue;
        map.set(bio, {
          bioguide: bio,
          govtrack: p.id.govtrack ?? null,
          officialFull: p.name?.official_full ?? `${p.name?.first ?? ''} ${p.name?.last ?? ''}`.trim(),
          fec: Array.isArray(p.id.fec) ? p.id.fec : [],
        });
      }
      loadedFromLocal = true;
    } catch {}
  }

  if (!loadedFromLocal) {
    // last resort network (non-deterministic but keeps old behavior)
    const sources = [
      'https://raw.githubusercontent.com/unitedstates/congress-legislators/main/legislators-historical.yaml',
      'https://raw.githubusercontent.com/unitedstates/congress-legislators/main/legislators-current.yaml',
    ];
    for (const url of sources) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60_000) });
        if (!r.ok) continue;
        const text = await r.text();
        const data = parseYaml(text) as Array<any>;
        for (const p of data ?? []) {
          const bio = p?.id?.bioguide;
          if (!bio) continue;
          map.set(bio, {
            bioguide: bio,
            govtrack: p.id.govtrack ?? null,
            officialFull: p.name?.official_full ?? `${p.name?.first ?? ''} ${p.name?.last ?? ''}`.trim(),
            fec: Array.isArray(p.id.fec) ? p.id.fec : [],
          });
        }
      } catch {}
    }
  }

  if (map.size === 0) return null;
  legislatorsIndex = map;
  return map;
}

// ─── Committees (unitedstates YAMLs + Congress.gov meetings) ─────────────────
// Committee assignments aren't on the Congress.gov member endpoint. They come
// from two YAMLs in unitedstates/congress-legislators:
//   - committees-current.yaml           (codes → display names, chambers, subcommittees)
//   - committee-membership-current.yaml (codes → [{bioguide, title}])
// Inverted once per process → bioguide → [{code, role}].
// Meetings come from Congress.gov /committee-meeting/{congress}/{chamber}.

export interface MemberCommittee {
  name: string;
  code: string;
  chamber: 'senate' | 'house' | 'joint';
  role: 'Chair' | 'Ranking Member' | 'Member';
  isSubcommittee: boolean;
  parentCode: string | null;
  sourceUrl: string;
}

export interface UpcomingMeeting {
  eventId: string;
  date: string;
  title: string;
  type: 'Hearing' | 'Markup' | 'Meeting' | 'Other';
  status: string;
  committees: Array<{ name: string; code: string }>;
  sourceUrl: string;
}

interface CommitteeMeta {
  name: string;
  chamber: 'senate' | 'house' | 'joint';
  parentCode: string | null;
  externalUrl: string;
}

let committeesCache: Map<string, CommitteeMeta> | null = null;
let membershipCache: Map<string, Array<{ code: string; role: 'Chair' | 'Ranking Member' | 'Member' }>> | null = null;

async function loadCommitteeData(): Promise<void> {
  if (committeesCache && membershipCache) return;

  // ── committees-current.yaml: codes → metadata ──
  const cMap = new Map<string, CommitteeMeta>();
  try {
    const r = await fetch(
      'https://raw.githubusercontent.com/unitedstates/congress-legislators/main/committees-current.yaml',
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60_000) }
    );
    if (r.ok) {
      const data = parseYaml(await r.text()) as Array<any>;
      for (const c of data ?? []) {
        const code = String(c.thomas_id ?? '');
        if (!code) continue;
        const chamber: CommitteeMeta['chamber'] =
          c.type === 'senate' ? 'senate' : c.type === 'house' ? 'house' : 'joint';
        cMap.set(code, {
          name: c.name ?? code,
          chamber,
          parentCode: null,
          externalUrl: c.url ?? '',
        });
        for (const sub of c.subcommittees ?? []) {
          const subCode = code + String(sub.thomas_id ?? '');
          cMap.set(subCode, {
            name: `${c.name} — ${sub.name}`,
            chamber,
            parentCode: code,
            externalUrl: c.url ?? '',
          });
        }
      }
    }
  } catch { /* cMap stays empty */ }
  committeesCache = cMap;

  // ── committee-membership-current.yaml: bioguide → [{code, role}] ──
  const mMap = new Map<string, Array<{ code: string; role: 'Chair' | 'Ranking Member' | 'Member' }>>();
  try {
    const r = await fetch(
      'https://raw.githubusercontent.com/unitedstates/congress-legislators/main/committee-membership-current.yaml',
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60_000) }
    );
    if (r.ok) {
      const data = parseYaml(await r.text()) as Record<string, Array<any>>;
      for (const [code, members] of Object.entries(data ?? {})) {
        for (const m of members ?? []) {
          const bio = m.bioguide as string;
          if (!bio) continue;
          const t = String(m.title ?? '');
          const role: 'Chair' | 'Ranking Member' | 'Member' =
            /chair/i.test(t)   ? 'Chair' :
            /ranking/i.test(t) ? 'Ranking Member' :
            'Member';
          const arr = mMap.get(bio) ?? [];
          arr.push({ code, role });
          mMap.set(bio, arr);
        }
      }
    }
  } catch { /* mMap stays empty */ }
  membershipCache = mMap;
}

async function fetchMemberCommittees(bioguideId: string): Promise<MemberCommittee[]> {
  await loadCommitteeData();
  if (!membershipCache || !committeesCache) return [];
  const entries = membershipCache.get(bioguideId);
  if (!entries) return [];
  const out: MemberCommittee[] = [];
  for (const { code, role } of entries) {
    const meta = committeesCache.get(code);
    if (!meta) continue;  // unresolvable code (e.g., dissolved subcommittee) — skip silently
    out.push({
      name: meta.name,
      code,
      chamber: meta.chamber,
      role,
      isSubcommittee: meta.parentCode !== null,
      parentCode: meta.parentCode,
      sourceUrl: meta.externalUrl || `https://www.congress.gov/committees`,
    });
  }
  return out;
}

// Chamber-keyed cache of hydrated meetings (list + detail for each). Populated
// once per process — the detail fetch is the expensive step (~30 calls).
let chamberMeetingsCache: Map<'senate' | 'house', UpcomingMeeting[]> | null = null;

async function fetchChamberMeetings(chamber: 'senate' | 'house'): Promise<UpcomingMeeting[]> {
  if (!CONGRESS_KEY) return [];
  if (!chamberMeetingsCache) chamberMeetingsCache = new Map();
  const hit = chamberMeetingsCache.get(chamber);
  if (hit) return hit;

  const out: UpcomingMeeting[] = [];
  const congress = currentCongressNumber();
  try {
    const list = await get(
      `https://api.congress.gov/v3/committee-meeting/${congress}/${chamber}?format=json&limit=50&api_key=${CONGRESS_KEY}`
    );
    // Cap detail fetches to the 30 most recently updated — these are the
    // meetings actually worth surfacing (upcoming or just scheduled).
    const events = (list.committeeMeetings ?? []).slice(0, 30);

    const details = await Promise.all(events.map(async (evt: any) => {
      try {
        const d = await get(
          `https://api.congress.gov/v3/committee-meeting/${congress}/${chamber}/${evt.eventId}?format=json&api_key=${CONGRESS_KEY}`
        );
        return d.committeeMeeting ?? null;
      } catch { return null; }
    }));

    for (const m of details) {
      if (!m) continue;
      const title = String(m.title ?? '');
      const type: UpcomingMeeting['type'] =
        /markup/i.test(title)    ? 'Markup' :
        /hearing/i.test(title)   ? 'Hearing' :
        m.type === 'Meeting'     ? 'Meeting' :
        'Other';
      out.push({
        eventId:   String(m.eventId ?? ''),
        date:      String(m.date ?? '').slice(0, 10),
        title,
        type,
        status:    String(m.meetingStatus ?? 'Unknown'),
        committees: (m.committees ?? []).map((c: any) => ({
          name: String(c.name ?? ''),
          code: String(c.systemCode ?? ''),
        })),
        sourceUrl: `https://www.congress.gov/event/${ordinal(congress)}-Congress/${chamber}-event/${m.eventId}`,
      });
    }
  } catch { /* out stays empty */ }

  chamberMeetingsCache.set(chamber, out);
  return out;
}

async function fetchUpcomingMeetings(memberCommittees: MemberCommittee[]): Promise<UpcomingMeeting[]> {
  if (memberCommittees.length === 0) return [];
  // YAML codes are uppercase (SSFR09); Congress.gov meeting systemCodes are
  // lowercase (ssfr09). Match on lowercase both sides.
  const memberCodes = new Set(memberCommittees.map(c => c.code.toLowerCase()));
  const chambers = new Set<'senate' | 'house'>();
  for (const c of memberCommittees) {
    if (c.chamber === 'senate' || c.chamber === 'joint') chambers.add('senate');
    if (c.chamber === 'house'  || c.chamber === 'joint') chambers.add('house');
  }
  const seen = new Set<string>();
  const out: UpcomingMeeting[] = [];
  for (const ch of chambers) {
    for (const m of await fetchChamberMeetings(ch)) {
      if (seen.has(m.eventId)) continue;  // joint events can list in both chambers
      if (!m.committees.some(mc => memberCodes.has(mc.code.toLowerCase()))) continue;
      seen.add(m.eventId);
      out.push(m);
    }
  }
  // Chronological: upcoming first
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchGovTrackVotes(
  personId: number,
  limit = 8,
  minDateISO?: string,
): Promise<any[]> {
  // GovTrack's vote_voter offset is hard-capped at 1000 ("Offset > 1000 is
  // not permitted") — purely offset-based pagination tops out at ~1100 votes
  // per member, missing the older window we need for multi-year PFD coverage.
  //
  // Workaround: cursor by `created__lt`. Each page asks for the next 100
  // votes older than the oldest seen so far. Naturally bounded by minDateISO
  // (stop once oldest seen predates the cutoff). Per-call timeout fits the
  // ~14s curve at limit=100.
  const PAGE = 100;
  const out: any[] = [];
  let cursor: string | null = null;
  while (out.length < limit) {
    const want = Math.min(PAGE, limit - out.length);
    const cursorParam = cursor ? `&created__lt=${encodeURIComponent(cursor)}` : '';
    try {
      const d = await get(
        `https://www.govtrack.us/api/v2/vote_voter?person=${personId}&limit=${want}&sort=-created${cursorParam}`,
        25_000
      );
      const objs = d.objects ?? [];
      if (objs.length === 0) break; // nothing left to fetch
      out.push(...objs);
      // Cursor = `created` timestamp of the oldest item in this page (used as
      // exclusive upper bound for the next page).
      const oldest = objs[objs.length - 1];
      const oldestRaw = String(oldest?.created ?? oldest?.vote?.created ?? '');
      if (!oldestRaw) break; // can't advance the cursor
      cursor = oldestRaw;
      if (objs.length < want) break; // truly ran out
      if (minDateISO) {
        const oldestDate = oldestRaw.slice(0, 10);
        if (oldestDate && oldestDate < minDateISO) break;
      }
    } catch (e: any) {
      console.warn(`[researcher/fetch] cursor pagination failed at cursor=${cursor}; result truncated to ${out.length}: ${e?.message ?? e}`);
      break;
    }
  }
  return out;
}

// ─── OpenFEC (donors) ────────────────────────────────────────────────────────
// FEC cycles end on even years. For 2026 → cycle 2026 (covers 2025-01 → 2026-12).
// Hardcoded "2024" was missing the entire current election cycle.
function currentFecCycle(): number {
  const y = new Date().getFullYear();
  return y % 2 === 0 ? y : y + 1;
}

// Failure reason captured on the last call for diagnostics. Cleared per fetchPolitician run.
let fecLastError: string | null = null;

async function fecGet(url: string, timeoutMs = 30_000): Promise<any> {
  // FEC schedule_a calls can be slow — longer timeout, same retry policy as get().
  return get(url, timeoutMs);
}

async function findFecCandidateId(name: string, office: string, state: string): Promise<string | null> {
  const officeCode = { executive: 'P', senate: 'S', house: 'H', cabinet: 'P', governor: '', state: '' }[office] ?? '';
  if (!officeCode) { fecLastError = `unsupported office: ${office}`; return null; }
  // FEC filers often use nicknames ("HIMES, JIM"), so a full legal name can
  // miss. Try the full name, then last name only (office+state filters keep
  // the surname query precise).
  const lastName = name.trim().split(/\s+/).at(-1) ?? name;
  for (const q of [name, ...(lastName !== name ? [lastName] : [])]) {
    try {
      const d = await fecGet(
        `https://api.open.fec.gov/v1/candidates/search/?q=${encodeURIComponent(q)}` +
        `&api_key=${FEC_KEY}&office=${officeCode}${state !== 'US' && officeCode !== 'P' ? `&state=${state}` : ''}&per_page=5`
      );
      const sorted = (d.results ?? []).sort((a: any, b: any) => (b.active_through ?? 0) - (a.active_through ?? 0));
      const id = sorted[0]?.candidate_id ?? null;
      if (id) return id;
      fecLastError = `no FEC candidate found for ${name} (${officeCode}/${state})`;
    } catch (e: any) { fecLastError = `candidate search: ${e.message}`; return null; }
  }
  return null;
}

async function findFecCommitteeId(candidateId: string, cycle: number): Promise<string | null> {
  // No designation filter — some candidates (e.g. MTG) only have designation=D
  // (Delegate), not designation=P. Rank P > D > others and take the best match.
  try {
    const d = await fecGet(
      `https://api.open.fec.gov/v1/candidate/${candidateId}/committees/?api_key=${FEC_KEY}&cycle=${cycle}&per_page=10`
    );
    const results: any[] = d.results ?? [];
    const rank = (r: any) => r.designation === 'P' ? 0 : r.designation === 'D' ? 1 : 2;
    const sorted = results.sort((a, b) => rank(a) - rank(b));
    const id = sorted[0]?.committee_id ?? null;
    if (!id) fecLastError = `no committee for candidate ${candidateId}`;
    return id;
  } catch (e: any) { fecLastError = `committee lookup: ${e.message}`; return null; }
}

// Conduit PACs aggregate contributions from many individuals and redistribute
// them. They appear as top donors to nearly every politician of the matching
// party (WinRed→R, ActBlue→D) or to every member of a joint fundraising
// committee (JFCs almost always contain "victory" in the name). Leaving them
// in the donors array creates false matches in the Connection Mapper — every
// Republican "shares" WinRed, every member of a JFC "shares" its victory fund.
const CONDUIT_PATTERNS: RegExp[] = [
  /^WINRED\b/i,    // WinRed + LLC variants (WINRED TECHNICAL SERVICES, etc.)
  /^ACTBLUE\b/i,   // ActBlue + ActBlue Civics
  /\bVICTORY\b/i,  // Joint fundraising committees: "<X> Victory Fund/Committee"
];

function isConduit(contributorName: string): boolean {
  return CONDUIT_PATTERNS.some(p => p.test(contributorName));
}

async function fetchFecDonors(committeeId: string, cycle: number, limit = 100): Promise<any[]> {
  // No contributor_type filter — "organization" was invalid and silently dropped
  // all results. OpenFEC only accepts "individual" | "committee". Pull raw and
  // classify client-side in fetchPolitician via entity_type_desc.
  try {
    const d = await fecGet(
      `https://api.open.fec.gov/v1/schedules/schedule_a/?committee_id=${committeeId}` +
      `&api_key=${FEC_KEY}&two_year_transaction_period=${cycle}&per_page=${limit}` +
      `&sort=-contribution_receipt_amount`
    );
    const rows = (d.results ?? []).filter((r: any) => r.contribution_receipt_amount > 0);
    if (rows.length === 0) fecLastError = `schedule_a returned no rows for committee ${committeeId}`;
    return rows;
  } catch (e: any) { fecLastError = `schedule_a: ${e.message}`; return []; }
}

// ─── Bio (Congress.gov — deterministic, primary-source) ─────────────────────
// Wikipedia is tertiary and leaks editorial voice (e.g. "conspiracy theorist")
// past the Summarizer. We construct a factual sentence from Congress.gov data
// we already fetched. No scraped prose, no narrative — just role, state,
// district (for House), party, first-elected year, and current Congress.
function currentCongressNumber(year = new Date().getUTCFullYear()): number {
  return Math.floor((year - 1789) / 2) + 1;
}

function buildCongressBio(member: CongressMember): { bio: string; sourceUrl: string } {
  const congressN = currentCongressNumber();
  const ord = ordinal(congressN);
  const districtPart =
    member.chamber === 'house' && member.district
      ? `${member.state}-${member.district}`
      : member.state;
  const elected = member.firstElectedYear
    ? `, in Congress since ${member.firstElectedYear}`
    : '';
  const tense = member.inOffice ? 'currently serving' : 'most recently served';
  const bio =
    `${member.role} from ${districtPart} (${member.party})${elected}, ` +
    `${tense} in the ${ord} Congress. Source: congress.gov/member/${member.bioguideId}.`;
  return { bio, sourceUrl: member.sourceUrl };
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suf = ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suf}`;
}

// ─── Main export ─────────────────────────────────────────────────────────────
export interface LiveFetchResult {
  source: 'congress.gov' | 'govtrack';
  fetchedAt: string;
  warnings: string[];
  bioguideId: string | null;
  resolvedSlug: string;
  govtrackId: number | null;
  bio: string;
  bioSourceUrl: string;
  party: string;
  state: string;
  chamber: string;
  role: string;
  inOffice: boolean;
  bills: Array<{ title: string; summary: string; status: string; introducedAt: string; source: string; sourceUrl: string; confidence: number }>;
  votes: Array<{ billTitle: string; vote: string; date: string; source: string; sourceUrl: string; confidence: number }>;
  donors: Array<{ name: string; type: string; amount: number; date: string; source: string; sourceUrl: string; confidence: number }>;
  committees: MemberCommittee[];
  upcomingMeetings: UpcomingMeeting[];
}

export async function fetchPolitician(name: string): Promise<LiveFetchResult | null> {
  const warnings: string[] = [];

  // ── 1. Identity: deterministic from local YAML (bioguide is truth) ──
  const resolved = await resolveMember(name);
  if (resolved.ok === false) {
    if (resolved.reason === 'ambiguous') {
      warnings.push(`Identity ambiguous for "${name}": candidates=${resolved.candidates?.join(',')}`);
    } else {
      warnings.push(`No deterministic identity for "${name}" (unresolved)`);
    }
    return null;  // fail loud — no inference, no stubs
  }
  const bioguideId = resolved.bioguide;
  const resolvedSlug = resolved.slug;

  // ── 2. Member details ──
  const member = await fetchCongressMember(bioguideId);
  if (!member) {
    warnings.push(`Congress.gov: member lookup failed for ${bioguideId}`);
    return null;
  }

  const { role, party, state, chamber, inOffice } = member;

  // ── 2b. Canonical name + GovTrack ID via legislators index ──
  // Using the official full name for downstream FEC/Wikipedia lookups avoids
  // nickname-miss bugs (e.g., "Chuck Schumer" → FEC returns nothing).
  const legIndex = await fetchLegislatorsIndex();
  const leg = legIndex?.get(bioguideId) ?? null;
  const canonicalName = leg?.officialFull ?? name;
  if (!leg) warnings.push(`legislators-current: no entry for ${bioguideId}`);

  // ── 3. Bio (Congress.gov — deterministic, primary-source only) ──
  const { bio, sourceUrl: bioSourceUrl } = buildCongressBio(member);

  // ── 4. Bills: Congress.gov ──
  // Pull 250 (API max per request) — covers a full Congress of sponsorships
  // for most members. Shallow 5-bill sample can't support cross-referencing.
  const bills = await fetchCongressSponsored(bioguideId, 250);
  if (bills.length === 0) warnings.push(`Congress.gov: no sponsored bills for ${bioguideId}`);

  // ── 4b. Committees (unitedstates YAML) + upcoming meetings (Congress.gov) ──
  // Committee assignments come from a cross-referenced YAML, not a Congress.gov
  // endpoint — the member detail API doesn't expose them. Meetings are filtered
  // to this member's committees (full + subcommittees).
  const committees = await fetchMemberCommittees(bioguideId);
  if (committees.length === 0) {
    warnings.push(`committee-membership: no committee assignments for ${bioguideId}`);
  }
  const upcomingMeetings = await fetchUpcomingMeetings(committees);

  // ── 5. Votes: GovTrack (Congress.gov v3 has no first-class member-votes) ──
  // Pull up to ~2000, keep up to 1500. 48-month lookback via minDateISO bounds
  // wall-time on high-frequency voters. Wide enough that *current* PFD filings
  // covering 2022+ transactions (the multi-year corpus) still find votes in
  // their trade-date window.
  let votes: LiveFetchResult['votes'] = [];
  const govtrackId = leg?.govtrack ?? null;
  if (govtrackId) {
    const minDateISO = new Date(Date.now() - 48 * 30 * 24 * 3600 * 1000)
      .toISOString().slice(0, 10);
    // Bumped fetch cap so a House member with ~25 votes/week reaches the
    // full 48-month window before the cap fires. minDateISO is the real
    // bound; the cap is a safety net.
    const raw = await fetchGovTrackVotes(govtrackId, 4000, minDateISO);
    votes = raw
      .filter((v: any) => v.vote?.question)
      .map((v: any) => ({
        billTitle: v.vote.question?.replace(/^H\.R\.\s*\d+[^:]*:\s*/i, '')
                                   .replace(/^S\.\s*\d+[^:]*:\s*/i, '')
                                   .trim() ?? 'Unknown Vote',
        vote:      normalizeVote(v.option?.value ?? 'absent'),
        date:      (v.created ?? v.vote?.created ?? '').slice(0, 10),
        source:    'govtrack.us',
        sourceUrl: v.vote?.link
          ? (v.vote.link.startsWith('http') ? v.vote.link : `https://www.govtrack.us${v.vote.link}`)
          : 'https://www.govtrack.us',
        confidence: 0.99,
      }))
      .filter((v: any) => v.date && v.date <= new Date().toISOString().split('T')[0])
      .slice(0, 3500);
  }
  if (votes.length === 0) warnings.push(`votes: no live vote data for "${canonicalName}"`);

  // ── 6. Donors: OpenFEC (multi-cycle union) ──
  // Single-cycle pulls miss recurring donors who maxed in earlier cycles —
  // exactly the pattern the Connection Mapper needs to surface. Union the
  // last 4 cycles (current + 3 prior, ~8 years) and sum per donor.
  // `amount` therefore means *cumulative giving across 4 cycles*, not a
  // single contribution. `date` is the most recent contribution date seen.
  fecLastError = null;
  let donors: LiveFetchResult['donors'] = [];
  const currentCycle = currentFecCycle();
  const cyclesToPull = [currentCycle, currentCycle - 2, currentCycle - 4, currentCycle - 6];
  // Prefer the authoritative FEC ID from legislators-current (id.fec) — FEC's
  // name search misses nickname filers ("HIMES, JIM" vs "James A. Himes").
  // Prefix encodes office (H/S/P); pick the newest ID matching this chamber.
  const officePrefix = chamber === 'senate' ? 'S' : 'H';
  const yamlFecId = (leg?.fec ?? []).filter(id => id.startsWith(officePrefix)).at(-1) ?? null;
  const fecCandidateId = yamlFecId ?? await findFecCandidateId(canonicalName, chamber, state);
  if (fecCandidateId) {
    type DonorAgg = {
      amount: number;
      type: string;
      latestDate: string;
      cycles: Set<number>;
      canonical: string;
    };
    const donorMap = new Map<string, DonorAgg>();
    let lastFecUrl: string | null = null;

    for (const cycle of cyclesToPull) {
      const fecCommitteeId = await findFecCommitteeId(fecCandidateId, cycle);
      if (!fecCommitteeId) continue; // candidate didn't run that cycle — skip silently
      lastFecUrl = `https://www.fec.gov/data/committee/${fecCommitteeId}/`;
      const rawDonors = await fetchFecDonors(fecCommitteeId, cycle, 100);
      for (const d of rawDonors) {
        const rawName = d.contributor_name ?? 'Unknown';
        if (isConduit(rawName)) continue;
        const amt = d.contribution_receipt_amount ?? 0;
        if (amt <= 0) continue;
        const key = rawName.toUpperCase();
        const date = d.contribution_receipt_date?.slice(0, 10) ?? '';
        const type =
          d.entity_type_desc === 'INDIVIDUAL' ? 'individual'
          : d.entity_type_desc?.includes('COMMITTEE') ? 'pac'
          : 'corporation';
        const existing = donorMap.get(key);
        if (existing) {
          existing.amount += amt;
          existing.cycles.add(cycle);
          if (date && date > existing.latestDate) existing.latestDate = date;
          // PAC/corp classification beats individual when the same name shows up both ways
          if (type !== 'individual' && existing.type === 'individual') existing.type = type;
        } else {
          donorMap.set(key, {
            amount: amt,
            type,
            latestDate: date || '2024-01-01',
            cycles: new Set([cycle]),
            canonical: rawName,
          });
        }
      }
    }

    if (lastFecUrl) {
      donors = [...donorMap.values()]
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 100)
        .map(d => ({
          name: d.canonical.split(',').map(w => w.trim().charAt(0).toUpperCase() + w.trim().slice(1).toLowerCase()).join(', '),
          type: d.type,
          amount: d.amount,
          date: d.latestDate,
          source: 'fec.gov',
          sourceUrl: lastFecUrl,
          confidence: 0.96,
        }));
    }

    // No lump-sum fallback. An aggregate total is not a donor — injecting it
    // into the donors array creates false matches in cross-reference (both
    // politicians end up with identically-labeled "Total campaign receipts"
    // rows that the Mapper treats as a shared donor).
  }
  if (donors.length === 0) {
    warnings.push(`OpenFEC: no donor data for "${canonicalName}"${fecLastError ? ` — ${fecLastError}` : ''}`);
  }

  return {
    source: 'congress.gov',
    fetchedAt: new Date().toISOString(),
    warnings,
    bioguideId,
    resolvedSlug,
    govtrackId,
    bio,
    bioSourceUrl,
    party,
    state,
    chamber,
    role,
    inOffice,
    bills,
    votes,
    donors,
    committees,
    upcomingMeetings,
  };
}
