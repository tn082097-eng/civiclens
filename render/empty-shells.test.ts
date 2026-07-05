import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revolvingEmptyShell, outsideSpendingEmptyShell } from './empty-shells.js';

test('revolving empty shell is present with neutral copy and the id', () => {
  const html = revolvingEmptyShell();
  assert.match(html, /id="sec-revolving"/);
  assert.match(html, /no disclosed revolving-door lobbyist ties/i);
  assert.doesNotMatch(html, /suspicious|clean|guilty/i);
});

test('outside-spending shell distinguishes unavailable from empty', () => {
  assert.match(outsideSpendingEmptyShell('no-fec-id'), /id="sec-outside-spending"/);
  assert.match(outsideSpendingEmptyShell('no-fec-id'), /unavailable — no FEC candidate id/i);
  assert.match(outsideSpendingEmptyShell('no-ie'), /no independent-expenditure spending/i);
});
