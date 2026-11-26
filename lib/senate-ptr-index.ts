/**
 * Senate chamber-wide PTR index: the only evidence that can establish a
 * Senate `verified-empty` result.
 *
 * Why not the name search: EFDS matches the filer's recorded first/last name
 * exactly ("Susan M", not "Susan M."), so a zero-result name query is
 * indistinguishable from a senator with no PTRs. This module instead lists
 * every PTR filed with EFDS in the window, without any name, and checks the
 * whole list for the target's surname. It is the Senate analogue of the House
 * Clerk annual index.
 *
 * Source behavior this depends on (probed 2026-11-26, frozen under
 * artifacts/2026-11-26-senate-empty-rule/probe/):
 * - `report_types=[11]` restricts results to PTRs. The bracketed
 *   `report_types[]=11` form is silently ignored, so every row's title is
 *   checked and any non-PTR row rejects the index.
 * - `recordsTotal` is the window's full count, and a page holds at most 100
 *   rows whatever `length` asks for. Paging one 516-row window returned 516
 *   distinct filings, but nothing guarantees a stable order across pages
 *   (rows sort by date, with ties). So no window is ever paged: windows are
 *   split by date until each fits in one page, and that page must hold
 *   exactly `recordsTotal` distinct filings. Each window checks itself.
 * - Paper PTRs (`/search/view/paper/<id>/`) are listed with uppercase names
 *   and office "Senator". They are filings and count as candidates.
 * - No filer-type filter is sent, so former senators' PTRs are included.
 */
import { createHash } from 'node:crypto';

export const SENATE_INDEX_SOURCE = 'https://efdsearch.senate.gov/search/report/data/';
export const SENATE_INDEX_QUERY = 'report_types=[11]; no name, state or filer-type filter';
export const SENATE_INDEX_PAGE_LIMIT = 100;

export interface SenateIndexFiling {
  filingId: string;
  kind: 'ptr' | 'paper';
  firstName: string;
  lastName: string;
  office: string;
  title: string;
  dateReceived: string; // YYYY-MM-DD
}

export interface SenateIndexWindow {
  from: string; // YYYY-MM-DD inclusive
  to: string;   // YYYY-MM-DD inclusive
  recordsTotal: number;
}

export interface SenatePtrIndex {
  schemaVersion: 1;
  kind: 'senate-ptr-chamber-index';
  sourceUrl: typeof SENATE_INDEX_SOURCE;
  query: typeof SENATE_INDEX_QUERY;
  fromYear: number;
  toYear: number;
  windows: SenateIndexWindow[];
  filingCount: number;
  sha256: string;
  filings: SenateIndexFiling[];
  fetchedAt: string;
}

/** One EFDS page for an inclusive date window, as returned by the endpoint. */
export type SenateIndexPageFetcher = (window: { from: string; to: string }) =>
  Promise<{ recordsTotal: unknown; data: unknown }>;

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function usToIso(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

/** Parse one index row. Any row that is not a recognizable PTR rejects the index. */
export function parseSenateIndexRow(row: unknown): SenateIndexFiling {
  if (!Array.isArray(row) || row.length < 5) {
    throw new Error(`malformed EFDS index row: ${JSON.stringify(row)}`);
  }
  const cells = row.map(cell => String(cell ?? ''));
  const link = cells[3].match(/\/search\/view\/(ptr|paper)\/([0-9a-f-]{36})\//i);
  const title = stripHtml(cells[3]);
  if (!link || !/^Periodic Transaction Report\b/.test(title)) {
    throw new Error(`EFDS index row is not a PTR (report filter not applied?): ${title}`);
  }
  const dateReceived = usToIso(cells[4]);
  if (!dateReceived) throw new Error(`EFDS index row has no received date: ${cells[4]}`);
  return {
    filingId: link[2].toLowerCase(),
    kind: link[1].toLowerCase() as 'ptr' | 'paper',
    firstName: stripHtml(cells[0]),
    lastName: stripHtml(cells[1]),
    office: stripHtml(cells[2]),
    title,
    dateReceived,
  };
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Collect every PTR submitted in [fromYear-01-01, toYear-12-31]. Each leaf
 * window is a single page whose distinct filings equal its recordsTotal; a
 * window over the page limit is split in half; a single day over the limit
 * cannot be listed completely and fails.
 */
export async function collectSenatePtrIndex(
  fetchPage: SenateIndexPageFetcher,
  fromYear: number,
  toYear: number,
  fetchedAt: string,
): Promise<SenatePtrIndex> {
  if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear > toYear) {
    throw new Error('invalid Senate PTR index year range');
  }
  const windows: SenateIndexWindow[] = [];
  const byId = new Map<string, SenateIndexFiling>();
  const pending: Array<{ from: string; to: string }> = [
    { from: `${fromYear}-01-01`, to: `${toYear}-12-31` },
  ];
  while (pending.length > 0) {
    const window = pending.shift()!;
    const page = await fetchPage(window);
    const total = page.recordsTotal;
    if (!Number.isInteger(total) || (total as number) < 0 || !Array.isArray(page.data)) {
      throw new Error(`malformed EFDS index page for ${window.from}..${window.to}`);
    }
    const recordsTotal = total as number;
    if (recordsTotal > SENATE_INDEX_PAGE_LIMIT) {
      const span = daysBetween(window.from, window.to);
      if (span < 1) {
        throw new Error(`EFDS lists ${recordsTotal} PTRs on ${window.from}, more than one ` +
          `page holds; the index cannot be listed completely`);
      }
      const mid = addDays(window.from, Math.floor(span / 2));
      pending.unshift({ from: window.from, to: mid }, { from: addDays(mid, 1), to: window.to });
      continue;
    }
    const filings = page.data.map(parseSenateIndexRow);
    const ids = new Set(filings.map(f => f.filingId));
    if (filings.length !== recordsTotal || ids.size !== recordsTotal) {
      throw new Error(`EFDS index window ${window.from}..${window.to} returned ` +
        `${filings.length} rows (${ids.size} distinct) for recordsTotal ${recordsTotal}`);
    }
    for (const filing of filings) {
      if (filing.dateReceived < window.from || filing.dateReceived > window.to) {
        throw new Error(`EFDS index filing ${filing.filingId} dated ${filing.dateReceived} ` +
          `is outside its window ${window.from}..${window.to}`);
      }
      if (byId.has(filing.filingId)) {
        throw new Error(`EFDS index filing ${filing.filingId} appears in two windows`);
      }
      byId.set(filing.filingId, filing);
    }
    windows.push({ ...window, recordsTotal });
  }
  const filings = [...byId.values()].sort((a, b) =>
    a.dateReceived.localeCompare(b.dateReceived) || a.filingId.localeCompare(b.filingId));
  if (filings.length === 0) {
    // Senators file PTRs every year; an empty chamber-wide index is a source failure.
    throw new Error(`EFDS chamber-wide PTR index for ${fromYear}-${toYear} is empty`);
  }
  return {
    schemaVersion: 1,
    kind: 'senate-ptr-chamber-index',
    sourceUrl: SENATE_INDEX_SOURCE,
    query: SENATE_INDEX_QUERY,
    fromYear,
    toYear,
    windows: windows.sort((a, b) => a.from.localeCompare(b.from)),
    filingCount: filings.length,
    sha256: senateIndexDigest(filings),
    filings,
    fetchedAt,
  };
}

export function senateIndexDigest(filings: SenateIndexFiling[]): string {
  const canonical = [...filings]
    .sort((a, b) => a.filingId.localeCompare(b.filingId))
    .map(f => [f.filingId, f.kind, f.firstName, f.lastName, f.office, f.title, f.dateReceived]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Validate a stored index: structure, window coverage and digest. */
export function validateSenatePtrIndex(value: unknown): SenatePtrIndex {
  const index = value as Partial<SenatePtrIndex> | null;
  if (!index || index.schemaVersion !== 1 || index.kind !== 'senate-ptr-chamber-index' ||
      index.sourceUrl !== SENATE_INDEX_SOURCE || index.query !== SENATE_INDEX_QUERY ||
      !Array.isArray(index.filings) || !Array.isArray(index.windows) ||
      !Number.isInteger(index.fromYear) || !Number.isInteger(index.toYear)) {
    throw new Error('malformed Senate PTR chamber index');
  }
  if (index.filings.length === 0 || index.filingCount !== index.filings.length) {
    throw new Error('Senate PTR chamber index filing count does not match its filings');
  }
  if (senateIndexDigest(index.filings) !== index.sha256) {
    throw new Error('Senate PTR chamber index digest does not match its filings');
  }
  const windows = [...index.windows].sort((a, b) => a.from.localeCompare(b.from));
  let expected = `${index.fromYear}-01-01`;
  let listed = 0;
  for (const w of windows) {
    if (w.from !== expected || w.to < w.from || !Number.isInteger(w.recordsTotal) ||
        w.recordsTotal > SENATE_INDEX_PAGE_LIMIT) {
      throw new Error('Senate PTR chamber index windows do not tile its year range');
    }
    listed += w.recordsTotal;
    expected = addDays(w.to, 1);
  }
  if (expected !== `${index.toYear! + 1}-01-01` || listed !== index.filingCount) {
    throw new Error('Senate PTR chamber index windows do not tile its year range');
  }
  return index as SenatePtrIndex;
}

const NAME_PARTICLES = new Set([
  'van', 'von', 'der', 'den', 'de', 'del', 'della', 'la', 'le', 'da', 'di', 'du', 'st',
  'jr', 'sr', 'ii', 'iii', 'iv', 'v',
]);

/** Lowercase ASCII surname tokens, without particles or generational suffixes. */
export function surnameTokens(name: string): string[] {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/[^a-z]+/).filter(t => t.length >= 2 && !NAME_PARTICLES.has(t));
}

/** The surname part of a filing: the last-name column plus the office text before its comma. */
function filingSurnameTokens(filing: SenateIndexFiling): Set<string> {
  const officeName = filing.office.includes(',') ? filing.office.split(',')[0] : '';
  return new Set([...surnameTokens(filing.lastName), ...surnameTokens(officeName)]);
}

/**
 * Every filing that could belong to the target: any filing sharing a surname
 * token. First names are never used to exclude a filing, because a first-name
 * mismatch is exactly what produced the C001035 false empty. Broad matching can
 * only block certification, never certify a filer away.
 */
export function findSurnameCandidates(
  index: Pick<SenatePtrIndex, 'filings'>,
  targetSurnames: string[],
): SenateIndexFiling[] {
  const target = new Set(targetSurnames);
  if (target.size === 0) throw new Error('target has no usable surname tokens');
  return index.filings.filter(filing =>
    [...filingSurnameTokens(filing)].some(token => target.has(token)));
}

/** Surname tokens for an official identity: its `last` name and the last word of its full name. */
export function identitySurnameTokens(identity: { last: string; officialFull: string }): string[] {
  const fullLast = identity.officialFull.trim().replace(/,?\s+(jr|sr|ii|iii|iv)\.?$/i, '')
    .split(/\s+/).at(-1) ?? '';
  return [...new Set([...surnameTokens(identity.last), ...surnameTokens(fullLast)])].sort();
}
