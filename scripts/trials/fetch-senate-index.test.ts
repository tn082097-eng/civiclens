import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPtrRefs } from './fetch-senate-index.js';

test('extractPtrRefs counts only PTR links and preserves authoritative ids and dates', () => {
  const response = {
    result: 'ok',
    data: [
      ['Jerry', 'Moran', 'Senator', '<a href="/search/view/ptr/11111111-1111-1111-1111-111111111111/">PTR</a>', '08/01/2026'],
      ['Jerry', 'Moran', 'Senator', '<a href="/search/view/annual/ignored/">Annual</a>', '07/01/2026'],
    ],
  };
  assert.deepEqual(extractPtrRefs(response), [{
    id: '11111111-1111-1111-1111-111111111111',
    dateReceived: '08/01/2026',
  }]);
});

test('extractPtrRefs rejects a non-ok EFDS payload', () => {
  assert.throws(() => extractPtrRefs({ result: 'error', data: [] }), /result/i);
});
