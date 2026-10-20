/**
 * Official vote acquisition contract — core type definitions and classifiers.
 *
 * Pure functions, no I/O. Per official-votes-contract-2026-10-08, this module
 * defines canonical identity, coverage windows, position normalization, and
 * roll resolution (bill classification).
 */

// ─── Error class ──────────────────────────────────────────────────────────

export class VoteSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoteSourceError';
  }
}

// ─── Validators ───────────────────────────────────────────────────────────

/**
 * Validate a value is a positive safe integer (not 0, negative, fraction, NaN, Infinity).
 * Throws VoteSourceError if invalid.
 */
function validatePositiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value <= 0 || !Number.isSafeInteger(value)) {
    throw new VoteSourceError(
      `${name} must be a positive safe integer, got ${typeof value === 'number' ? value : typeof value}`
    );
  }
  return value;
}

// ─── Contract constants ────────────────────────────────────────────────────

export const VOTE_ACQUISITION_CONTRACT = 'civiclens.official-vote-acquisition';
export const VOTE_ACQUISITION_CONTRACT_VERSION = 1;
export const COVERAGE_MONTHS = 48;
export const FROZEN_EVIDENCE_WINDOW = {
  asOf: '2026-09-26',
  start: '2022-09-26',
  end: '2026-09-26',
  months: 48,
} as const;

// ─── Section 1: Canonical identity ────────────────────────────────────────

export type Chamber = 'house' | 'senate';

export interface RollIdentity {
  chamber: Chamber;
  congress: number;
  session: 1 | 2;
  roll: number;
}

/** Canonical roll key format: "{congress}-{sessionYear}/{chamber_letter}{roll}" */
export function sessionYear(congress: number, session: number): number {
  validatePositiveSafeInteger(congress, 'congress');
  if (session !== 1 && session !== 2) {
    throw new VoteSourceError('session must be 1 or 2');
  }
  return 1787 + 2 * congress + session - 1;
}

export function rollKey(id: RollIdentity): string {
  if (id.chamber !== 'house' && id.chamber !== 'senate') {
    throw new VoteSourceError(`chamber must be "house" or "senate", got ${JSON.stringify(id.chamber)}`);
  }
  validatePositiveSafeInteger(id.congress, 'congress');
  validatePositiveSafeInteger(id.roll, 'roll');
  const year = sessionYear(id.congress, id.session);
  const chamber = id.chamber === 'house' ? 'h' : 's';
  return `${id.congress}-${year}/${chamber}${id.roll}`;
}

/** Parse roll key with strict validation: no leading zeros, consistent year. */
export function parseRollKey(key: string): RollIdentity & { year: number } {
  const match = key.match(/^(\d+)-(\d+)\/(h|s)(\d+)$/);
  if (!match) {
    throw new VoteSourceError(`Invalid roll key format: "${key}" (strict parsing)`);
  }

  const congress = parseInt(match[1], 10);
  const year = parseInt(match[2], 10);
  const chamber = match[3] === 'h' ? 'house' : 'senate';
  const roll = parseInt(match[4], 10);

  // No leading zeros on roll
  if (match[4] !== roll.toString()) {
    throw new VoteSourceError(`Roll number has leading zeros (strict): "${match[4]}"`);
  }

  // Validate roll is positive
  if (roll <= 0) {
    throw new VoteSourceError(`Roll must be positive, got ${roll}`);
  }

  // Verify year matches congress + session calculation
  const expected1 = sessionYear(congress, 1);
  const expected2 = sessionYear(congress, 2);
  let session: 1 | 2;
  if (year === expected1) {
    session = 1;
  } else if (year === expected2) {
    session = 2;
  } else {
    throw new VoteSourceError(
      `Inconsistent year for congress ${congress}: got ${year}, ` +
      `expected ${expected1} (session 1) or ${expected2} (session 2)`
    );
  }

  return { chamber, congress, session, roll, year };
}

export function houseSourceUrl(year: number, roll: number): string {
  validatePositiveSafeInteger(roll, 'roll');
  const rollStr = roll >= 1000 ? roll.toString() : roll.toString().padStart(3, '0');
  return `https://clerk.house.gov/evs/${year}/roll${rollStr}.xml`;
}

export function senateSourceUrl(congress: number, session: 1 | 2, roll: number): string {
  validatePositiveSafeInteger(congress, 'congress');
  validatePositiveSafeInteger(roll, 'roll');
  const congSession = `${congress}${session}`;
  const rollStr = roll.toString().padStart(5, '0');
  return `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congSession}/vote_${congress}_${session}_${rollStr}.xml`;
}

// ─── Section 2: Roll identity checking ────────────────────────────────────

export interface ObservedRoll {
  chamber: Chamber;
  congress: number;
  session: number;
  roll: number;
  date: string;
}

export function checkRollIdentity(
  expected: ObservedRoll,
  observed: ObservedRoll
): { ok: true } | { ok: false; mismatches: string[] } {
  const mismatches: string[] = [];

  if (expected.chamber !== observed.chamber) mismatches.push('chamber');
  if (expected.congress !== observed.congress) mismatches.push('congress');
  if (expected.session !== observed.session) mismatches.push('session');
  if (expected.roll !== observed.roll) mismatches.push('roll');
  if (expected.date !== observed.date) mismatches.push('date');

  if (mismatches.length > 0) {
    return { ok: false, mismatches };
  }
  return { ok: true };
}

// ─── Section 3: Date handling and coverage window ──────────────────────────

/**
 * Validate ISO date (YYYY-MM-DD) and verify it's a real calendar date.
 * Uses Date.UTC to validate and round-trip compares.
 */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);

  // Validate ranges
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  // Use Date.UTC to validate the date is real, then round-trip
  const d = new Date(Date.UTC(year, month - 1, day));
  const isoBack = d.toISOString().substring(0, 10);
  return isoBack === value;
}

/**
 * Subtract calendar months with end-of-month clamping (not day arithmetic).
 * E.g., 2026-03-31 − 1 → 2026-02-28 (last day of Feb).
 */
export function subtractCalendarMonths(isoDate: string, months: number): string {
  if (!isIsoDate(isoDate)) {
    throw new VoteSourceError(`Invalid ISO date: "${isoDate}"`);
  }
  if (!Number.isSafeInteger(months) || months < 0) {
    throw new VoteSourceError(
      `months must be a non-negative safe integer, got ${String(months)}`
    );
  }

  const [yearStr, monthStr, dayStr] = isoDate.split('-');
  const year0 = parseInt(yearStr, 10);
  const month0 = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);

  // Closed-form month arithmetic (no loop): index months from year 0, subtract, split.
  const total = year0 * 12 + (month0 - 1) - months;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;

  // Supported range: 100..9999 (Date.UTC maps years 0-99 to 1900s; ISO is 4-digit).
  if (year < 100 || year > 9999) {
    throw new VoteSourceError(`Target year out of supported range: ${year}`);
  }

  // Clamp day to last day of target month
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const finalDay = Math.min(day, lastDay);

  // Validate by round-trip
  const d = new Date(Date.UTC(year, month - 1, finalDay));
  const result = d.toISOString().substring(0, 10);

  if (!isIsoDate(result)) {
    throw new VoteSourceError(`Invalid date result: "${result}"`);
  }

  return result;
}

export interface CoverageWindow {
  asOf: string;
  start: string;
  end: string;
  months: number;
}

export function coverageWindow(asOf: string, months: number = 48): CoverageWindow {
  if (!isIsoDate(asOf)) {
    throw new VoteSourceError(`Invalid ISO date: "${asOf}"`);
  }
  const start = subtractCalendarMonths(asOf, months);
  return {
    asOf,
    start,
    end: asOf,
    months,
  };
}

export function inWindow(
  date: string,
  window: { start: string; end: string }
): boolean {
  if (!isIsoDate(date)) {
    throw new VoteSourceError(`Invalid ISO date: "${date}"`);
  }
  if (!isIsoDate(window.start)) {
    throw new VoteSourceError(`Invalid window start: "${String(window.start)}"`);
  }
  if (!isIsoDate(window.end)) {
    throw new VoteSourceError(`Invalid window end: "${String(window.end)}"`);
  }
  if (window.start > window.end) {
    throw new VoteSourceError(`Window start "${window.start}" is after end "${window.end}"`);
  }
  // String comparison works for ISO dates (YYYY-MM-DD)
  return date >= window.start && date <= window.end;
}

// ─── Section 4: Position normalization ────────────────────────────────────

export type NormalizedPosition = 'yea' | 'nay' | 'abstain' | 'absent' | 'other';
export type PositionContext = 'standard' | 'election';

export type PositionResult =
  | { ok: true; position: NormalizedPosition; rawPosition: string }
  | { ok: false; outcome: 'unsupported_record'; rawPosition: string; reason: string };

/**
 * Normalize position with raw text preserved verbatim as rawPosition.
 * Matching uses trimmed raw string, case-sensitive.
 */
export function normalizePosition(raw: string, context: PositionContext): PositionResult {
  const trimmed = raw.trim();

  // Standard positions (always valid regardless of context)
  if (trimmed === 'Yea' || trimmed === 'Aye') {
    return { ok: true, position: 'yea', rawPosition: raw };
  }
  if (trimmed === 'Nay' || trimmed === 'No') {
    return { ok: true, position: 'nay', rawPosition: raw };
  }
  if (trimmed === 'Present') {
    return { ok: true, position: 'abstain', rawPosition: raw };
  }
  if (trimmed === 'Not Voting') {
    return { ok: true, position: 'absent', rawPosition: raw };
  }

  // Special positions that map to 'other'
  if (
    trimmed === 'Guilty' ||
    trimmed === 'Not Guilty' ||
    trimmed === 'Present, Giving Live Pair'
  ) {
    return { ok: true, position: 'other', rawPosition: raw };
  }

  // Empty string
  if (trimmed === '') {
    return {
      ok: false,
      outcome: 'unsupported_record',
      rawPosition: raw,
      reason: 'empty position',
    };
  }

  // Any other non-empty token in election context is 'other' (candidate name)
  if (context === 'election') {
    return { ok: true, position: 'other', rawPosition: raw };
  }

  // Any other token in standard context is unsupported
  return {
    ok: false,
    outcome: 'unsupported_record',
    rawPosition: raw,
    reason: `unrecognized position: "${trimmed}"`,
  };
}

// ─── Section 5: Member participation ──────────────────────────────────────

export type Participation =
  | { status: 'recorded'; position: NormalizedPosition; rawPosition: string }
  | { status: 'unsupported_position'; rawPosition: string; reason: string }
  | { status: 'ambiguity'; reason: string }
  | { status: 'not_recorded'; reason: string };

/**
 * Find a member's position in a roll. Returns not_recorded if absent (never absent),
 * ambiguity if duplicate rows, unsupported_position if invalid position.
 */
export function memberParticipation(
  rows: ReadonlyArray<{ memberId: string; rawPosition: string }>,
  memberId: string,
  context: PositionContext
): Participation {
  const memberRows = rows.filter((row) => row.memberId === memberId);

  if (memberRows.length === 0) {
    return {
      status: 'not_recorded',
      reason: 'member not present in vote record',
    };
  }

  if (memberRows.length > 1) {
    return {
      status: 'ambiguity',
      reason: `duplicate ${memberId} in vote record`,
    };
  }

  const posResult = normalizePosition(memberRows[0].rawPosition, context);

  if (posResult.ok === false) {
    return {
      status: 'unsupported_position',
      rawPosition: posResult.rawPosition,
      reason: posResult.reason,
    };
  }

  return {
    status: 'recorded',
    position: posResult.position,
    rawPosition: posResult.rawPosition,
  };
}

// ─── Section 6: Bill classification ────────────────────────────────────────

export const BILL_TYPES = ['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres', 'hres', 'sres'] as const;
export type BillType = typeof BILL_TYPES[number];

export interface BillRef {
  congress: number;
  type: BillType;
  number: number;
}

export type NonBillSubtype = 'quorum' | 'journal' | 'adjourn' | 'nomination' | 'treaty';

export const RESOLUTION_OUTCOMES = [
  'resolved_bill',
  'authoritative_non_bill',
  'unsupported_record',
  'ambiguity',
  'malformed_source',
  'incomplete_fetch',
  'source_failure',
] as const;
export type ResolutionOutcome = typeof RESOLUTION_OUTCOMES[number];

export type RollResolution =
  | {
      outcome: 'resolved_bill';
      bill: BillRef;
      amendment: string | null;
      raw: Record<string, string | null>;
    }
  | {
      outcome: 'authoritative_non_bill';
      subtype: NonBillSubtype;
      raw: Record<string, string | null>;
    }
  | {
      outcome: 'unsupported_record' | 'ambiguity' | 'malformed_source' | 'incomplete_fetch' | 'source_failure';
      reason: string;
      raw: Record<string, string | null>;
    };

export function isResolved(r: RollResolution): boolean {
  return r.outcome === 'resolved_bill' || r.outcome === 'authoritative_non_bill';
}

// ─── House roll classification ────────────────────────────────────────────

export interface HouseRollMetadata {
  congress: number;
  legis_num: string;
  vote_type: string;
  question: string;
  amendment_num: string | null;
}

/**
 * Classify a House roll. Normalizes legis_num for matching (drop '.', uppercase,
 * collapse spaces) but never mutates it; preserved in raw and error messages.
 */
export function classifyHouseRoll(meta: HouseRollMetadata): RollResolution {
  const raw: Record<string, string | null> = {
    congress: String(meta.congress),
    legis_num: meta.legis_num,
    vote_type: meta.vote_type,
    question: meta.question,
    amendment_num: meta.amendment_num,
  };

  const legis_num = meta.legis_num.trim();

  // Empty legis_num → unsupported
  if (legis_num === '') {
    return {
      outcome: 'unsupported_record',
      reason: 'missing document identity is not evidence of a non-bill vote',
      raw,
    };
  }

  // Special non-bill cases
  if (legis_num === 'QUORUM') {
    if (meta.vote_type === 'QUORUM') {
      return {
        outcome: 'authoritative_non_bill',
        subtype: 'quorum',
        raw,
      };
    }
    return {
      outcome: 'ambiguity',
      reason: 'QUORUM legis_num with non-QUORUM vote_type',
      raw,
    };
  }

  if (legis_num === 'JOURNAL') {
    return {
      outcome: 'authoritative_non_bill',
      subtype: 'journal',
      raw,
    };
  }

  if (legis_num === 'ADJOURN') {
    return {
      outcome: 'authoritative_non_bill',
      subtype: 'adjourn',
      raw,
    };
  }

  // Normalize for matching: replace dots with spaces, collapse whitespace, trim, uppercase
  const normalized = legis_num.replace(/\./g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();

  // Bill patterns
  const patterns: { regex: RegExp; type: BillType }[] = [
    { regex: /^H R ([1-9]\d*)$/, type: 'hr' },
    { regex: /^H RES ([1-9]\d*)$/, type: 'hres' },
    { regex: /^H J RES ([1-9]\d*)$/, type: 'hjres' },
    { regex: /^H CON RES ([1-9]\d*)$/, type: 'hconres' },
    { regex: /^S ([1-9]\d*)$/, type: 's' },
    { regex: /^S RES ([1-9]\d*)$/, type: 'sres' },
    { regex: /^S J RES ([1-9]\d*)$/, type: 'sjres' },
    { regex: /^S CON RES ([1-9]\d*)$/, type: 'sconres' },
  ];

  for (const { regex, type } of patterns) {
    const match = normalized.match(regex);
    if (match) {
      const billNumber = parseInt(match[1], 10);
      return {
        outcome: 'resolved_bill',
        bill: {
          congress: meta.congress,
          type,
          number: billNumber,
        },
        amendment: meta.amendment_num,
        raw,
      };
    }
  }

  // No pattern matched
  return {
    outcome: 'unsupported_record',
    reason: `unrecognized legis_num: "${legis_num}"`,
    raw,
  };
}

// ─── Senate roll classification ────────────────────────────────────────────

export interface SenateDocumentFields {
  congress: number;
  documentCongress: string;
  documentType: string;
  documentNumber: string;
  documentName: string;
  amendmentNumber: string;
  amendmentToDocumentNumber: string;
}

type BillDesignationParse =
  | { kind: 'bill'; type: BillType; number: number }
  | { kind: 'unsafe_number'; type: BillType; digits: string };

/**
 * Parse a Senate bill designation string (e.g., "S. 5", "H.R. 12").
 * Returns undefined if the string is not a bill designation.
 * Returns kind 'unsafe_number' when it matches a designation but the digits
 * are not a safe integer (never silently rounded).
 */
function parseBillDesignation(designation: string): BillDesignationParse | undefined {
  if (!designation || designation.trim() === '') return undefined;

  const patterns: { regex: RegExp; type: BillType }[] = [
    { regex: /^S\.\s+([1-9]\d*)$/, type: 's' },
    { regex: /^H\.R\.\s+([1-9]\d*)$/, type: 'hr' },
    { regex: /^S\.J\.Res\.\s+([1-9]\d*)$/, type: 'sjres' },
    { regex: /^H\.J\.Res\.\s+([1-9]\d*)$/, type: 'hjres' },
    { regex: /^S\.Con\.Res\.\s+([1-9]\d*)$/, type: 'sconres' },
    { regex: /^H\.Con\.Res\.\s+([1-9]\d*)$/, type: 'hconres' },
    { regex: /^S\.Res\.\s+([1-9]\d*)$/, type: 'sres' },
    { regex: /^H\.Res\.\s+([1-9]\d*)$/, type: 'hres' },
  ];

  for (const { regex, type } of patterns) {
    const match = designation.match(regex);
    if (match) {
      const digits = match[1];
      const value = Number(digits);
      if (!Number.isSafeInteger(value)) {
        return { kind: 'unsafe_number', type, digits };
      }
      return { kind: 'bill', type, number: value };
    }
  }

  return undefined;
}

/**
 * Shared documentCongress rule for both the direct-document path and the
 * amendment-parent fallback. Returns a terminal result, or undefined to continue.
 */
function checkDocumentCongress(
  documentCongress: string,
  congressNum: number,
  raw: Record<string, string | null>
): RollResolution | undefined {
  if (!documentCongress || documentCongress.trim() === '') return undefined;
  if (!/^[1-9]\d*$/.test(documentCongress) || !Number.isSafeInteger(Number(documentCongress))) {
    return {
      outcome: 'malformed_source',
      reason: `malformed document congress: "${documentCongress}"`,
      raw,
    };
  }
  const docCongress = Number(documentCongress);
  if (docCongress !== congressNum) {
    return {
      outcome: 'ambiguity',
      reason: `documentCongress ${docCongress} ≠ vote congress ${congressNum}`,
      raw,
    };
  }
  return undefined;
}

export function classifySenateRoll(fields: SenateDocumentFields): RollResolution {
  const raw: Record<string, string | null> = {
    congress: String(fields.congress),
    documentCongress: fields.documentCongress,
    documentType: fields.documentType,
    documentNumber: fields.documentNumber,
    documentName: fields.documentName,
    amendmentNumber: fields.amendmentNumber,
    amendmentToDocumentNumber: fields.amendmentToDocumentNumber,
  };

  // Normalize congress to number for comparisons
  const congressNum = typeof fields.congress === 'number' ? fields.congress : parseInt(String(fields.congress), 10);

  // Check for non-bill types
  if (fields.documentType === 'PN') {
    return {
      outcome: 'authoritative_non_bill',
      subtype: 'nomination',
      raw,
    };
  }

  if (fields.documentType === 'Treaty Doc.') {
    return {
      outcome: 'authoritative_non_bill',
      subtype: 'treaty',
      raw,
    };
  }

  // Map document types to bill types
  const typeMap: { [key: string]: BillType } = {
    'S.': 's',
    'H.R.': 'hr',
    'S.J.Res.': 'sjres',
    'H.J.Res.': 'hjres',
    'S.Con.Res.': 'sconres',
    'H.Con.Res.': 'hconres',
    'S.Res.': 'sres',
    'H.Res.': 'hres',
  };

  // Try to resolve as a bill
  if (fields.documentType && fields.documentNumber) {
    const billType = typeMap[fields.documentType];

    if (billType) {
      // Parse bill number FIRST (before congress check): strict digits, no leading zeros, safe integer
      if (!/^[1-9]\d*$/.test(fields.documentNumber) || !Number.isSafeInteger(Number(fields.documentNumber))) {
        return {
          outcome: 'malformed_source',
          reason: `malformed document number: "${fields.documentNumber}"`,
          raw,
        };
      }
      const billNumber = Number(fields.documentNumber);

      // Check documentCongress matches congress (only if provided)
      const congressResult = checkDocumentCongress(fields.documentCongress, congressNum, raw);
      if (congressResult) return congressResult;

      // Check amendment parent if present
      if (fields.amendmentToDocumentNumber) {
        const amendParsed = parseBillDesignation(fields.amendmentToDocumentNumber);
        if (amendParsed) {
          if (amendParsed.kind === 'unsafe_number') {
            return {
              outcome: 'malformed_source',
              reason: `malformed amendment parent number: "${fields.amendmentToDocumentNumber}"`,
              raw,
            };
          }
          if (amendParsed.type !== billType || amendParsed.number !== billNumber) {
            return {
              outcome: 'ambiguity',
              reason: `document bill and amendment parent disagree`,
              raw,
            };
          }
        }
      }

      return {
        outcome: 'resolved_bill',
        bill: {
          congress: congressNum,
          type: billType,
          number: billNumber,
        },
        amendment: fields.amendmentNumber || null,
        raw,
      };
    } else if (fields.documentType && fields.documentType.trim() !== '') {
      // Unknown document type
      return {
        outcome: 'unsupported_record',
        reason: `unknown document type: "${fields.documentType}"`,
        raw,
      };
    }
  }

  // No document; try to resolve via amendment parent
  if (fields.amendmentToDocumentNumber) {
    const amendParsed = parseBillDesignation(fields.amendmentToDocumentNumber);
    if (amendParsed) {
      // Only validate congress once there is a parsed parent to resolve
      const congressResult = checkDocumentCongress(fields.documentCongress, congressNum, raw);
      if (congressResult) return congressResult;
      if (amendParsed.kind === 'unsafe_number') {
        return {
          outcome: 'malformed_source',
          reason: `malformed amendment parent number: "${fields.amendmentToDocumentNumber}"`,
          raw,
        };
      }
      return {
        outcome: 'resolved_bill',
        bill: {
          congress: congressNum,
          type: amendParsed.type,
          number: amendParsed.number,
        },
        amendment: fields.amendmentToDocumentNumber,
        raw,
      };
    }
  }

  // Everything empty
  return {
    outcome: 'unsupported_record',
    reason: 'all document fields empty',
    raw,
  };
}
