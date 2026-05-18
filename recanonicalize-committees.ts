/**
 * Re-apply committeeCanonical() to all rows in `committees` and `bill_committees`.
 * Needed after fixing the canonicalizer to strip leading "the " (e.g. "the judiciary" → "judiciary").
 */
import { getDb } from './db/init.js';
import { committeeCanonical } from './db/load-bill-committees.js';

const conn = await getDb();
async function q(sql: string, params: any[] = []) {
  return await (await conn.run(sql, params)).getRowObjects();
}

await conn.run('BEGIN');
try {
  // committees: keyed on (member_id, committee_name)
  const cRows = await q(`SELECT member_id, committee_name, committee_canonical FROM committees`);
  let cChanged = 0;
  for (const row of cRows as any[]) {
    const canon = committeeCanonical(String(row.committee_name));
    if (canon !== row.committee_canonical) {
      await conn.run(
        `UPDATE committees SET committee_canonical = ? WHERE member_id = ? AND committee_name = ?`,
        [canon, String(row.member_id), String(row.committee_name)],
      );
      cChanged++;
    }
  }
  console.log(`committees: ${cChanged}/${cRows.length} rows re-canonicalized`);

  // bill_committees: keyed on (bill_id, committee_code)
  const bRows = await q(`SELECT bill_id, committee_code, committee_name, committee_canonical FROM bill_committees`);
  let bChanged = 0;
  for (const row of bRows as any[]) {
    const canon = committeeCanonical(String(row.committee_name));
    if (canon !== row.committee_canonical) {
      await conn.run(
        `UPDATE bill_committees SET committee_canonical = ? WHERE bill_id = ? AND committee_code = ?`,
        [canon, String(row.bill_id), String(row.committee_code)],
      );
      bChanged++;
    }
  }
  console.log(`bill_committees: ${bChanged}/${bRows.length} rows re-canonicalized`);

  await conn.run('COMMIT');
} catch (e) {
  await conn.run('ROLLBACK');
  console.error('FAILED, rolled back:', e);
  process.exit(1);
}

console.log('\n=== verification: shared canonicals ===');
console.log(await q(`
  SELECT count(DISTINCT bc.committee_canonical) AS shared_canonicals
  FROM bill_committees bc
  JOIN committees c ON c.committee_canonical = bc.committee_canonical
`));

console.log('\n=== member_on_bill_committee = TRUE rows in v_trades_near_votes ===');
console.log(await q(`SELECT count(*) AS n FROM v_trades_near_votes WHERE member_on_bill_committee = TRUE`));

process.exit(0);
