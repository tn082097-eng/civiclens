/**
 * Cross-check a pinned identity snapshot against the official House and Senate
 * member lists for one date. A pin's `as_of` may move to that date only when
 * the people the snapshot shows in service are exactly the people the official
 * lists show, seat for seat, and every vacancy the Clerk lists has no holder.
 *
 * Inputs:
 * - House: https://clerk.house.gov/xml/lists/MemberData.xml (one <member> per seat;
 *   a vacant seat has an empty <bioguideID>)
 * - Senate: https://www.senate.gov/general/contact_information/senators_cfm.xml
 * Pure: the caller supplies the text.
 */

interface SnapshotTerm { chamber: 'house' | 'senate'; start: string; end: string; state: string; district: number | null }
interface Snapshot { people: Array<{ bioguide: string; terms: SnapshotTerm[] }> }

/** The Clerk writes American Samoa as AQ; the snapshot uses the postal code AS. */
const CLERK_STATE_ALIASES: Record<string, string> = { AQ: 'AS' };

export interface RosterCheck {
  date: string;
  house: {
    official: number; snapshot: number; vacancies: string[];
    onlyOfficial: string[]; onlySnapshot: string[]; seatMismatch: string[]; heldVacancies: string[];
  };
  senate: { official: number; snapshot: number; onlyOfficial: string[]; onlySnapshot: string[] };
  pass: boolean;
}

function clerkSeat(raw: string): string {
  const m = raw.trim().toUpperCase().match(/^([A-Z]{2})(\d{2})$/);
  if (!m) throw new Error(`unrecognized Clerk seat: ${raw}`);
  return `${CLERK_STATE_ALIASES[m[1]] ?? m[1]}${m[2]}`;
}

function tag(block: string, name: string): string {
  return (block.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`))?.[1] ?? '').trim();
}

export function checkIdentityRoster(snapshot: Snapshot, houseXml: string, senateXml: string, date: string): RosterCheck {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid date: ${date}`);
  const serving = (chamber: 'house' | 'senate') => new Map(snapshot.people.flatMap(p => {
    const t = p.terms.find(term => term.chamber === chamber && term.start <= date && date <= term.end);
    return t ? [[p.bioguide, t] as const] : [];
  }));
  const houseSnap = serving('house');
  const senateSnap = serving('senate');

  const blocks = [...houseXml.matchAll(/<member>([\s\S]*?)<\/member>/g)].map(m => m[1]);
  if (blocks.length === 0) throw new Error('House member list has no <member> entries');
  const houseOfficial = new Map<string, string>();
  const vacancies: string[] = [];
  for (const block of blocks) {
    const seat = clerkSeat(tag(block, 'statedistrict'));
    const bioguide = tag(block, 'bioguideID');
    if (bioguide) {
      if (houseOfficial.has(bioguide)) throw new Error(`House list repeats ${bioguide}`);
      houseOfficial.set(bioguide, seat);
    } else vacancies.push(seat);
  }
  const senateIds = [...senateXml.matchAll(/<bioguide_id>\s*([^<\s]+)\s*<\/bioguide_id>/g)].map(m => m[1]);
  if (senateIds.length === 0) throw new Error('Senate list has no <bioguide_id> entries');
  const senateOfficial = new Set(senateIds);
  if (senateOfficial.size !== senateIds.length) throw new Error('Senate list repeats a senator');

  const snapSeat = (t: SnapshotTerm) => `${t.state}${String(t.district ?? 0).padStart(2, '0')}`;
  const heldSeats = new Set([...houseSnap.values()].map(snapSeat));
  const house = {
    official: houseOfficial.size,
    snapshot: houseSnap.size,
    vacancies: vacancies.sort(),
    onlyOfficial: [...houseOfficial.keys()].filter(b => !houseSnap.has(b)).sort(),
    onlySnapshot: [...houseSnap.keys()].filter(b => !houseOfficial.has(b)).sort(),
    seatMismatch: [...houseOfficial].filter(([b, seat]) => houseSnap.has(b) && snapSeat(houseSnap.get(b)!) !== seat)
      .map(([b, seat]) => `${b}: Clerk ${seat}, snapshot ${snapSeat(houseSnap.get(b)!)}`).sort(),
    heldVacancies: vacancies.filter(seat => heldSeats.has(seat)).sort(),
  };
  const senate = {
    official: senateOfficial.size,
    snapshot: senateSnap.size,
    onlyOfficial: [...senateOfficial].filter(b => !senateSnap.has(b)).sort(),
    onlySnapshot: [...senateSnap.keys()].filter(b => !senateOfficial.has(b)).sort(),
  };
  const pass = [house.onlyOfficial, house.onlySnapshot, house.seatMismatch, house.heldVacancies,
    senate.onlyOfficial, senate.onlySnapshot].every(list => list.length === 0);
  return { date, house, senate, pass };
}
