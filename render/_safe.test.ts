import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeJson } from './build.js';

test('safeJson neutralizes </script> breakout', () => {
  const out = safeJson({ x: '</script><script>alert(1)</script>' });
  assert.ok(!out.includes('<'), 'no literal < may survive');
  assert.ok(!out.includes('>'), 'no literal > may survive');
  // Must still parse back to the original value
  assert.deepEqual(JSON.parse(out), { x: '</script><script>alert(1)</script>' });
});

test('safeJson neutralizes HTML-comment open', () => {
  const out = safeJson({ x: '<!-- sneaky' });
  assert.ok(!out.includes('<!--'));
  assert.deepEqual(JSON.parse(out), { x: '<!-- sneaky' });
});

test('safeJson escapes U+2028/U+2029 line separators', () => {
  const out = safeJson({ x: 'a\u2028b\u2029c' });
  assert.ok(!out.includes('\u2028'), 'no raw U+2028');
  assert.ok(!out.includes('\u2029'), 'no raw U+2029');
  assert.deepEqual(JSON.parse(out), { x: 'a\u2028b\u2029c' });
});

test('safeJson is identity for clean data', () => {
  assert.equal(safeJson({ a: 1, b: 'x' }), '{"a":1,"b":"x"}');
});
