import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchGovTrackVotes } from './fetch.js';

function page() { return Array.from({length:100}, (_,i) => ({id:i,created:`2026-08-01T12:${String(59-Math.floor(i/2)).padStart(2,'0')}:${i%2?'00':'30'}`})); }

test('vote pagination propagates an exhausted later-page failure instead of returning partial votes', async () => {
  let calls=0;
  await assert.rejects(() => fetchGovTrackVotes(1, 300, '2023-01-01', async () => {
    if (++calls === 1) return {objects:page()};
    throw new Error('upstream unavailable');
  }), /upstream unavailable/);
});

test('vote pagination rejects a non-advancing cursor', async () => {
  await assert.rejects(() => fetchGovTrackVotes(1,300,'2023-01-01',async () => ({objects:page()})), /cursor|duplicate/);
});

test('vote pagination cannot report an exhausted safety cap as a complete date window', async () => {
  await assert.rejects(() => fetchGovTrackVotes(1,100,'2023-01-01',async () => ({objects:page()})), /cap|incomplete/);
});

test('vote pagination requires an objects array, not a missing-result empty success', async () => {
  await assert.rejects(() => fetchGovTrackVotes(1,100,'2023-01-01',async () => ({})), /objects|malformed/);
});

test('a successful empty page closes pagination and retains earlier rows', async () => {
  let calls=0;
  const rows = await fetchGovTrackVotes(1,300,'2023-01-01',async () => ({objects:++calls===1?page():[]}));
  assert.equal(rows.length,100); assert.equal(calls,2);
});
