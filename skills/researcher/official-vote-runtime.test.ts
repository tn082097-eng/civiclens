/** Runtime-glue controls; no live acquisition or production DB access. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchOfficialMemberVotes, resolveOfficialRolls } from './official-vote-runtime.js';
import { OfficialVoteFailure } from '../../lib/official-vote-types.js';

test('member runtime rejects malformed identity before any acquisition', async () => {
  await assert.rejects(
    fetchOfficialMemberVotes({ bioguideId: '../bad', chamber: 'house', asOf: '2026-10-16', source: { mode: 'live' } }),
    (error: unknown) => error instanceof OfficialVoteFailure && error.code === 'invalid_member',
  );
});

test('member runtime rejects an impossible as-of date before acquisition', async () => {
  await assert.rejects(
    fetchOfficialMemberVotes({ bioguideId: 'H001047', chamber: 'house', asOf: '2026-02-30', source: { mode: 'live' } }),
    (error: unknown) => error instanceof OfficialVoteFailure && error.code === 'invalid_window',
  );
});

test('missing prepared acquisition is a failure, never empty member votes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'official-runtime-control-'));
  try {
    await assert.rejects(
      fetchOfficialMemberVotes({ bioguideId: 'H001047', chamber: 'house', asOf: '2026-10-16', source: { mode: 'prepared', runDir: join(root, 'missing') } }),
      (error: unknown) => error instanceof OfficialVoteFailure && error.stage === 'acquisition',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy official resolution refuses empty or contradictory input before acquisition', async () => {
  await assert.rejects(resolveOfficialRolls([], { source: { mode: 'live' } }),
    (error: unknown) => error instanceof OfficialVoteFailure && error.code === 'empty_rolls');
  await assert.rejects(resolveOfficialRolls([
    { key: '119-2025/h6', date: '2025-01-07' },
    { key: '119-2025/h6', date: '2025-01-08' },
  ], { source: { mode: 'live' } }),
  (error: unknown) => error instanceof OfficialVoteFailure && error.code === 'conflicting_roll_date');
});
