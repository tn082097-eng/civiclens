// The removed GovTrack pagination API is superseded by official acquisition.
// SYNTHETIC failures verify that the public consumer never rescues partial work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectOfficialVotes } from './fetch.js';
import { OfficialVoteFailure } from '../../lib/official-vote-types.js';
for (const [stage, code] of [['acquisition', 'incomplete_fetch'], ['collector', 'cross_check_mismatch'], ['identity', 'member_never_recorded'], ['coverage', 'incomplete_window']] as const) {
  test(`official consumer propagates ${stage}/${code} without partial or empty success`, async () => {
    const failure = new OfficialVoteFailure(stage, code, 'synthetic source failure');
    await assert.rejects(() => collectOfficialVotes('X000001', 'house', '2026-10-16', async () => { throw failure; }), error => error === failure);
  });
}
