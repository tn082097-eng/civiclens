/**
 * Test-first validation suite for official-vote acquisition manifest contract (§6, §7, §8).
 *
 * Validates validateAcquisitionManifest(), verifyResponseBodies(), and interop with
 * make_interop_manifest.py. Covers contract compliance, invalid rules, incomplete
 * verdicts, frozen policy, and offline interoperability.
 *
 * SYNTHETIC manifests and test data are clearly labeled as such.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  validateAcquisitionManifest,
  verifyResponseBodies,
  FROZEN_POLICY,
  type AcquisitionManifest,
  type AcquisitionResponse,
  type AcquisitionRecord,
  type ValidationPolicy,
  type ManifestVerdict,
} from './official-votes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../');

// ─── SYNTHETIC Helper: syntheticCompleteManifest ───────────────────────────

/**
 * SYNTHETIC complete manifest for 2025-01-03 with one in-window acquired record.
 * Follows §6 wire format exactly.
 */
function syntheticCompleteManifest(): AcquisitionManifest {
  // One in-window acquired record: 119-2025/h1, dated 2025-01-03
  const acquiredRecord: AcquisitionRecord = {
    key: '119-2025/h1',
    chamber: 'house',
    congress: 119,
    session: 1,
    year: 2025,
    roll: 1,
    date: '2025-01-03',
    status: null,
    url: 'https://clerk.house.gov/Votes/2025001',
    page: 1,
    index_receipt: { /* mocked */ } as any,
    source_url: 'https://clerk.house.gov/evs/2025/roll001.xml',
    in_window: true,
    attempted: true,
    attempted_at: '2025-01-03T12:33:00+00:00',
    outcome: 'acquired',
    reason: null,
    response: {
      url: 'https://clerk.house.gov/evs/2025/roll001.xml',
      final_url: 'https://clerk.house.gov/evs/2025/roll001.xml',
      http_status: 200,
      content_type: 'application/xml',
      path: 'responses/2025-h00001.body',
      sha256: '876aa39e6cfe58942eb5a3b24628975b288e6c5fca8d8e0257dfcd7d180163fd',
      bytes: 12345,
      body_complete: true,
      read_error: null,
      attempted_at: '2025-01-03T12:33:00+00:00',
      received_at: '2025-01-03T12:34:00+00:00',
    },
    metadata: {
      key: '119-2025/h1',
      chamber: 'house',
      congress: 119,
      session: 1,
      roll: 1,
      date: '2025-01-03',
      legis_num: 'QUORUM',
      question: 'Call by States',
      vote_type: 'QUORUM',
      result: 'Passed',
      vote_desc: '',
      amendment_num: null,
      amendment_author: null,
      recorded_vote_count: 435,
      position_tokens: { 'Present': 433, 'Not Voting': 2 },
    },
  };

  // One out-of-window excluded record: 119-2025/h2, dated 2025-01-04
  const excludedRecord: AcquisitionRecord = {
    key: '119-2025/h2',
    chamber: 'house',
    congress: 119,
    session: 1,
    year: 2025,
    roll: 2,
    date: '2025-01-04',
    status: null,
    url: 'https://clerk.house.gov/Votes/2025002',
    page: 1,
    index_receipt: { /* mocked */ } as any,
    source_url: 'https://clerk.house.gov/evs/2025/roll002.xml',
    in_window: false,
    attempted: false,
    attempted_at: null,
    outcome: 'excluded_outside_window',
    reason: 'official listing date outside frozen inclusive window',
    response: null,
    metadata: null,
  };

  return {
    contract: 'civiclens.official-vote-acquisition',
    contract_version: 1,
    chamber: 'house',
    status: 'acquisition_complete',
    started_at: '2025-01-03T12:00:00+00:00',
    finished_at: '2025-01-03T12:35:00+00:00',
    window: ['2025-01-03', '2025-01-03'],
    window_policy: { as_of: '2025-01-03', months: null },
    inventory_sha256: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
    index_pages_verified: 1,
    published_rolls: 2,
    required_rolls: 1,
    attempted_rolls: 1,
    max_rolls: null,
    safety_cap_applied: false,
    counts: { acquired: 1, excluded_outside_window: 1 },
    acquisition_semantics: 'downloaded_and_identity_checked_only',
    normalized_votes_validated: false,
    member_coverage_validated: false,
    bill_resolution_validated: false,
    collector_revision: null,
    records: [acquiredRecord, excludedRecord],
  };
}

// ─── Test 1: syntheticCompleteManifest validation ──────────────────────

test('syntheticCompleteManifest produces a fully valid complete manifest', () => {
  const manifest = syntheticCompleteManifest();
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'complete');
  assert.equal((verdict as any).scope, 'acquisition_only');
  assert.equal((verdict as any).required, 1);
  assert.equal((verdict as any).acquired, 1);
  assert.equal((verdict as any).excluded, 1);
});

// ─── Test 2: Complete verdict structure ─────────────────────────────────

test('complete verdict includes manifest and counts', () => {
  const manifest = syntheticCompleteManifest();
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'complete');
  const complete = verdict as any;
  assert(complete.manifest);
  assert.equal(complete.scope, 'acquisition_only');
  assert.equal(complete.required, 1);
  assert.equal(complete.acquired, 1);
  assert.equal(complete.excluded, 1);
});

// ─── Test 3-N: Invalid Rules (§7) ───────────────────────────────────────

test('invalid: wrong contract', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.contract = 'wrong-contract';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
  assert((verdict as any).problems.some((p: string) => p.includes('contract')));
});

test('invalid: wrong contract_version', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.contract_version = 999;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: chamber is senate', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.chamber = 'senate';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: wrong acquisition_semantics', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.acquisition_semantics = 'wrong-semantics';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: normalized_votes_validated is not false', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.normalized_votes_validated = true;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: member_coverage_validated is not false', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.member_coverage_validated = true;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: bill_resolution_validated is not false', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.bill_resolution_validated = true;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: window differs from policy', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.window = ['2025-01-02', '2025-01-03'];
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: coverageMonths 48 with 1-day window', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.window_policy.months = 48;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: 48,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: records not an array', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records = 'not-an-array';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: missing record field', () => {
  const manifest = syntheticCompleteManifest() as any;
  delete manifest.records[0].key;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: unknown outcome', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].outcome = 'unknown-outcome';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: duplicate key', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[1].key = manifest.records[0].key;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: key not matching identity', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].key = '999-9999/h999';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: year not matching sessionYear', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].year = 2026;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: source_url changed from houseSourceUrl', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].source_url = 'https://example.com/wrong';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: in_window wrong', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].in_window = false;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: published_rolls count mismatch', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.published_rolls = 999;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: required_rolls count mismatch', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.required_rolls = 999;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: attempted_rolls count mismatch', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.attempted_rolls = 999;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: counts mismatch', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.counts.acquired = 999;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: pending outside running', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.status = 'acquisition_complete';
  manifest.records[0].outcome = 'pending';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: out-of-window record with attempted=true', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[1].attempted = true;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: out-of-window record with response', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[1].response = { /* some response */ } as any;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: unattempted record with response', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].attempted = false;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: acquired with http_status 404', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].response.http_status = 404;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: acquired with body_complete false', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].response.body_complete = false;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: acquired with final_url different', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].response.final_url = 'https://example.com/different';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: acquired metadata roll mismatch', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].metadata.roll = 2;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: acquired metadata date mismatch', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].metadata.date = '2025-01-04';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: acquired metadata congress mismatch', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].metadata.congress = 118;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: response path with ..', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].response.path = '../etc/passwd';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: response path absolute', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].response.path = '/etc/passwd';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: sha256 uppercase', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].response.sha256 = manifest.records[0].response.sha256.toUpperCase();
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: sha256 too short', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].response.sha256 = 'abc123';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: status acquisition_complete while required record is incomplete_fetch', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].outcome = 'incomplete_fetch';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: safety_cap_applied inconsistent', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.safety_cap_applied = true;
  // no max_rolls set, so inconsistent
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: finished_at null with final status', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.finished_at = null;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

// ─── Test: Incomplete Verdicts (§7) ──────────────────────────────────────

test('incomplete: status running with pending record', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.status = 'running';
  manifest.finished_at = null;
  manifest.records[0].outcome = 'pending';
  manifest.records[0].response = null;
  manifest.records[0].metadata = null;
  manifest.counts = { pending: 1, excluded_outside_window: 1 };
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'incomplete');
  assert((verdict as any).reasons.length > 0);
});

test('incomplete: required record as incomplete_fetch', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.status = 'incomplete';
  // Attempted fetch that found the enumerated XML unavailable (adapter: HTTP 404 → incomplete_fetch).
  manifest.records[0].outcome = 'incomplete_fetch';
  manifest.records[0].reason = 'enumerated XML unavailable: HTTP 404';
  manifest.records[0].response.http_status = 404;
  manifest.records[0].metadata = null;
  manifest.counts = { incomplete_fetch: 1, excluded_outside_window: 1 };
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'incomplete');
  assert((verdict as any).reasons.length > 0);
  assert((verdict as any).reasons.some((r: string) => r.includes('incomplete_fetch')));
});

test('incomplete: safety cap applied', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.status = 'incomplete';
  manifest.max_rolls = 0;
  manifest.safety_cap_applied = true;
  manifest.records[0].outcome = 'incomplete_fetch';
  manifest.records[0].attempted = false;
  manifest.records[0].attempted_at = null;
  manifest.records[0].reason = 'safety cap: enumerated roll not attempted';
  manifest.records[0].response = null;
  manifest.records[0].metadata = null;
  manifest.attempted_rolls = 0;
  manifest.counts = { incomplete_fetch: 1, excluded_outside_window: 1 };
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'incomplete');
  assert((verdict as any).reasons.some((r: string) => r.includes('safety cap')));
});

test('incomplete: source_failure outcome', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.status = 'incomplete';
  manifest.records[0].outcome = 'source_failure';
  manifest.records[0].attempted = true;
  manifest.records[0].response = null;
  manifest.records[0].metadata = null;
  manifest.counts = { source_failure: 1, excluded_outside_window: 1 };
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'incomplete');
  assert((verdict as any).reasons.some((r: string) => r.includes('source_failure')));
});

test('incomplete: unsupported_record outcome', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.status = 'incomplete';
  manifest.records[0].outcome = 'unsupported_record';
  manifest.records[0].response = null;
  manifest.records[0].metadata = null;
  manifest.counts = { unsupported_record: 1, excluded_outside_window: 1 };
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'incomplete');
  assert((verdict as any).reasons.some((r: string) => r.includes('unsupported_record')));
});

test('incomplete: malformed_source outcome', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.status = 'incomplete';
  manifest.records[0].outcome = 'malformed_source';
  manifest.records[0].response = null;
  manifest.records[0].metadata = null;
  manifest.counts = { malformed_source: 1, excluded_outside_window: 1 };
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'incomplete');
  assert((verdict as any).reasons.some((r: string) => r.includes('malformed_source')));
});

test('incomplete: zero required rolls only excluded', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.status = 'incomplete';
  manifest.required_rolls = 0;
  manifest.attempted_rolls = 0;
  // Set both records outside the window
  manifest.records[0].date = '2025-01-02';
  manifest.records[0].in_window = false;
  manifest.records[0].outcome = 'excluded_outside_window';
  manifest.records[0].response = null;
  manifest.records[0].metadata = null;
  manifest.records[0].attempted = false;
  manifest.records[0].attempted_at = null;
  manifest.records[1].date = '2025-01-04';
  manifest.records[1].in_window = false;
  manifest.records[1].outcome = 'excluded_outside_window';
  manifest.records[1].response = null;
  manifest.records[1].metadata = null;
  manifest.records[1].attempted = false;
  manifest.records[1].attempted_at = null;
  manifest.counts = { excluded_outside_window: 2 };
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'incomplete');
});

// ─── Test: FROZEN_POLICY ────────────────────────────────────────────────

test('FROZEN_POLICY has correct window and months', () => {
  assert.deepEqual(FROZEN_POLICY.window, {
    start: '2022-09-26',
    end: '2026-09-26',
  });
  assert.equal(FROZEN_POLICY.coverageMonths, 48);
});

test('SYNTHETIC manifest with FROZEN_POLICY window validates', () => {
  const frozenWindow = FROZEN_POLICY.window;
  // congress 117, session 2 → year = 1787 + 2*117 + 2 - 1 = 2022
  const manifest: AcquisitionManifest = {
    contract: 'civiclens.official-vote-acquisition',
    contract_version: 1,
    chamber: 'house',
    status: 'acquisition_complete',
    started_at: '2022-09-26T00:00:00+00:00',
    finished_at: '2022-09-27T00:00:00+00:00',
    window: [frozenWindow.start, frozenWindow.end],
    window_policy: { as_of: frozenWindow.end, months: 48 },
    inventory_sha256: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
    index_pages_verified: 1,
    published_rolls: 1,
    required_rolls: 1,
    attempted_rolls: 1,
    max_rolls: null,
    safety_cap_applied: false,
    counts: { acquired: 1 },
    acquisition_semantics: 'downloaded_and_identity_checked_only',
    normalized_votes_validated: false,
    member_coverage_validated: false,
    bill_resolution_validated: false,
    collector_revision: null,
    records: [
      {
        key: '117-2022/h1',
        chamber: 'house',
        congress: 117,
        session: 2,
        year: 2022,
        roll: 1,
        date: '2022-09-26',
        status: null,
        url: 'https://clerk.house.gov/Votes/2022001',
        page: 1,
        index_receipt: {} as any,
        source_url: 'https://clerk.house.gov/evs/2022/roll001.xml',
        in_window: true,
        attempted: true,
        attempted_at: '2022-09-26T00:00:00+00:00',
        outcome: 'acquired',
        reason: null,
        response: {
          url: 'https://clerk.house.gov/evs/2022/roll001.xml',
          final_url: 'https://clerk.house.gov/evs/2022/roll001.xml',
          http_status: 200,
          content_type: 'application/xml',
          path: 'responses/2022-h00001.body',
          sha256: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
          bytes: 100,
          body_complete: true,
          read_error: null,
          attempted_at: '2022-09-26T00:00:00+00:00',
          received_at: '2022-09-26T01:00:00+00:00',
        },
        metadata: {
          key: '117-2022/h1',
          chamber: 'house',
          congress: 117,
          session: 2,
          roll: 1,
          date: '2022-09-26',
          legis_num: 'QUORUM',
          question: 'Call',
          vote_type: 'QUORUM',
          result: 'Passed',
          vote_desc: '',
          amendment_num: null,
          amendment_author: null,
          recorded_vote_count: 100,
          position_tokens: { 'Present': 100 },
        },
      },
    ],
  };
  const verdict = validateAcquisitionManifest(manifest, FROZEN_POLICY);
  assert.equal(verdict.verdict, 'complete');
});

test('SYNTHETIC manifest with wrong FROZEN_POLICY window start → invalid', () => {
  const manifest: AcquisitionManifest = {
    ...syntheticCompleteManifest(),
    window: ['2022-09-27', '2026-09-26'],
  };
  const verdict = validateAcquisitionManifest(manifest, FROZEN_POLICY);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('policy.window is never advisory: 1-day manifest with different 1-day policy window is invalid even with coverageMonths null', () => {
  const manifest: AcquisitionManifest = {
    ...syntheticCompleteManifest(),
    window: ['2025-01-03', '2025-01-03'],
  };
  const policy: ValidationPolicy = {
    window: { start: '2025-01-04', end: '2025-01-04' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
  assert(
    (verdict as any).problems.some((p: string) => p.toLowerCase().includes('window')),
    'problem must mention window mismatch'
  );
});

// ─── Test: verifyResponseBodies ────────────────────────────────────────

test('verifyResponseBodies: temp dir with correct body → []', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'test-'));
  try {
    const bodyPath = join(runDir, 'responses', '2025-h00001.body');
    mkdirSync(join(runDir, 'responses'), { recursive: true });
    const bodyContent = Buffer.from('test body content');
    writeFileSync(bodyPath, bodyContent);
    const sha256 = createHash('sha256').update(bodyContent).digest('hex');

    const manifest: AcquisitionManifest = {
      ...syntheticCompleteManifest(),
    };
    manifest.records[0].response.path = 'responses/2025-h00001.body';
    manifest.records[0].response.sha256 = sha256;
    manifest.records[0].response.bytes = bodyContent.length;

    const problems = verifyResponseBodies(manifest, runDir);
    assert.deepEqual(problems, []);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('verifyResponseBodies: altered byte → non-empty', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'test-'));
  try {
    mkdirSync(join(runDir, 'responses'), { recursive: true });
    const bodyPath = join(runDir, 'responses', '2025-h00001.body');
    const bodyContent = Buffer.from('test body content');
    writeFileSync(bodyPath, bodyContent);
    const sha256 = createHash('sha256').update(bodyContent).digest('hex');

    const manifest: AcquisitionManifest = {
      ...syntheticCompleteManifest(),
    };
    manifest.records[0].response.path = 'responses/2025-h00001.body';
    manifest.records[0].response.sha256 = sha256;
    manifest.records[0].response.bytes = bodyContent.length;

    // Now alter the file
    const alteredContent = Buffer.from('altered content');
    writeFileSync(bodyPath, alteredContent);

    const problems = verifyResponseBodies(manifest, runDir);
    assert(problems.length > 0);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('verifyResponseBodies: missing file → non-empty', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'test-'));
  try {
    mkdirSync(join(runDir, 'responses'), { recursive: true });

    const manifest: AcquisitionManifest = {
      ...syntheticCompleteManifest(),
    };
    manifest.records[0].response.path = 'responses/nonexistent.body';

    const problems = verifyResponseBodies(manifest, runDir);
    assert(problems.length > 0);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('verifyResponseBodies: path escaping → non-empty', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'test-'));
  try {
    mkdirSync(join(runDir, 'responses'), { recursive: true });

    const manifest: AcquisitionManifest = {
      ...syntheticCompleteManifest(),
    };
    manifest.records[0].response.path = '../../../etc/passwd';

    const problems = verifyResponseBodies(manifest, runDir);
    assert(problems.length > 0);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ─── Test: Type Checking Regression (§7 "Type checks are part of invalid") ──

// 1. Record field type errors
test('invalid: records[0].session = 3 (not 1 or 2)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].session = 3;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: records[0].congress = "119" (string, not number)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].congress = '119';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: records[0].roll = 0 (must be positive)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].roll = 0;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: records[0].roll = 1.5 (not integer)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].roll = 1.5;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: records[0].date = "2025-02-30" (invalid calendar date)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].date = '2025-02-30';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

// 2. Top-level type errors
test('invalid: inventory_sha256 with mixed hex/non-hex chars (G+a*63)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.inventory_sha256 = 'G' + 'a'.repeat(63);
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: inventory_sha256 with capital hex (A+a*63)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.inventory_sha256 = 'A' + 'a'.repeat(63);
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: inventory_sha256 with 63 chars (too short)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.inventory_sha256 = 'a'.repeat(63);
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: inventory_sha256 empty string', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.inventory_sha256 = '';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: status = "done" (unknown status)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.status = 'done';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: started_at = 5 (number, not string)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.started_at = 5;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: finished_at = 5 (number, not string)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.finished_at = 5;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: index_pages_verified = -1 (negative)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.index_pages_verified = -1;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: max_rolls = -1 (negative)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.max_rolls = -1;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: max_rolls = 1.5 (not integer)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.max_rolls = 1.5;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: safety_cap_applied = "false" (string, not boolean)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.safety_cap_applied = 'false';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: window_policy.as_of different from window[1]', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.window_policy.as_of = '2025-01-04';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: window_policy.months = 0 (null or valid 48, not 0)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.window_policy.months = 0;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: counts with zero entry (acquired: 0, excluded_outside_window: 1)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.counts = { acquired: 0, excluded_outside_window: 1 };
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

// 3. Record/response type errors
test('invalid: records[0].in_window = "true" (string, not boolean)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].in_window = 'true';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: attempted_at = null on attempted record', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].attempted_at = null;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: attempted_at string on unattempted excluded record', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[1].attempted_at = '2025-01-04T00:00:00+00:00';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: response.bytes = -1 (negative)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].response.bytes = -1;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: response.bytes = 1.5 (not integer)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].response.bytes = 1.5;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: response.http_status = "200" (string, not number)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].response.http_status = '200';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: response.body_complete = "true" (string, not boolean)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].response.body_complete = 'true';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: response.read_error = 5 (number, not string or null)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].response.read_error = 5;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

// 4. Metadata type errors
test('invalid: metadata.key = "119-2025/h2" (mismatch)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].metadata.key = '119-2025/h2';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: metadata.chamber = "senate" (mismatch)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].metadata.chamber = 'senate';
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: metadata.recorded_vote_count = 0 (must be positive)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].metadata.recorded_vote_count = 0;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: position_tokens sum (434) != recorded_vote_count (435)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].metadata.position_tokens = { 'Present': 433, 'Not Voting': 1 };
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: metadata.legis_num = 5 (number, not string)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].metadata.legis_num = 5;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('invalid: metadata.amendment_num = 7 (number, not string or null)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].metadata.amendment_num = 7;
  const policy: ValidationPolicy = {
    window: { start: '2025-01-03', end: '2025-01-03' },
    coverageMonths: null,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

// 5. Positive test: December window edge case
test('complete: valid manifest with December window (48-month window_policy)', () => {
  // congress 119 session 2 → year = 1787 + 2*119 + 2 - 1 = 2026
  const manifest: AcquisitionManifest = {
    contract: 'civiclens.official-vote-acquisition',
    contract_version: 1,
    chamber: 'house',
    status: 'acquisition_complete',
    started_at: '2026-12-31T00:00:00+00:00',
    finished_at: '2026-12-31T01:00:00+00:00',
    window: ['2022-12-31', '2026-12-31'],
    window_policy: { as_of: '2026-12-31', months: 48 },
    inventory_sha256: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
    index_pages_verified: 1,
    published_rolls: 1,
    required_rolls: 1,
    attempted_rolls: 1,
    max_rolls: null,
    safety_cap_applied: false,
    counts: { acquired: 1 },
    acquisition_semantics: 'downloaded_and_identity_checked_only',
    normalized_votes_validated: false,
    member_coverage_validated: false,
    bill_resolution_validated: false,
    collector_revision: null,
    records: [
      {
        key: '119-2026/h1',
        chamber: 'house',
        congress: 119,
        session: 2,
        year: 2026,
        roll: 1,
        date: '2026-12-31',
        status: null,
        url: 'https://clerk.house.gov/Votes/2026001',
        page: 1,
        index_receipt: {} as any,
        source_url: 'https://clerk.house.gov/evs/2026/roll001.xml',
        in_window: true,
        attempted: true,
        attempted_at: '2026-12-31T00:00:00+00:00',
        outcome: 'acquired',
        reason: null,
        response: {
          url: 'https://clerk.house.gov/evs/2026/roll001.xml',
          final_url: 'https://clerk.house.gov/evs/2026/roll001.xml',
          http_status: 200,
          content_type: 'application/xml',
          path: 'responses/2026-h00001.body',
          sha256: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
          bytes: 100,
          body_complete: true,
          read_error: null,
          attempted_at: '2026-12-31T00:00:00+00:00',
          received_at: '2026-12-31T01:00:00+00:00',
        },
        metadata: {
          key: '119-2026/h1',
          chamber: 'house',
          congress: 119,
          session: 2,
          roll: 1,
          date: '2026-12-31',
          legis_num: 'QUORUM',
          question: 'Call',
          vote_type: 'QUORUM',
          result: 'Passed',
          vote_desc: '',
          amendment_num: null,
          amendment_author: null,
          recorded_vote_count: 100,
          position_tokens: { 'Present': 100 },
        },
      },
    ],
  };
  const policy: ValidationPolicy = {
    window: { start: '2022-12-31', end: '2026-12-31' },
    coverageMonths: 48,
  };
  const verdict = validateAcquisitionManifest(manifest, policy);
  assert.equal(verdict.verdict, 'complete');
  assert.equal((verdict as any).scope, 'acquisition_only');
});

// ─── Test: T20 final-review regressions (§6 safety cap, metadata, top-level keys) ──

const T20_POLICY: ValidationPolicy = {
  window: { start: '2025-01-03', end: '2025-01-03' },
  coverageMonths: null,
};

function recount(manifest: any): void {
  manifest.counts = {};
  for (const r of manifest.records) manifest.counts[r.outcome] = (manifest.counts[r.outcome] ?? 0) + 1;
  manifest.attempted_rolls = manifest.records.filter((r: any) => r.attempted).length;
}

function unattemptInWindow(manifest: any, outcome: string, reason: string): void {
  Object.assign(manifest.records[0], {
    attempted: false, attempted_at: null, response: null, metadata: null, outcome, reason,
  });
  manifest.status = 'incomplete';
  recount(manifest);
}

test('T20: invalid: unattempted in-window record with source_failure and safety-cap reason', () => {
  const manifest = syntheticCompleteManifest() as any;
  unattemptInWindow(manifest, 'source_failure', 'safety cap: enumerated roll not attempted');
  manifest.max_rolls = 0;
  manifest.safety_cap_applied = false;
  const verdict = validateAcquisitionManifest(manifest, T20_POLICY);
  assert.equal(verdict.verdict, 'invalid');
});

test('T20: invalid: unattempted in-window incomplete_fetch without safety-cap reason', () => {
  const manifest = syntheticCompleteManifest() as any;
  unattemptInWindow(manifest, 'incomplete_fetch', 'enumerated vote detail not yet published');
  manifest.max_rolls = 0;
  const verdict = validateAcquisitionManifest(manifest, T20_POLICY);
  assert.equal(verdict.verdict, 'invalid');
});

test('T20: invalid: safety-cap record while max_rolls is null', () => {
  const manifest = syntheticCompleteManifest() as any;
  unattemptInWindow(manifest, 'incomplete_fetch', 'safety cap: enumerated roll not attempted');
  manifest.max_rolls = null;
  manifest.safety_cap_applied = false;
  const verdict = validateAcquisitionManifest(manifest, T20_POLICY);
  assert.equal(verdict.verdict, 'invalid');
});

test('T20: invalid: attempted record carrying a safety-cap reason', () => {
  const manifest = syntheticCompleteManifest() as any;
  Object.assign(manifest.records[0], {
    outcome: 'incomplete_fetch', reason: 'safety cap: enumerated roll not attempted', metadata: null,
  });
  manifest.status = 'incomplete';
  recount(manifest);
  const verdict = validateAcquisitionManifest(manifest, T20_POLICY);
  assert.equal(verdict.verdict, 'invalid');
});

test('T20: valid safety-cap manifest stays incomplete (positive control)', () => {
  const manifest = syntheticCompleteManifest() as any;
  unattemptInWindow(manifest, 'incomplete_fetch', 'safety cap: enumerated roll not attempted');
  manifest.max_rolls = 0;
  manifest.safety_cap_applied = true;
  const verdict = validateAcquisitionManifest(manifest, T20_POLICY);
  assert.equal(verdict.verdict, 'incomplete');
});

test('T20: invalid: non-acquired record with malformed metadata object', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].outcome = 'source_failure';
  manifest.records[0].metadata = { junk: 1 };
  manifest.status = 'incomplete';
  recount(manifest);
  const verdict = validateAcquisitionManifest(manifest, T20_POLICY);
  assert.equal(verdict.verdict, 'invalid');
});

test('T20: invalid: collector_revision non-null', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.collector_revision = 'uncontracted';
  const verdict = validateAcquisitionManifest(manifest, T20_POLICY);
  assert.equal(verdict.verdict, 'invalid');
});

test('T20: invalid: collector_revision missing', () => {
  const manifest = syntheticCompleteManifest() as any;
  delete manifest.collector_revision;
  const verdict = validateAcquisitionManifest(manifest, T20_POLICY);
  assert.equal(verdict.verdict, 'invalid');
});

test('T20: invalid: any §6 top-level key missing', () => {
  for (const key of Object.keys(syntheticCompleteManifest())) {
    const manifest = syntheticCompleteManifest() as any;
    delete manifest[key];
    const verdict = validateAcquisitionManifest(manifest, T20_POLICY);
    assert.equal(verdict.verdict, 'invalid', `missing ${key} must be invalid`);
  }
});

test('T20: invalid: index_receipt null', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].index_receipt = null;
  const verdict = validateAcquisitionManifest(manifest, T20_POLICY);
  assert.equal(verdict.verdict, 'invalid');
});

// ─── Test: Interop (§8) ──────────────────────────────────────────────────

/**
 * Helper to spawn make_interop_manifest.py and parse the output.
 * Fails (throws/asserts) on any error: helper unavailable, non-zero exit, parse failure.
 */
function spawnInterop(scenario: string): { runDir: string; manifest: AcquisitionManifest } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'interop-'));
  const result = spawnSync('python3', [
    'tools/congress-collector/make_interop_manifest.py',
    tmpDir,
    scenario,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });

  // Assert helper succeeded
  assert.equal(
    result.status,
    0,
    `make_interop_manifest.py ${scenario} failed with exit ${result.status}: ${result.stderr}`
  );

  // Assert stdout is valid JSON
  let output: any;
  try {
    output = JSON.parse(result.stdout);
  } catch (e) {
    throw new Error(`make_interop_manifest.py stdout not JSON: ${result.stdout}`);
  }

  const runDir = output.run_dir;
  assert(runDir, 'make_interop_manifest.py output missing run_dir');

  // Assert manifest.json exists and is readable
  const manifestPath = join(runDir, 'manifest.json');
  let manifestJson: string;
  try {
    manifestJson = readFileSync(manifestPath, 'utf-8');
  } catch (e) {
    throw new Error(`manifest.json not found at ${manifestPath}`);
  }

  // Assert manifest is valid JSON
  let manifest: AcquisitionManifest;
  try {
    manifest = JSON.parse(manifestJson);
  } catch (e) {
    throw new Error(`manifest.json not valid JSON: ${e}`);
  }

  return { runDir, manifest };
}

test('interop: complete scenario → complete verdict with null-months policy', async () => {
  const { runDir, manifest } = spawnInterop('complete');
  try {
    const policy: ValidationPolicy = {
      window: { start: '2025-01-03', end: '2025-01-03' },
      coverageMonths: null,
    };
    const verdict = validateAcquisitionManifest(manifest, policy);
    assert.equal(verdict.verdict, 'complete');
    assert.equal((verdict as any).scope, 'acquisition_only');

    const bodies = verifyResponseBodies(manifest, runDir);
    assert.deepEqual(bodies, []);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('interop: complete manifest with FROZEN_POLICY → invalid', async () => {
  const { runDir, manifest } = spawnInterop('complete');
  try {
    const verdict = validateAcquisitionManifest(manifest, FROZEN_POLICY);
    assert.equal(verdict.verdict, 'invalid');
    assert((verdict as any).problems.length > 0);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('interop: capped scenario → incomplete', async () => {
  const { runDir, manifest } = spawnInterop('capped');
  try {
    const policy: ValidationPolicy = {
      window: { start: '2025-01-03', end: '2025-01-03' },
      coverageMonths: null,
    };
    const verdict = validateAcquisitionManifest(manifest, policy);
    assert.equal(verdict.verdict, 'incomplete');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('interop: http500 scenario → incomplete', async () => {
  const { runDir, manifest } = spawnInterop('http500');
  try {
    const policy: ValidationPolicy = {
      window: { start: '2025-01-03', end: '2025-01-03' },
      coverageMonths: null,
    };
    const verdict = validateAcquisitionManifest(manifest, policy);
    assert.equal(verdict.verdict, 'incomplete');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('interop: vacated scenario → incomplete', async () => {
  const { runDir, manifest } = spawnInterop('vacated');
  try {
    const policy: ValidationPolicy = {
      window: { start: '2025-01-03', end: '2025-01-03' },
      coverageMonths: null,
    };
    const verdict = validateAcquisitionManifest(manifest, policy);
    assert.equal(verdict.verdict, 'incomplete');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('interop: complete manifest with one body byte altered → verifyResponseBodies non-empty', async () => {
  const { runDir, manifest } = spawnInterop('complete');
  try {
    // Find and alter one body file
    assert(
      manifest.records.length > 0 && manifest.records[0].response?.path,
      'complete manifest must have at least one acquired record with response path'
    );
    const bodyPath = join(runDir, manifest.records[0].response.path);
    const content = readFileSync(bodyPath);
    const altered = Buffer.concat([Buffer.from([content[0] ^ 0xff]), content.subarray(1)]);
    writeFileSync(bodyPath, altered);

    const problems = verifyResponseBodies(manifest, runDir);
    assert(problems.length > 0);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('interop: complete manifest with body_complete flipped false → invalid', async () => {
  const { runDir, manifest } = spawnInterop('complete');
  try {
    assert(
      manifest.records.length > 0 && manifest.records[0].response,
      'complete manifest must have at least one acquired record'
    );
    manifest.records[0].response.body_complete = false;

    const policy: ValidationPolicy = {
      window: { start: '2025-01-03', end: '2025-01-03' },
      coverageMonths: null,
    };
    const verdict = validateAcquisitionManifest(manifest, policy);
    assert.equal(verdict.verdict, 'invalid');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('interop: legacy manifest (read-only) → invalid, problem mentions contract', () => {
  const legacyPath = '/home/captainanime/Developer/civiclens-reliability-votes/artifacts/official-house-acquisition/2026-10-07-offline-accounting/manifest.json';

  // Assert file exists and is readable (must not skip)
  let legacyJson: string;
  try {
    legacyJson = readFileSync(legacyPath, 'utf-8');
  } catch (e) {
    throw new Error(`legacy manifest required at ${legacyPath} but not found: ${e}`);
  }

  // Assert JSON is valid
  let legacyManifest: any;
  try {
    legacyManifest = JSON.parse(legacyJson);
  } catch (e) {
    throw new Error(`legacy manifest not valid JSON: ${e}`);
  }

  const policy: ValidationPolicy = {
    window: { start: '2022-09-26', end: '2026-09-26' },
    coverageMonths: 48,
  };
  const verdict = validateAcquisitionManifest(legacyManifest, policy);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
  assert(
    (verdict as any).problems.some((p: string) => p.toLowerCase().includes('contract')),
    'legacy manifest invalid verdict must mention contract issue'
  );
});

// ─── Test: Repair 2026-10-15 RED regressions (manifest contract, SYNTHETIC) ──
// All manifests below are SYNTHETIC, derived from syntheticCompleteManifest().

const REPAIR_POLICY: ValidationPolicy = {
  window: { start: '2025-01-03', end: '2025-01-03' },
  coverageMonths: null,
};

function copyJson(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

/** Turn record[0] (h1) into a non-acquired malformed_source record that keeps its response. */
function malformedH1(manifest: any): void {
  Object.assign(manifest.records[0], {
    outcome: 'malformed_source',
    reason: 'SYNTHETIC malformed body',
  });
  manifest.status = 'incomplete';
  recount(manifest);
}

// 1. Incomplete status with every required row acquired

test('repair: status incomplete with all required rows acquired → incomplete', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.status = 'incomplete';
  recount(manifest);
  const verdict = validateAcquisitionManifest(manifest, REPAIR_POLICY);
  assert.equal(verdict.verdict, 'incomplete');
});

// 2. Excluded-record rules

test('repair: invalid: in-window record changed to excluded_outside_window while attempted with response retained', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.status = 'incomplete';
  Object.assign(manifest.records[0], { outcome: 'excluded_outside_window', metadata: null });
  recount(manifest);
  assert.deepEqual(manifest.counts, { excluded_outside_window: 2 });
  const verdict = validateAcquisitionManifest(manifest, REPAIR_POLICY);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('repair: invalid: in-window unattempted excluded record (attempted false, attempted_at null, response null)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.status = 'incomplete';
  Object.assign(manifest.records[0], {
    outcome: 'excluded_outside_window',
    attempted: false,
    attempted_at: null,
    response: null,
    metadata: null,
  });
  recount(manifest);
  assert.deepEqual(manifest.counts, { excluded_outside_window: 2 });
  const verdict = validateAcquisitionManifest(manifest, REPAIR_POLICY);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('repair: invalid: out-of-window excluded h2 carrying non-null metadata', () => {
  const manifest = syntheticCompleteManifest() as any;
  // Copy h1 metadata but adjust identity fields to h2 so the only defect is
  // non-null metadata on an excluded record.
  manifest.records[1].metadata = {
    ...copyJson(manifest.records[0].metadata),
    key: '119-2025/h2',
    roll: 2,
    date: '2025-01-04',
  };
  const verdict = validateAcquisitionManifest(manifest, REPAIR_POLICY);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('repair: invalid: out-of-window excluded h2 carrying non-null response (control)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[1].response = copyJson(manifest.records[0].response);
  const verdict = validateAcquisitionManifest(manifest, REPAIR_POLICY);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

// 3. Non-null metadata types on NON-acquired records

test('repair: non-acquired malformed_source record with valid metadata stays incomplete (positive control)', () => {
  const manifest = syntheticCompleteManifest() as any;
  malformedH1(manifest);
  const verdict = validateAcquisitionManifest(manifest, REPAIR_POLICY);
  assert.equal(verdict.verdict, 'incomplete');
});

test('repair: invalid: non-acquired record metadata.chamber = "senate"', () => {
  const manifest = syntheticCompleteManifest() as any;
  malformedH1(manifest);
  manifest.records[0].metadata.chamber = 'senate';
  const verdict = validateAcquisitionManifest(manifest, REPAIR_POLICY);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('repair: invalid: non-acquired record metadata.chamber = 42', () => {
  const manifest = syntheticCompleteManifest() as any;
  malformedH1(manifest);
  manifest.records[0].metadata.chamber = 42;
  const verdict = validateAcquisitionManifest(manifest, REPAIR_POLICY);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('repair: invalid: non-acquired record metadata.legis_num = 7', () => {
  const manifest = syntheticCompleteManifest() as any;
  malformedH1(manifest);
  manifest.records[0].metadata.legis_num = 7;
  const verdict = validateAcquisitionManifest(manifest, REPAIR_POLICY);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('repair: non-acquired malformed_source record retaining mismatched string metadata.key stays incomplete (positive control, SYNTHETIC)', () => {
  // metadata.key is still a string, so the declared field type (contract §7) is satisfied.
  // Record-to-metadata identity matching is required only for acquired records; a
  // malformed_source record's observed identity mismatch is preserved as source evidence
  // rather than rejected.
  const manifest = syntheticCompleteManifest() as any;
  malformedH1(manifest);
  manifest.records[0].metadata.key = '119-2025/h2';
  const verdict = validateAcquisitionManifest(manifest, REPAIR_POLICY);
  assert.equal(verdict.verdict, 'incomplete');
  assert.notEqual(verdict.verdict, 'complete');
});

test('repair: invalid: non-acquired record position_tokens do not sum to recorded_vote_count', () => {
  const manifest = syntheticCompleteManifest() as any;
  malformedH1(manifest);
  manifest.records[0].metadata.position_tokens = { 'Present': 433, 'Not Voting': 1 };
  const verdict = validateAcquisitionManifest(manifest, REPAIR_POLICY);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('repair: invalid: acquired record metadata.chamber = "senate" (control)', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].metadata.chamber = 'senate';
  const verdict = validateAcquisitionManifest(manifest, REPAIR_POLICY);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

// 4. Window claims

test('repair: invalid: one-day window claiming window_policy.months 48 under coverageMonths null', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.window_policy.months = 48;
  const verdict = validateAcquisitionManifest(manifest, REPAIR_POLICY);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('repair: invalid: one-day window claiming window_policy.months 1 under coverageMonths null', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.window_policy.months = 1;
  const verdict = validateAcquisitionManifest(manifest, REPAIR_POLICY);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

/**
 * SYNTHETIC frozen-span (48-month) manifest: window 2022-09-26..2026-09-26.
 * h1 stays acquired and in window (2025-01-03); h2 is moved out of the frozen
 * window (2026-09-27) so it remains a valid excluded record.
 */
function syntheticFrozenSpanManifest(months: number | null): any {
  const manifest = syntheticCompleteManifest() as any;
  manifest.window = ['2022-09-26', '2026-09-26'];
  manifest.window_policy = { as_of: '2026-09-26', months };
  manifest.records[1].date = '2026-09-27';
  return manifest;
}

const FROZEN_SPAN_POLICY: ValidationPolicy = {
  window: { start: '2022-09-26', end: '2026-09-26' },
  coverageMonths: null,
};

test('repair: invalid: 48-month frozen span claiming window_policy.months null under coverageMonths null', () => {
  const manifest = syntheticFrozenSpanManifest(null);
  const verdict = validateAcquisitionManifest(manifest, FROZEN_SPAN_POLICY);
  assert.equal(verdict.verdict, 'invalid');
  assert((verdict as any).problems.length > 0);
});

test('repair: 48-month frozen span claiming window_policy.months 48 is not invalid (control)', () => {
  const manifest = syntheticFrozenSpanManifest(48);
  const verdict = validateAcquisitionManifest(manifest, FROZEN_SPAN_POLICY);
  assert.notEqual(verdict.verdict, 'invalid');
});

test('repair: existing one-day months null window stays complete (control)', () => {
  const manifest = syntheticCompleteManifest() as any;
  const verdict = validateAcquisitionManifest(manifest, REPAIR_POLICY);
  assert.equal(verdict.verdict, 'complete');
});

// 5. Never-throw

function assertInvalidWithoutThrow(input: unknown, label: string): void {
  let v: any;
  assert.doesNotThrow(() => {
    v = validateAcquisitionManifest(input, REPAIR_POLICY);
  }, `${label}: validator must not throw`);
  assert.equal(v.verdict, 'invalid', `${label}: must return invalid`);
}

test('never-throw: top-level BigInt input → invalid', () => {
  assertInvalidWithoutThrow(10n, 'top-level bigint');
});

test('never-throw: top-level Symbol input → invalid', () => {
  assertInvalidWithoutThrow(Symbol('s'), 'top-level symbol');
});

test('never-throw: top-level circular object → invalid', () => {
  const circular: any = {};
  circular.self = circular;
  assertInvalidWithoutThrow(circular, 'top-level circular object');
});

test('never-throw: circular manifest.contract = manifest → invalid', () => {
  // SYNTHETIC: circular value in a validated top-level diagnostic field.
  const manifest = syntheticCompleteManifest() as any;
  manifest.contract = manifest;
  assertInvalidWithoutThrow(manifest, 'circular manifest.contract');
});

test('never-throw: manifest.contract = 10n → invalid', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.contract = 10n;
  assertInvalidWithoutThrow(manifest, 'contract bigint');
});

test('never-throw: manifest.status = Symbol → invalid', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.status = Symbol('x');
  assertInvalidWithoutThrow(manifest, 'status symbol');
});

test('never-throw: records[0].outcome = 10n → invalid', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].outcome = 10n;
  assertInvalidWithoutThrow(manifest, 'outcome bigint');
});

test('never-throw: records[0].reason = Symbol → invalid', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].reason = Symbol('r');
  assertInvalidWithoutThrow(manifest, 'reason symbol');
});

test('never-throw: records[0].metadata.chamber = Symbol → invalid', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.records[0].metadata.chamber = Symbol('c');
  assertInvalidWithoutThrow(manifest, 'metadata.chamber symbol');
});

test('never-throw: records[0].key = circular object → invalid', () => {
  const manifest = syntheticCompleteManifest() as any;
  const circularKey: any = {};
  circularKey.self = circularKey;
  manifest.records[0].key = circularKey;
  assertInvalidWithoutThrow(manifest, 'key circular object');
});

test('never-throw: counts.acquired = 1n → invalid', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.counts.acquired = 1n;
  assertInvalidWithoutThrow(manifest, 'counts bigint');
});

test('never-throw: window_policy.months = 48n → invalid', () => {
  const manifest = syntheticCompleteManifest() as any;
  manifest.window_policy.months = 48n;
  assertInvalidWithoutThrow(manifest, 'window_policy.months bigint');
});

// 6. Actual adapter-emitted interrupted snapshot (no hand-built manifest, no HTTP)

/**
 * SYNTHETIC: builds a three-roll listing packet via test_adapter.packet_at, moves
 * roll 3 to Jan 4 (outside the one-day window), then runs adapter.acquire with a
 * fetch that raises KeyboardInterrupt on the first attempt.
 */
const INTERRUPTED_SNAPSHOT_SCRIPT = `
import json
import sys
from pathlib import Path

sys.path.insert(0, 'tools/congress-collector')
import adapter
from test_adapter import packet_at, save_packet, digest

root = Path(sys.argv[1])
src = root / 'source'
src.mkdir()
packet_at(src, count=3, window=('2025-01-03', '2025-01-03'))
inv_path = src / 'inventory.json'
packet = json.loads(inv_path.read_text())
receipt = packet['receipts'][0]
page = src / receipt['path']
body = page.read_bytes()
stamp = b'Jan 3, 2025, 12:33 PM'
start = body.index(b'/Votes/20253?')
at = body.index(stamp, start)
body = body[:at] + b'Jan 4, 2025, 12:33 PM' + body[at + len(stamp):]
page.write_bytes(body)
receipt['sha256'] = digest(body)
row = next(r for r in packet['inventory'] if r['roll'] == 3)
row['date'] = '2025-01-04'
packet['summary'][0]['window_total'] = 2
packet['window_total'] = 2
inv_path, sha = save_packet(src, packet)
inv = adapter.validate_inventory(inv_path, sha)

def fetch(url):
    raise KeyboardInterrupt()

try:
    adapter.acquire(inv, root / 'run', fetch=fetch)
except KeyboardInterrupt:
    pass
print(json.dumps({'manifest_path': str(root / 'run' / 'manifest.json')}))
`;

test('interop: actual adapter interrupted snapshot → incomplete with pending and excluded counts', () => {
  const root = mkdtempSync(join(tmpdir(), 'interrupted-snapshot-'));
  try {
    const result = spawnSync('python3', ['-c', INTERRUPTED_SNAPSHOT_SCRIPT, root], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      timeout: 30000,
    });
    assert.equal(result.status, 0, `interrupted snapshot script failed with exit ${result.status}: ${result.stderr}`);

    let output: any;
    try {
      output = JSON.parse(result.stdout);
    } catch (e) {
      throw new Error(`interrupted snapshot stdout not JSON: ${result.stdout}`);
    }
    assert(output.manifest_path, 'interrupted snapshot output missing manifest_path');

    const manifest: any = JSON.parse(readFileSync(output.manifest_path, 'utf-8'));
    assert.equal(manifest.status, 'running');
    assert.equal(manifest.attempted_rolls, 0);
    assert.deepEqual(manifest.counts, { pending: 2, excluded_outside_window: 1 });

    const byRoll = (n: number): any => manifest.records.find((r: any) => r.roll === n);

    const roll3 = byRoll(3);
    assert.equal(roll3.outcome, 'excluded_outside_window');
    assert.equal(roll3.attempted, false);
    assert.equal(roll3.response, null);
    assert.equal(roll3.metadata, null);

    for (const n of [1, 2]) {
      const r = byRoll(n);
      assert.equal(r.outcome, 'pending', `roll ${n} must be pending`);
      assert.equal(r.attempted, false, `roll ${n} must be unattempted`);
    }

    const verdict = validateAcquisitionManifest(manifest, {
      window: { start: '2025-01-03', end: '2025-01-03' },
      coverageMonths: null,
    });
    assert.equal(verdict.verdict, 'incomplete');
    assert.deepEqual((verdict as any).counts, { pending: 2, excluded_outside_window: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
