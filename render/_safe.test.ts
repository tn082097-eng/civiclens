import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, safeJson, safeUrl, memberHref } from './build.js';

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

test('safeUrl allows http/https absolute URLs unchanged', () => {
  assert.equal(safeUrl('https://www.fec.gov/data/x'), 'https://www.fec.gov/data/x');
  assert.equal(safeUrl('http://clerk.house.gov/y'), 'http://clerk.house.gov/y');
});

test('safeUrl allows same-page anchors', () => {
  assert.equal(safeUrl('#sec-trades'), '#sec-trades');
});

test('safeUrl rejects dangerous or malformed schemes', () => {
  assert.equal(safeUrl('javascript:alert(1)'), '#');
  assert.equal(safeUrl('JaVaScRiPt:alert(1)'), '#');
  assert.equal(safeUrl('data:text/html,<script>alert(1)</script>'), '#');
  assert.equal(safeUrl('vbscript:msgbox(1)'), '#');
  assert.equal(safeUrl('//evil.example.com/x'), '#');           // protocol-relative
  assert.equal(safeUrl(' javascript:alert(1)'), '#');           // leading space
  assert.equal(safeUrl('java\nscript:alert(1)'), '#');          // embedded newline
});

test('safeUrl falls back on null/undefined/empty', () => {
  assert.equal(safeUrl(null), '#');
  assert.equal(safeUrl(undefined), '#');
  assert.equal(safeUrl(''), '#');
});

test('safeUrl passes # fallback values through', () => {
  // call sites use `x ?? '#'`; '#' itself must survive
  assert.equal(safeUrl('#'), '#');
});

test('memberHref builds .html links only from clean slugs', () => {
  assert.equal(memberHref('nancy-pelosi'), 'nancy-pelosi.html');
  assert.equal(memberHref('mtg-greene14', 'members/'), 'members/mtg-greene14.html');
  assert.equal(memberHref('../../etc/passwd'), '#');
  assert.equal(memberHref('a"onmouseover="x'), '#');
  assert.equal(memberHref(null), '#');
});

test('esc(safeUrl(x)) pairing neutralizes attribute breakout in a valid URL', () => {
  // an http URL is allowed through safeUrl; esc must still neutralize the quote
  const out = esc(safeUrl('https://example.com/"><img src=x onerror=alert(1)>'));
  assert.ok(!out.includes('"'), 'no raw double-quote may reach the attribute');
  assert.ok(!out.includes('<') && !out.includes('>'), 'no raw angle brackets');
});
