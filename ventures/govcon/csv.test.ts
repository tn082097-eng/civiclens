import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, CsvStreamParser } from './csv.ts';

test('parses simple rows', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2,3\n'), [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('keeps commas inside quoted fields', () => {
  assert.deepEqual(parseCsv('"Smith, John",42\n'), [['Smith, John', '42']]);
});

test('unescapes doubled quotes', () => {
  assert.deepEqual(parseCsv('"he said ""hi""",x\n'), [['he said "hi"', 'x']]);
});

test('keeps raw newlines inside quoted fields', () => {
  // This is the case that a line-splitting parser silently corrupts.
  assert.deepEqual(parseCsv('"line one\nline two",end\n'), [['line one\nline two', 'end']]);
});

test('handles CRLF line endings', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
});

test('preserves empty fields including trailing ones', () => {
  assert.deepEqual(parseCsv('a,,c,\n'), [['a', '', 'c', '']]);
});

test('flushes a final row with no trailing newline', () => {
  assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
});

test('skips blank lines', () => {
  assert.deepEqual(parseCsv('a,b\n\n1,2\n'), [['a', 'b'], ['1', '2']]);
});

test('is independent of chunk boundaries', () => {
  const text = '"a,1","b\n2","c""3"\nx,y,z\n';
  const whole = parseCsv(text);
  for (const size of [1, 2, 3, 5, 7, 11]) {
    const rows: string[][] = [];
    const p = new CsvStreamParser((r) => rows.push(r));
    for (let i = 0; i < text.length; i += size) p.write(text.slice(i, i + size));
    p.end();
    assert.deepEqual(rows, whole, `chunk size ${size} changed the result`);
  }
});

test('parses a real SAM.gov extract header and row', () => {
  // Captured verbatim from the GitHub Actions probe against the live
  // ContractOpportunitiesFullCSV.csv, so the shape is observed, not assumed.
  const header =
    '"NoticeId","Title","Sol#","Department/Ind.Agency","CGAC","Sub-Tier","FPDS Code","Office","AAC Code","PostedDate","Type","BaseType","ArchiveType","ArchiveDate","SetASideCode","SetASide","ResponseDeadLine","NaicsCode","ClassificationCode","PopStreetAddress","PopCity","PopState","PopZip","PopCountry","Active","AwardNumber","AwardDate","Award$","Awardee","PrimaryContactTitle","PrimaryContactFullname","PrimaryContactEmail","PrimaryContactPhone","PrimaryContactFax","SecondaryContactTitle","SecondaryContactFullname","SecondaryContactEmail","SecondaryContactPhone","SecondaryContactFax","OrganizationType","State","City","ZipCode","CountryCode","AdditionalInfoLink","Link","Description"';
  const row =
    '"91935ee1d73547489572a8e4dc3f7bba","Grapevine Fire BAR - Fence Repair & Tank Cleanout","127EAV26Q0123","AGRICULTURE, DEPARTMENT OF","012","FOREST SERVICE","12C2","Southwestern Regional Office, Region 3","128371","2026-09-20 14:19:35","Solicitation","Solicitation","auto15","2026-10-09","SBA","Small Business Set Aside - Total","2026-09-24T09:00:00-06:00","238990","Z2PZ","","Prescott","AZ","86322","USA","Yes","","","","","","David Watson","david.l.watson@usda.gov","4802049319","","","","","","","OFFICE","NM","ALB","87102","USA","","https://sam.gov/opp/x","desc"';

  const rows = parseCsv(`${header}\n${row}\n`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].length, 47, 'header column count');
  assert.equal(rows[1].length, rows[0].length, 'row must align with header');

  const rec = Object.fromEntries(rows[0].map((h, i) => [h, rows[1][i]]));
  // The agency name contains a comma — the whole point of quoting.
  assert.equal(rec['Department/Ind.Agency'], 'AGRICULTURE, DEPARTMENT OF');
  assert.equal(rec['NaicsCode'], '238990');
  assert.equal(rec['SetASide'], 'Small Business Set Aside - Total');
  assert.equal(rec['ResponseDeadLine'], '2026-09-24T09:00:00-06:00');
  assert.equal(rec['PopState'], 'AZ');
  assert.equal(rec['Active'], 'Yes');
});
