import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDonorThemeCitation, SPONSORED_SQL } from './donor-sector-vote-alignment.js';
import { tempDb } from '../../db/__testkit__/temp-db.js';

test('donor evidence publishes one CivicLens theme summary without raw industry labels', () => {
  const citations = buildDonorThemeCitation('jane-doe', 'Banks & Finance', [
    { industry: 'Hedge Funds', total: 1_500_000 },
    { industry: 'Private Equity & Investment Firms', total: 980_146 },
    { industry: 'Commercial Banks', total: 300_000 },
  ]);

  assert.deepEqual(citations, [{
    kind: 'donor',
    id: 'jane-doe|Banks & Finance',
    label: 'Banks & Finance — 3 contributing industries ($2,780,146)',
  }]);
  assert.doesNotMatch(JSON.stringify(citations), /Hedge Funds|Private Equity|Commercial Banks/);
});

test('donor evidence uses a singular industry label', () => {
  assert.deepEqual(
    buildDonorThemeCitation('jane-doe', 'Energy', [
      { industry: 'Oil & Gas', total: 125_000 },
    ]),
    [{
      kind: 'donor',
      id: 'jane-doe|Energy',
      label: 'Energy — 1 contributing industry ($125,000)',
    }],
  );
});

test('sponsored focused bills come back in one total order, whatever the insertion order', async () => {
  const bills = [
    ['119/hr/10', 'Older Housing Act', '2025-02-01'],
    ['119/hr/30', 'Newest Housing Act', '2026-03-01'],
    ['119/hr/20', 'Tied Housing Act B', '2025-06-01'],
    ['119/hr/19', 'Tied Housing Act A', '2025-06-01'],
    ['119/hr/40', 'Undated Housing Act', null],
  ] as const;
  const read = async (order: readonly (typeof bills)[number][]) => {
    const { conn, cleanup } = await tempDb();
    try {
      await conn.run(`INSERT INTO theme_bill_match VALUES ('Housing', 'Housing and Community Development', NULL)`);
      for (const [id, title, date] of order) {
        await conn.run(`INSERT INTO bills (member_id, bill_id, title, sponsor_role, introduced_at, fetched_at)
          VALUES ('jane-doe', ?, ?, 'sponsor', ?::DATE, TIMESTAMP '2026-01-01')`, [id, title, date]);
        await conn.run(`INSERT INTO bill_subjects (bill_id, policy_area, subject, fetched_at)
          VALUES (?, 'Housing and Community Development', 'Housing', TIMESTAMP '2026-01-01')`, [id.replaceAll('/', '-')]);
      }
      const rows = await (await conn.run(SPONSORED_SQL, ['jane-doe'])).getRowObjects();
      return rows.map(r => String(r.bill_id));
    } finally { cleanup(); }
  };
  const expected = ['119/hr/30', '119/hr/19', '119/hr/20', '119/hr/10', '119/hr/40'];
  assert.deepEqual(await read(bills), expected);
  assert.deepEqual(await read([...bills].reverse()), expected);
});
