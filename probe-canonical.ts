import { getDb } from './db/init.js';
const conn = await getDb();
async function q(sql: string, params: any[] = []) { return await (await conn.run(sql, params)).getRowObjects(); }

console.log('=== bill_committees rows total ===');
console.log(await q(`SELECT count(*) AS n FROM bill_committees`));

console.log('\n=== bill_committees committee_canonical distribution ===');
console.log(await q(`SELECT committee_canonical IS NULL AS is_null, count(*) AS n FROM bill_committees GROUP BY 1`));

console.log('\n=== sample bill_committees ===');
console.log(await q(`SELECT bill_id, committee_name, committee_canonical FROM bill_committees LIMIT 10`));

console.log('\n=== committees committee_canonical distribution ===');
console.log(await q(`SELECT committee_canonical IS NULL AS is_null, count(*) AS n FROM committees GROUP BY 1`));

console.log('\n=== sample committees ===');
console.log(await q(`SELECT member_id, committee_name, committee_canonical FROM committees LIMIT 10`));

console.log('\n=== overlap (any matching canonicals?) ===');
console.log(await q(`
  SELECT count(DISTINCT bc.committee_canonical) AS shared_canonicals
  FROM bill_committees bc
  JOIN committees c ON c.committee_canonical = bc.committee_canonical
`));

console.log('\n=== distinct canonicals on each side ===');
console.log(await q(`SELECT 'bill_committees' AS side, count(DISTINCT committee_canonical) AS distinct_n FROM bill_committees UNION ALL SELECT 'committees', count(DISTINCT committee_canonical) FROM committees`));

console.log('\n=== top 10 distinct canonicals on each side ===');
console.log('-- bill_committees --');
console.log(await q(`SELECT committee_canonical, count(*) AS n FROM bill_committees GROUP BY 1 ORDER BY n DESC LIMIT 10`));
console.log('-- committees --');
console.log(await q(`SELECT committee_canonical, count(*) AS n FROM committees GROUP BY 1 ORDER BY n DESC LIMIT 10`));

process.exit(0);
