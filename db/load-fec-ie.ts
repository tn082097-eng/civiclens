/**
 * Super PAC independent-expenditure loader. Persists what lib/fec-ie.ts
 * fetches live (FEC Schedule E) into DuckDB so the Pattern Discovery
 * contract's CitedRow.kind = 'ie' has a substrate to cite.
 *
 * One pass per member with a resolved members.fec_candidate_id. Aggregates
 * land in super_pac_ie; itemized filings (the clickable rows) in
 * super_pac_ie_filings. "Latest fetch wins": each (member, cycle) is wiped
 * and reinserted, matching the pfd_transactions semantics.
 *
 * Usage:
 *   npx tsx db/load-fec-ie.ts 2024
 *   npx tsx db/load-fec-ie.ts 2022,2024 --dry-run
 *   npx tsx agents/pipeline.ts --load-fec-ie 2024 [--dry-run]
 *
 * Members with no IE are normal (most have none) — they are not errors.
 * Exit codes: 0 on success (incl. zero-IE members); 1 if any member's FEC
 * fetch errored (so cron retries); 2 on fatal.
 *
 * See SOURCES.md → "FEC OpenFEC API". Schema lives in db/schema.sql.
 */

import { applySchema, getDb } from './init.js';
import { fetchSuperPacIE } from '../lib/fec-ie.js';
import type { SuperPacIEReport } from '../lib/types.js';

interface MemberRef {
  memberId: string;
  candidateId: string;
}

interface MemberResult {
  memberId: string;
  candidateId: string;
  aggregates: number;
  filings: number;
  totalSupporting: number;
  totalOpposing: number;
  error?: string;
}

async function membersWithFec(): Promise<MemberRef[]> {
  const conn = await getDb();
  const r = await conn.run(
    `SELECT member_id, fec_candidate_id
       FROM members
      WHERE fec_candidate_id IS NOT NULL AND fec_candidate_id <> ''
      ORDER BY member_id`,
  );
  const rows = await r.getRowObjects();
  return rows.map((row: any) => ({
    memberId: String(row.member_id),
    candidateId: String(row.fec_candidate_id),
  }));
}

async function loadMemberCycle(
  m: MemberRef,
  cycle: number,
  opts: { dryRun?: boolean },
): Promise<MemberResult> {
  const res: MemberResult = {
    memberId: m.memberId,
    candidateId: m.candidateId,
    aggregates: 0,
    filings: 0,
    totalSupporting: 0,
    totalOpposing: 0,
  };

  let report: SuperPacIEReport;
  try {
    report = await fetchSuperPacIE(m.candidateId, cycle, { itemized: true });
  } catch (e: any) {
    res.error = e?.message ?? String(e);
    return res;
  }

  res.totalSupporting = report.totalSupporting;
  res.totalOpposing = report.totalOpposing;
  const aggregates = [...report.supporting, ...report.opposing];
  const filings = report.filings ?? [];
  res.aggregates = aggregates.length;
  res.filings = filings.length;

  if (opts.dryRun) return res;

  const conn = await getDb();
  const fetchedAt = report.fetchedAt ?? new Date().toISOString();

  await conn.run(
    `DELETE FROM super_pac_ie WHERE member_id = ? AND cycle = ?`,
    [m.memberId, cycle],
  );
  await conn.run(
    `DELETE FROM super_pac_ie_filings WHERE member_id = ? AND cycle = ?`,
    [m.memberId, cycle],
  );

  for (const a of aggregates) {
    await conn.run(
      `INSERT INTO super_pac_ie
       (member_id, candidate_id, cycle, committee_id, committee_name,
        committee_type, designation, party, support_oppose,
        total_amount, filing_count, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        m.memberId, m.candidateId, cycle,
        a.committeeId ?? null, a.committeeName ?? null,
        a.committeeType ?? null, a.designation ?? null, a.party ?? null,
        a.supportOppose, a.totalAmount, a.count, fetchedAt,
      ],
    );
  }

  for (const f of filings) {
    await conn.run(
      `INSERT INTO super_pac_ie_filings
       (transaction_id, member_id, candidate_id, cycle, committee_id,
        committee_name, support_oppose, amount, expenditure_date,
        disbursement_date, description, payee_name, election_type,
        report_year, pdf_url, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        f.transactionId, m.memberId, m.candidateId, cycle,
        f.committeeId ?? null, f.committeeName ?? null, f.supportOppose,
        f.amount, f.expenditureDate ?? null, f.disbursementDate ?? null,
        f.description ?? null, f.payeeName ?? null, f.electionType ?? null,
        f.reportYear ?? null, f.pdfUrl ?? null, fetchedAt,
      ],
    );
  }

  return res;
}

export async function loadFecIe(
  cycles: number[],
  opts: { dryRun?: boolean } = {},
): Promise<{ results: MemberResult[]; errored: number }> {
  await applySchema();
  const members = await membersWithFec();
  const results: MemberResult[] = [];

  for (const cycle of cycles) {
    console.log(
      `\nLoading FEC IE for ${members.length} member(s), cycle ${cycle}` +
      `${opts.dryRun ? ' (dry-run — DB unchanged)' : ''}…`,
    );
    for (const m of members) {
      const r = await loadMemberCycle(m, cycle, opts);
      results.push(r);
    }
  }

  const errored = results.filter(r => r.error).length;
  return { results, errored };
}

function printSummary(results: MemberResult[]): void {
  const nameW = Math.max(20, ...results.map(r => r.memberId.length));
  const line = '─'.repeat(nameW + 56);
  console.log(line);
  console.log(
    `${'member'.padEnd(nameW)}  ${'agg'.padStart(4)}  ${'filings'.padStart(7)}  ` +
    `${'support $'.padStart(13)}  ${'oppose $'.padStart(13)}`,
  );
  console.log(line);
  for (const r of results) {
    if (r.error) {
      console.log(`${r.memberId.padEnd(nameW)}  ERROR  ${r.error.slice(0, 50)}`);
      continue;
    }
    if (r.aggregates === 0) continue; // skip the (common) no-IE members
    console.log(
      `${r.memberId.padEnd(nameW)}  ${String(r.aggregates).padStart(4)}  ` +
      `${String(r.filings).padStart(7)}  ` +
      `${r.totalSupporting.toLocaleString().padStart(13)}  ` +
      `${r.totalOpposing.toLocaleString().padStart(13)}`,
    );
  }
  console.log(line);
  const withIe = results.filter(r => !r.error && r.aggregates > 0).length;
  const errored = results.filter(r => r.error).length;
  console.log(
    `${results.length} member-cycle row(s): ${withIe} with IE, ` +
    `${results.length - withIe - errored} none, ${errored} errored`,
  );
}

export function parseArgs(argv: string[]): { cycles: number[]; dryRun: boolean } {
  let dryRun = false;
  const cycles: number[] = [];
  for (const a of argv) {
    if (a === '--dry-run') { dryRun = true; continue; }
    for (const part of a.split(',')) {
      const n = parseInt(part.trim(), 10);
      if (Number.isFinite(n)) cycles.push(n);
    }
  }
  return { cycles: cycles.length ? cycles : [2024], dryRun };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const { cycles, dryRun } = parseArgs(process.argv.slice(2));
    const { results, errored } = await loadFecIe(cycles, { dryRun });
    printSummary(results);
    process.exit(errored > 0 ? 1 : 0);
  })().catch(e => {
    console.error(`\nFatal: ${e?.message ?? e}`);
    process.exit(2);
  });
}
