/**
 * Official vote acquisition manifest validation (§6, §7).
 *
 * Pure validation over unknown input: never throws for bad manifest content.
 * Collects ALL problems before determining verdict. Check order:
 * structural/contract → invalid. Only if zero problems → incompleteness
 * reasons → incomplete; else complete. Scope always 'acquisition_only';
 * 'complete' never implies normalized votes, membership, bill resolution
 * or certification.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
  COVERAGE_MONTHS,
  FROZEN_EVIDENCE_WINDOW,
  VOTE_ACQUISITION_CONTRACT,
  VOTE_ACQUISITION_CONTRACT_VERSION,
  sessionYear,
  rollKey,
  houseSourceUrl,
  inWindow,
  checkRollIdentity,
  isIsoDate,
  subtractCalendarMonths,
} from '../../lib/vote-source.js';

// ─── Type definitions (§7) ────────────────────────────────────────────────────

export const ACQUISITION_OUTCOMES = [
  'pending',
  'acquired',
  'excluded_outside_window',
  'unsupported_record',
  'malformed_source',
  'incomplete_fetch',
  'source_failure',
] as const;
export type AcquisitionOutcome = typeof ACQUISITION_OUTCOMES[number];

export interface AcquisitionResponse {
  url: string;
  final_url: string;
  http_status: number;
  content_type: string;
  path: string;
  sha256: string;
  bytes: number;
  body_complete: boolean;
  read_error: string | null;
  attempted_at: string;
  received_at: string;
}

export interface AcquisitionRecord {
  key: string;
  chamber: string;
  congress: number;
  session: number;
  year: number;
  roll: number;
  date: string;
  status: string | null;
  url: string;
  page: number;
  index_receipt: unknown;
  source_url: string;
  in_window: boolean;
  attempted: boolean;
  attempted_at: string | null;
  outcome: AcquisitionOutcome;
  reason: string | null;
  response: AcquisitionResponse | null;
  metadata:
    | {
        key: string;
        chamber: string;
        congress: number;
        session: number;
        roll: number;
        date: string;
        legis_num: string;
        question: string;
        vote_type: string;
        result: string;
        vote_desc: string;
        amendment_num: string | null;
        amendment_author: string | null;
        recorded_vote_count: number;
        position_tokens: Record<string, number>;
      }
    | null;
}

export interface AcquisitionManifest {
  contract: string;
  contract_version: number;
  chamber: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  window: [string, string];
  window_policy: { as_of: string; months: number | null };
  inventory_sha256: string;
  index_pages_verified: number;
  published_rolls: number;
  required_rolls: number;
  attempted_rolls: number;
  max_rolls: number | null;
  safety_cap_applied: boolean;
  counts: Record<string, number>;
  acquisition_semantics: string;
  normalized_votes_validated: boolean;
  member_coverage_validated: boolean;
  bill_resolution_validated: boolean;
  collector_revision: unknown;
  records: AcquisitionRecord[];
}

export interface ValidationPolicy {
  window: { start: string; end: string };
  coverageMonths: number | null;
}

export type ManifestVerdict =
  | {
      verdict: 'complete';
      scope: 'acquisition_only';
      manifest: AcquisitionManifest;
      required: number;
      acquired: number;
      excluded: number;
    }
  | { verdict: 'incomplete'; scope: 'acquisition_only'; reasons: string[]; counts: Record<string, number> }
  | { verdict: 'invalid'; problems: string[] };

export const FROZEN_POLICY: ValidationPolicy = {
  window: {
    start: FROZEN_EVIDENCE_WINDOW.start,
    end: FROZEN_EVIDENCE_WINDOW.end,
  },
  coverageMonths: 48,
};

// ─── Validation helper ────────────────────────────────────────────────────────

/** Run a helper; a throw is recorded as a problem, never silently ignored (§7). */
function attempt<T>(problems: string[], label: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    problems.push(`${label}: ${e instanceof Error ? e.message : describe(e)}`);
    return undefined;
  }
}

const DESCRIBE_MAX_LENGTH = 120;

/**
 * Diagnostic rendering of an untrusted manifest value. Never throws and is bounded:
 * BigInt and Symbol are rendered explicitly; circular or otherwise unserializable
 * values fall back to their Object.prototype.toString tag.
 */
function describe(v: unknown): string {
  let out: string;
  try {
    if (typeof v === 'bigint') {
      out = `${v.toString()}n`;
    } else if (typeof v === 'symbol') {
      out = v.toString();
    } else if (typeof v === 'function') {
      out = 'function';
    } else {
      out = JSON.stringify(v) ?? typeof v;
    }
  } catch {
    try {
      out = Object.prototype.toString.call(v);
    } catch {
      out = typeof v;
    }
  }
  return out.length > DESCRIBE_MAX_LENGTH ? `${out.slice(0, DESCRIBE_MAX_LENGTH)}...` : out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const MANIFEST_STATUSES = ['running', 'acquisition_complete', 'incomplete'];
const SAFETY_CAP_REASON = 'safety cap';

/** §6: every top-level key is always present. */
const MANIFEST_KEYS = [
  'contract', 'contract_version', 'chamber', 'status', 'started_at', 'finished_at', 'window',
  'window_policy', 'inventory_sha256', 'index_pages_verified', 'published_rolls', 'required_rolls',
  'attempted_rolls', 'max_rolls', 'safety_cap_applied', 'counts', 'acquisition_semantics',
  'normalized_votes_validated', 'member_coverage_validated', 'bill_resolution_validated',
  'collector_revision', 'records',
];

function isNonNegInt(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0;
}

function isPosInt(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) > 0;
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

/** §6/§7 field types for a non-null metadata object (identity is checked separately). */
function metadataTypeProblems(meta: Record<string, unknown>, label: string): string[] {
  const problems: string[] = [];
  if (typeof meta.key !== 'string') {
    problems.push(`${label}.key: must be a string`);
  }
  if (meta.chamber !== 'house') {
    problems.push(`${label}.chamber: must be "house"`);
  }
  for (const field of ['congress', 'roll']) {
    if (!isPosInt(meta[field])) {
      problems.push(`${label}.${field}: must be a positive safe integer`);
    }
  }
  if (meta.session !== 1 && meta.session !== 2) {
    problems.push(`${label}.session: must be 1 or 2`);
  }
  if (!isIsoDate(meta.date)) {
    problems.push(`${label}.date: must be a real ISO date`);
  }
  for (const field of ['legis_num', 'question', 'vote_type', 'result', 'vote_desc']) {
    if (typeof meta[field] !== 'string') {
      problems.push(`${label}.${field}: must be a string`);
    }
  }
  for (const field of ['amendment_num', 'amendment_author']) {
    if (!isStringOrNull(meta[field])) {
      problems.push(`${label}.${field}: must be a string or null`);
    }
  }
  if (!isPosInt(meta.recorded_vote_count)) {
    problems.push(`${label}.recorded_vote_count: must be a positive integer, got ${describe(meta.recorded_vote_count)}`);
  }
  if (!isPosIntMap(meta.position_tokens)) {
    problems.push(`${label}.position_tokens: must be an object of positive integers`);
  } else {
    const sum = Object.values(meta.position_tokens).reduce((a, b) => a + b, 0);
    if (sum !== meta.recorded_vote_count) {
      problems.push(`${label}.position_tokens: sum ${sum} != recorded_vote_count ${describe(meta.recorded_vote_count)}`);
    }
  }
  return problems;
}

/** Object whose values are all positive safe integers. */
function isPosIntMap(v: unknown): v is Record<string, number> {
  return isObject(v) && Object.values(v).every(isPosInt);
}

// ─── Main validation function ────────────────────────────────────────────────

function validateAcquisitionManifestChecked(
  input: unknown,
  policy: ValidationPolicy
): ManifestVerdict {
  const problems: string[] = [];

  // ─── Structural checks ──────────────────────────────────────────────────────

  if (!isObject(input)) {
    return { verdict: 'invalid', problems: ['input is not an object'] };
  }

  const m = input as Record<string, unknown>;

  for (const key of MANIFEST_KEYS) {
    if (!(key in m)) {
      problems.push(`${key}: missing`);
    }
  }
  if ('collector_revision' in m && m.collector_revision !== null) {
    problems.push(`collector_revision: must be null, got ${describe(m.collector_revision)}`);
  }

  // Contract + version
  if (m.contract !== VOTE_ACQUISITION_CONTRACT) {
    problems.push(`contract: expected "${VOTE_ACQUISITION_CONTRACT}", got ${describe(m.contract)}`);
  }
  if (m.contract_version !== VOTE_ACQUISITION_CONTRACT_VERSION) {
    problems.push(`contract_version: expected ${VOTE_ACQUISITION_CONTRACT_VERSION}, got ${describe(m.contract_version)}`);
  }

  // Chamber (house-only for this package)
  if (m.chamber !== 'house') {
    problems.push(`chamber: expected "house", got ${describe(m.chamber)}`);
  }

  // acquisition_semantics
  if (m.acquisition_semantics !== 'downloaded_and_identity_checked_only') {
    problems.push(
      `acquisition_semantics: expected "downloaded_and_identity_checked_only", got ${describe(m.acquisition_semantics)}`
    );
  }

  // Validation flags must be false
  if (m.normalized_votes_validated !== false) {
    problems.push('normalized_votes_validated: must be false');
  }
  if (m.member_coverage_validated !== false) {
    problems.push('member_coverage_validated: must be false');
  }
  if (m.bill_resolution_validated !== false) {
    problems.push('bill_resolution_validated: must be false');
  }

  // Window checks
  if (!Array.isArray(m.window) || m.window.length !== 2) {
    problems.push('window: must be a 2-element array');
  } else if (m.window[0] !== policy.window.start || m.window[1] !== policy.window.end) {
    problems.push(
      `window: expected [${policy.window.start}, ${policy.window.end}], got ${describe(m.window)}`
    );
  }

  // Top-level field types (§7 amendment)
  if (typeof m.status !== 'string' || !MANIFEST_STATUSES.includes(m.status)) {
    problems.push(`status: expected one of ${MANIFEST_STATUSES.join(', ')}, got ${describe(m.status)}`);
  }
  if (typeof m.inventory_sha256 !== 'string' || !SHA256_RE.test(m.inventory_sha256)) {
    problems.push(`inventory_sha256: must be 64 lowercase hex, got ${describe(m.inventory_sha256)}`);
  }
  if (typeof m.started_at !== 'string' || m.started_at === '') {
    problems.push(`started_at: must be a non-empty string, got ${describe(m.started_at)}`);
  }
  if (!isStringOrNull(m.finished_at)) {
    problems.push(`finished_at: must be a string or null, got ${describe(m.finished_at)}`);
  }
  for (const field of ['index_pages_verified', 'published_rolls', 'required_rolls', 'attempted_rolls']) {
    if (!isNonNegInt(m[field])) {
      problems.push(`${field}: must be a non-negative safe integer, got ${describe(m[field])}`);
    }
  }
  if (m.max_rolls !== null && !isNonNegInt(m.max_rolls)) {
    problems.push(`max_rolls: must be a non-negative safe integer or null, got ${describe(m.max_rolls)}`);
  }
  if (typeof m.safety_cap_applied !== 'boolean') {
    problems.push(`safety_cap_applied: must be boolean, got ${describe(m.safety_cap_applied)}`);
  }
  if (!isPosIntMap(m.counts)) {
    problems.push('counts: must be an object of positive integers');
  }

  // window_policy and coverageMonths consistency
  const windowPolicy = isObject(m.window_policy) ? m.window_policy : null;
  if (windowPolicy === null) {
    problems.push('window_policy: must be an object');
  } else {
    if (!Array.isArray(m.window) || windowPolicy.as_of !== m.window[1]) {
      problems.push(`window_policy.as_of: must equal window[1], got ${describe(windowPolicy.as_of)}`);
    }
    if (windowPolicy.months !== null && !isPosInt(windowPolicy.months)) {
      problems.push(`window_policy.months: must be a positive integer or null, got ${describe(windowPolicy.months)}`);
    }
  }
  const policyMonths = windowPolicy?.months;

  if (policy.coverageMonths !== null) {
    const months = policy.coverageMonths;
    // If policy specifies months, manifest must match
    if (policyMonths !== months) {
      problems.push(
        `window_policy.months: expected ${months} when policy.coverageMonths is set, got ${describe(policyMonths)}`
      );
    }
    // Also verify window math: subtractCalendarMonths(window[1], n) == window[0]
    if (Array.isArray(m.window) && m.window.length === 2) {
      const end = m.window[1];
      const expectedStart = attempt(problems, 'window_policy', () => subtractCalendarMonths(end as string, months));
      if (expectedStart !== undefined && expectedStart !== m.window[0]) {
        problems.push(
          `window_policy: months ${months} does not match window dates ${describe(m.window)}`
        );
      }
    }
  }

  // window_policy.months is independent of policy.coverageMonths: only null or the frozen
  // COVERAGE_MONTHS may be claimed, and a claimed 48 must match the window span while a
  // null claim must not be a true 48-month span.
  if (windowPolicy !== null) {
    if (windowPolicy.months !== null && windowPolicy.months !== COVERAGE_MONTHS) {
      problems.push(
        `window_policy.months: must be null or ${COVERAGE_MONTHS}, got ${describe(windowPolicy.months)}`
      );
    }
    if (Array.isArray(m.window) && m.window.length === 2 && isIsoDate(m.window[0]) && isIsoDate(m.window[1])) {
      const [winStart, winEnd] = m.window as [string, string];
      const spanStart = attempt(problems, 'window_policy', () => subtractCalendarMonths(winEnd, COVERAGE_MONTHS));
      if (spanStart !== undefined) {
        const isFrozenSpan = spanStart === winStart;
        if (policyMonths === COVERAGE_MONTHS && !isFrozenSpan) {
          problems.push(
            `window_policy: months ${COVERAGE_MONTHS} does not match window dates ${describe(m.window)}`
          );
        }
        if (policyMonths === null && isFrozenSpan) {
          problems.push(
            `window_policy: window dates ${describe(m.window)} are a ${COVERAGE_MONTHS}-month span but months is null`
          );
        }
      }
    }
  }

  // records must be array
  if (!Array.isArray(m.records)) {
    problems.push('records: must be an array');
  }

  // If we have structural problems, return invalid early
  if (problems.length > 0) {
    return { verdict: 'invalid', problems };
  }

  // ─── Record-level validation ────────────────────────────────────────────────

  const records = m.records as unknown[];
  const seenKeys = new Set<string>();

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!isObject(rec)) {
      problems.push(`records[${i}]: not an object`);
      continue;
    }

    const r = rec as Record<string, unknown>;

    // Check required fields
    const requiredFields = [
      'key',
      'chamber',
      'congress',
      'session',
      'year',
      'roll',
      'date',
      'status',
      'url',
      'page',
      'index_receipt',
      'source_url',
      'in_window',
      'attempted',
      'attempted_at',
      'outcome',
      'reason',
      'response',
      'metadata',
    ];
    for (const field of requiredFields) {
      if (!(field in r)) {
        problems.push(`records[${i}].${field}: missing`);
      }
    }

    // Outcome must be known
    if (!ACQUISITION_OUTCOMES.includes(r.outcome as AcquisitionOutcome)) {
      problems.push(`records[${i}].outcome: unknown outcome ${describe(r.outcome)}`);
    }

    // Record field types (§7 amendment)
    if (typeof r.key !== 'string') {
      problems.push(`records[${i}].key: must be a string`);
    }
    if (r.chamber !== 'house') {
      problems.push(`records[${i}].chamber: expected "house", got ${describe(r.chamber)}`);
    }
    for (const field of ['congress', 'roll', 'year', 'page']) {
      if (!isPosInt(r[field])) {
        problems.push(`records[${i}].${field}: must be a positive safe integer, got ${describe(r[field])}`);
      }
    }
    if (r.session !== 1 && r.session !== 2) {
      problems.push(`records[${i}].session: must be 1 or 2, got ${describe(r.session)}`);
    }
    if (!isIsoDate(r.date)) {
      problems.push(`records[${i}].date: must be a real ISO date, got ${describe(r.date)}`);
    }
    if (typeof r.in_window !== 'boolean') {
      problems.push(`records[${i}].in_window: must be boolean, got ${describe(r.in_window)}`);
    }
    if (typeof r.attempted !== 'boolean') {
      problems.push(`records[${i}].attempted: must be boolean, got ${describe(r.attempted)}`);
    } else if (r.attempted ? typeof r.attempted_at !== 'string' : r.attempted_at !== null) {
      problems.push(`records[${i}].attempted_at: must be a string iff attempted, got ${describe(r.attempted_at)}`);
    }
    if (!isStringOrNull(r.reason)) {
      problems.push(`records[${i}].reason: must be a string or null`);
    }
    if (!isStringOrNull(r.status)) {
      problems.push(`records[${i}].status: must be a string or null`);
    }
    if (typeof r.url !== 'string' || typeof r.source_url !== 'string') {
      problems.push(`records[${i}]: url and source_url must be strings`);
    }
    if (r.response !== null && !isObject(r.response)) {
      problems.push(`records[${i}].response: must be an object or null`);
    } else if (isObject(r.response)) {
      const resp = r.response;
      if (!Number.isInteger(resp.http_status) || (resp.http_status as number) < 100 || (resp.http_status as number) > 599) {
        problems.push(`records[${i}].response.http_status: must be an integer 100-599, got ${describe(resp.http_status)}`);
      }
      if (!isNonNegInt(resp.bytes)) {
        problems.push(`records[${i}].response.bytes: must be a non-negative safe integer, got ${describe(resp.bytes)}`);
      }
      if (typeof resp.body_complete !== 'boolean') {
        problems.push(`records[${i}].response.body_complete: must be boolean`);
      }
      for (const field of ['url', 'final_url', 'content_type', 'path', 'sha256', 'attempted_at', 'received_at']) {
        if (typeof resp[field] !== 'string') {
          problems.push(`records[${i}].response.${field}: must be a string`);
        }
      }
      if (!isStringOrNull(resp.read_error)) {
        problems.push(`records[${i}].response.read_error: must be a string or null`);
      }
    }
    if (!isObject(r.index_receipt)) {
      problems.push(`records[${i}].index_receipt: must be an object`);
    }
    if (r.metadata !== null && !isObject(r.metadata)) {
      problems.push(`records[${i}].metadata: must be an object or null`);
    } else if (isObject(r.metadata)) {
      problems.push(...metadataTypeProblems(r.metadata, `records[${i}].metadata`));
    }

    // Safety cap (§6): an unattempted in-window record is pending (running only) or a
    // safety-cap incomplete_fetch; a safety-cap reason implies exactly that shape.
    const capReason = typeof r.reason === 'string' && r.reason.startsWith(SAFETY_CAP_REASON);
    if (r.in_window === true && r.attempted === false && r.outcome !== 'pending') {
      if (r.outcome !== 'incomplete_fetch' || !capReason) {
        problems.push(
          `records[${i}]: unattempted in-window record must be pending or a safety-cap incomplete_fetch, got ${describe(r.outcome)}`
        );
      }
    }
    if (capReason) {
      if (r.outcome !== 'incomplete_fetch' || r.attempted !== false || r.in_window !== true) {
        problems.push(`records[${i}]: safety-cap reason requires an unattempted in-window incomplete_fetch`);
      }
      if (m.max_rolls === null) {
        problems.push(`records[${i}]: safety-cap record but max_rolls is null`);
      }
    }

    // Check key: duplicate?
    if (typeof r.key === 'string' && seenKeys.has(r.key)) {
      problems.push(`records[${i}].key: duplicate key "${r.key}"`);
    }
    if (typeof r.key === 'string') {
      seenKeys.add(r.key);
    }

    // Validate key matches identity
    if (typeof r.key === 'string') {
      const expected = attempt(problems, `records[${i}].key`, () =>
        rollKey({ chamber: 'house', congress: r.congress as number, session: r.session as 1 | 2, roll: r.roll as number })
      );
      if (expected !== undefined && expected !== r.key) {
        problems.push(`records[${i}].key: expected "${expected}", got "${r.key}"`);
      }
    }

    // Validate year matches sessionYear
    const expectedYear = attempt(problems, `records[${i}].year`, () =>
      sessionYear(r.congress as number, r.session as number)
    );
    if (expectedYear !== undefined && expectedYear !== r.year) {
      problems.push(`records[${i}].year: expected ${expectedYear}, got ${describe(r.year)}`);
    }

    // Validate source_url
    const expectedUrl = attempt(problems, `records[${i}].source_url`, () =>
      houseSourceUrl(r.year as number, r.roll as number)
    );
    if (expectedUrl !== undefined && expectedUrl !== r.source_url) {
      problems.push(`records[${i}].source_url: expected "${expectedUrl}", got ${describe(r.source_url)}`);
    }

    // Validate in_window: must match inWindow(date, policy.window)
    if (typeof r.in_window === 'boolean') {
      const expected = attempt(problems, `records[${i}].in_window`, () =>
        inWindow(r.date as string, policy.window)
      );
      if (expected !== undefined && expected !== r.in_window) {
        problems.push(`records[${i}].in_window: expected ${expected}, got ${r.in_window}`);
      }
    }

    // Validate response path (if present)
    if (isObject(r.response) && typeof (r.response as any).path === 'string') {
      const path = (r.response as any).path as string;
      if (path.startsWith('/')) {
        problems.push(`records[${i}].response.path: must be relative, got "${path}"`);
      }
      if (path.includes('..')) {
        problems.push(`records[${i}].response.path: must not contain "..", got "${path}"`);
      }
      if (path.includes('\\')) {
        problems.push(`records[${i}].response.path: must not contain backslash, got "${path}"`);
      }
    }

    // Validate sha256 (if response present)
    if (isObject(r.response) && typeof (r.response as any).sha256 === 'string') {
      const sha256 = (r.response as any).sha256 as string;
      if (!SHA256_RE.test(sha256)) {
        problems.push(`records[${i}].response.sha256: must be 64 lowercase hex, got "${sha256}"`);
      }
    }

    // Validate outcome vs status rules
    const status = m.status as string | undefined;
    const outcome = r.outcome as string | undefined;
    const attempted = r.attempted as boolean | undefined;
    const inWin = r.in_window as boolean | undefined;
    const response = r.response;

    // pending only while status is running
    if (outcome === 'pending' && status !== 'running') {
      problems.push(`records[${i}].outcome: pending only allowed when status is "running", got "${status}"`);
    }

    // out-of-window → excluded_outside_window, attempted false, response null, metadata null
    if (inWin === false) {
      if (outcome !== 'excluded_outside_window') {
        problems.push(
          `records[${i}].outcome: out-of-window record must be "excluded_outside_window", got ${describe(outcome)}`
        );
      }
      if (attempted !== false) {
        problems.push(`records[${i}].attempted: out-of-window record must have attempted=false, got ${describe(attempted)}`);
      }
      if (response !== null) {
        problems.push(`records[${i}].response: out-of-window record must have response=null, got object`);
      }
      if (r.metadata !== null) {
        problems.push(`records[${i}].metadata: out-of-window record must have metadata=null`);
      }
    }

    // in-window record ⇒ never excluded_outside_window (whether or not attempted)
    if (inWin === true && outcome === 'excluded_outside_window') {
      problems.push(`records[${i}].outcome: in-window record must not be "excluded_outside_window"`);
    }

    // unattempted record must not have response
    if (attempted === false && response !== null) {
      problems.push(`records[${i}].response: unattempted record (attempted=false) must have response=null`);
    }

    // acquired ⇒ many conditions
    if (outcome === 'acquired') {
      if (attempted !== true) {
        problems.push(`records[${i}].attempted: acquired record must have attempted=true`);
      }
      if (!isObject(response)) {
        problems.push(`records[${i}].response: acquired record must have response object`);
      } else {
        const resp = response as Record<string, unknown>;
        if (resp.http_status !== 200) {
          problems.push(
            `records[${i}].response.http_status: acquired record must have http_status=200, got ${describe(resp.http_status)}`
          );
        }
        if (resp.body_complete !== true) {
          problems.push(
            `records[${i}].response.body_complete: acquired record must have body_complete=true, got ${describe(resp.body_complete)}`
          );
        }
        if (resp.final_url !== r.source_url) {
          problems.push(
            `records[${i}].response.final_url: expected ${describe(r.source_url)}, got ${describe(resp.final_url)}`
          );
        }
        if (resp.url !== r.source_url) {
          problems.push(`records[${i}].response.url: expected ${describe(r.source_url)}, got ${describe(resp.url)}`);
        }
      }
      if (!isObject(r.metadata)) {
        problems.push(`records[${i}].metadata: acquired record must have metadata object`);
      } else {
        const meta = r.metadata as Record<string, unknown>;
        if (meta.key !== r.key) {
          problems.push(`records[${i}].metadata.key: expected ${describe(r.key)}, got ${describe(meta.key)}`);
        }
        if (meta.chamber !== 'house') {
          problems.push(`records[${i}].metadata.chamber: expected "house", got ${describe(meta.chamber)}`);
        }
        const identityCheck = attempt(problems, `records[${i}].metadata identity`, () =>
          checkRollIdentity(
            {
              chamber: 'house',
              congress: r.congress as number,
              session: r.session as 1 | 2,
              roll: r.roll as number,
              date: r.date as string,
            },
            {
              chamber: (meta.chamber === 'house' ? 'house' : 'senate') as 'house' | 'senate',
              congress: meta.congress as number,
              session: meta.session as number,
              roll: meta.roll as number,
              date: meta.date as string,
            }
          )
        );
        if (identityCheck && identityCheck.ok === false) {
          for (const mismatch of identityCheck.mismatches) {
            problems.push(`records[${i}].metadata.${mismatch}: mismatch with record`);
          }
        }
      }
    }
  }

  // If record-level problems exist, return invalid
  if (problems.length > 0) {
    return { verdict: 'invalid', problems };
  }

  // ─── Count validation ───────────────────────────────────────────────────────

  // Compute actual counts
  let actualPublished = 0;
  let actualRequired = 0;
  let actualAttempted = 0;
  const actualCounts: Record<string, number> = {};

  for (const rec of records) {
    actualPublished++;
    const outcome = (rec as any).outcome as AcquisitionOutcome;
    actualCounts[outcome] = (actualCounts[outcome] ?? 0) + 1;

    if ((rec as any).in_window === true) {
      actualRequired++;
    }
    if ((rec as any).attempted === true) {
      actualAttempted++;
    }
  }

  // Compare with manifest claims
  const manifest = m as unknown as AcquisitionManifest;
  if (manifest.published_rolls !== actualPublished) {
    problems.push(
      `published_rolls: expected ${actualPublished}, got ${manifest.published_rolls}`
    );
  }
  if (manifest.required_rolls !== actualRequired) {
    problems.push(
      `required_rolls: expected ${actualRequired}, got ${manifest.required_rolls}`
    );
  }
  if (manifest.attempted_rolls !== actualAttempted) {
    problems.push(
      `attempted_rolls: expected ${actualAttempted}, got ${manifest.attempted_rolls}`
    );
  }

  // Verify counts deep-equals actualCounts (same keys, values match)
  const manifestCounts = manifest.counts as Record<string, number>;
  const manifestKeys = Object.keys(manifestCounts).sort();
  const actualKeys = Object.keys(actualCounts).sort();
  if (JSON.stringify(manifestKeys) !== JSON.stringify(actualKeys)) {
    problems.push(
      `counts: keys mismatch. expected [${actualKeys.join(', ')}], got [${manifestKeys.join(', ')}]`
    );
  } else {
    for (const key of actualKeys) {
      if (manifestCounts[key] !== actualCounts[key]) {
        problems.push(`counts.${key}: expected ${actualCounts[key]}, got ${manifestCounts[key]}`);
      }
    }
  }

  if (problems.length > 0) {
    return { verdict: 'invalid', problems };
  }

  // ─── safety_cap_applied validation ──────────────────────────────────────────

  // safety_cap_applied true iff max_rolls is not null AND at least one
  // required roll was left unattempted by the cap (attempted false + outcome incomplete_fetch + reason starts 'safety cap')
  const hasCapTriggered = manifest.max_rolls !== null && records.some((rec) => {
    return (
      (rec as any).in_window === true &&
      (rec as any).attempted === false &&
      (rec as any).outcome === 'incomplete_fetch' &&
      typeof (rec as any).reason === 'string' &&
      ((rec as any).reason as string).startsWith('safety cap')
    );
  });

  if (manifest.safety_cap_applied !== hasCapTriggered) {
    problems.push(
      `safety_cap_applied: expected ${hasCapTriggered}, got ${manifest.safety_cap_applied}`
    );
  }

  if (problems.length > 0) {
    return { verdict: 'invalid', problems };
  }

  // ─── Status consistency checks ──────────────────────────────────────────────

  // status must match outcomes
  const allInWindowAcquired = records.every(
    (rec) => (rec as any).in_window === false || (rec as any).outcome === 'acquired'
  );
  const allOutOfWindowExcluded = records.every(
    (rec) => (rec as any).in_window === true || (rec as any).outcome === 'excluded_outside_window'
  );

  if (manifest.status === 'acquisition_complete') {
    if (!allInWindowAcquired) {
      problems.push(
        'status: "acquisition_complete" but not all in-window records are acquired'
      );
    }
    if (!allOutOfWindowExcluded) {
      problems.push(
        'status: "acquisition_complete" but not all out-of-window records are excluded'
      );
    }
  }

  // finished_at: null only for running
  if (manifest.status === 'running') {
    // finished_at may be null
  } else {
    if (manifest.finished_at === null) {
      problems.push(`finished_at: must not be null for status "${manifest.status}"`);
    }
  }

  if (problems.length > 0) {
    return { verdict: 'invalid', problems };
  }

  // ─── Incomplete checks ──────────────────────────────────────────────────────

  const incompleteness: string[] = [];

  // Running status is incomplete
  if (manifest.status === 'running') {
    incompleteness.push('status running');
  }

  // Incomplete status is structurally valid but never complete, whatever the rows say
  if (manifest.status === 'incomplete') {
    incompleteness.push('status incomplete');
  }

  // Any non-acquired required record is incomplete (list outcome + count)
  const incompleteCounts: Record<string, number> = {};
  for (const rec of records) {
    if ((rec as any).in_window === true && (rec as any).outcome !== 'acquired') {
      const outcome = (rec as any).outcome as string;
      incompleteCounts[outcome] = (incompleteCounts[outcome] ?? 0) + 1;
    }
  }

  for (const outcome of Object.keys(incompleteCounts).sort()) {
    const count = incompleteCounts[outcome];
    incompleteness.push(`${outcome}: ${count} required roll(s)`);
  }

  // Safety cap applied is incomplete
  if (manifest.safety_cap_applied) {
    incompleteness.push('safety cap applied');
  }

  // Zero required rolls is incomplete (empty source never establishes verified-empty)
  if (actualRequired === 0) {
    incompleteness.push('no required rolls: empty source never establishes verified-empty');
  }

  if (incompleteness.length > 0) {
    return {
      verdict: 'incomplete',
      scope: 'acquisition_only',
      reasons: incompleteness,
      counts: actualCounts,
    };
  }

  // ─── Complete verdict ───────────────────────────────────────────────────────

  return {
    verdict: 'complete',
    scope: 'acquisition_only',
    manifest,
    required: actualRequired,
    acquired: actualCounts.acquired ?? 0,
    excluded: actualCounts.excluded_outside_window ?? 0,
  };
}

/**
 * Validate an unknown acquisition manifest. Never throws: any unexpected exception
 * from the checks is returned as an `invalid` verdict.
 */
export function validateAcquisitionManifest(
  input: unknown,
  policy: ValidationPolicy
): ManifestVerdict {
  try {
    return validateAcquisitionManifestChecked(input, policy);
  } catch (e) {
    return {
      verdict: 'invalid',
      problems: [`validator exception: ${e instanceof Error ? e.message : describe(e)}`],
    };
  }
}

// ─── verifyResponseBodies ──────────────────────────────────────────────────────

export function verifyResponseBodies(
  manifest: AcquisitionManifest,
  runDir: string,
  read: (absPath: string) => Buffer = readFileSync
): string[] {
  const problems: string[] = [];
  const resolvedRunDir = resolve(runDir);

  for (const rec of manifest.records) {
    if (!rec.response) continue;

    const { path: relPath, sha256: expectedSha256, bytes: expectedBytes } = rec.response;

    try {
      // Resolve path and check it's within runDir
      const absPath = resolve(resolvedRunDir, relPath);
      if (!absPath.startsWith(resolvedRunDir + sep)) {
        problems.push(`records with key "${rec.key}": response path escapes runDir: "${relPath}"`);
        continue;
      }

      // Read and verify
      const data = read(absPath);
      if (data.length !== expectedBytes) {
        problems.push(
          `records with key "${rec.key}": bytes mismatch for "${relPath}": expected ${expectedBytes}, got ${data.length}`
        );
      }

      const actualSha256 = createHash('sha256').update(data).digest('hex');
      if (actualSha256 !== expectedSha256) {
        problems.push(
          `records with key "${rec.key}": sha256 mismatch for "${relPath}": expected ${expectedSha256}, got ${actualSha256}`
        );
      }
    } catch (e) {
      problems.push(
        `records with key "${rec.key}": unable to read/verify "${relPath}": ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  return problems;
}
