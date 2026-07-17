// db/load-recipient-ticker.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfirmTsv } from './load-recipient-ticker.js';

const HEADER = 'recipient_key\trecipient_name\tticker\tbasis\tevidence\tconfirmed_at\n';

test('parses a valid row', () => {
  const { rows, errors } = parseConfirmTsv(
    HEADER + 'abc-123-C\tNICE SYSTEMS INC\tNICE\town-name\tSEC issuer NICE Ltd. (CIK 1003935); NICE Systems Inc is its US subsidiary per 20-F\t2026-07-17\n',
  );
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    recipientKey: 'abc-123-C', recipientName: 'NICE SYSTEMS INC', ticker: 'NICE',
    basis: 'own-name',
    evidence: 'SEC issuer NICE Ltd. (CIK 1003935); NICE Systems Inc is its US subsidiary per 20-F',
    confirmedAt: '2026-07-17',
  });
});

test('rejects: bad column count, empty evidence, bad basis, lowercase ticker, bad date, dup key', () => {
  const bad = HEADER
    + 'k1\tX\tAAA\town-name\tshort but fine evidence row\t2026-07-17\n'
    + 'k2\tY\tBBB\tguessy\tsome evidence text here\t2026-07-17\n'      // bad basis
    + 'k3\tZ\tccc\tmanual\tsome evidence text here\t2026-07-17\n'      // lowercase ticker
    + 'k4\tW\tDDD\tmanual\t\t2026-07-17\n'                              // empty evidence
    + 'k5\tV\tEEE\tmanual\tsome evidence text here\tJuly 17\n'          // bad date
    + 'k1\tX2\tFFF\tmanual\tsome evidence text here\t2026-07-17\n'      // dup key
    + 'k6\tU\tGGG\tmanual\n';                                           // bad column count
  const { rows, errors } = parseConfirmTsv(bad);
  assert.equal(rows.length, 1);
  assert.equal(errors.length, 6);
});

test('header-only file parses to zero rows, zero errors', () => {
  const { rows, errors } = parseConfirmTsv(HEADER);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 0);
});
