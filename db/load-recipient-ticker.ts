/**
 * Loads the HAND-CURATED recipient→ticker confirm table from
 * data/recipient_ticker.tsv into recipient_ticker. This is the ONLY code
 * path that writes that table. Curation policy (spec §Identity resolution):
 * objective identity evidence only — SEC issuer identity, SAM.gov parent,
 * publicly verifiable ownership — never interestingness; every row cites
 * evidence. Full-replace semantics: the TSV is the source of record.
 *
 * Usage: npx tsx db/load-recipient-ticker.ts [--dry-run]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySchema, getDb } from './init.js';
import { DATA_DIR } from '../lib/paths.js';

const TSV_PATH = join(DATA_DIR, 'recipient_ticker.tsv');
const EXPECTED_HEADER = 'recipient_key\trecipient_name\tticker\tbasis\tevidence\tconfirmed_at';
const BASES = new Set(['own-name', 'parent-name', 'manual']);

export interface ParsedConfirm {
  recipientKey: string; recipientName: string; ticker: string;
  basis: 'own-name' | 'parent-name' | 'manual'; evidence: string; confirmedAt: string;
}

export function parseConfirmTsv(text: string): { rows: ParsedConfirm[]; errors: string[] } {
  const lines = text.split('\n').filter((l) => l.length > 0);
  const rows: ParsedConfirm[] = [];
  const errors: string[] = [];
  if (lines[0] !== EXPECTED_HEADER) {
    return { rows, errors: [`bad header: ${JSON.stringify(lines[0])}`] };
  }
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const at = `line ${i + 1}`;
    const cols = lines[i].split('\t');
    if (cols.length !== 6) { errors.push(`${at}: expected 6 columns, got ${cols.length}`); continue; }
    const [recipientKey, recipientName, ticker, basis, evidence, confirmedAt] = cols.map((c) => c.trim());
    if (!recipientKey || !recipientName) { errors.push(`${at}: empty key/name`); continue; }
    if (seen.has(recipientKey)) { errors.push(`${at}: duplicate recipient_key ${recipientKey}`); continue; }
    if (!/^[A-Z][A-Z0-9.\-]*$/.test(ticker)) { errors.push(`${at}: ticker "${ticker}" not uppercase SEC form`); continue; }
    if (!BASES.has(basis)) { errors.push(`${at}: basis "${basis}" not in own-name|parent-name|manual`); continue; }
    if (evidence.length < 10) { errors.push(`${at}: evidence missing or too thin — objective identity citation required`); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(confirmedAt)) { errors.push(`${at}: confirmed_at "${confirmedAt}" not YYYY-MM-DD`); continue; }
    seen.add(recipientKey);
    rows.push({ recipientKey, recipientName, ticker, basis: basis as ParsedConfirm['basis'], evidence, confirmedAt });
  }
  return { rows, errors };
}

export async function loadRecipientTicker(opts: { dryRun?: boolean } = {}): Promise<{ rows: number }> {
  await applySchema();
  const { rows, errors } = parseConfirmTsv(readFileSync(TSV_PATH, 'utf8'));
  if (errors.length) {
    throw new Error(`recipient_ticker.tsv invalid — refusing to load:\n  ${errors.join('\n  ')}`);
  }
  const conn = await getDb();
  // Referential check: every confirmed key must exist in the substrate.
  for (const r of rows) {
    const q = await conn.run(`SELECT COUNT(*) n FROM district_contract_recipient WHERE recipient_key = ?`, [r.recipientKey]);
    const n = Number(((await q.getRowObjects()) as any[])[0].n);
    if (n === 0) throw new Error(`confirm row for unknown recipient_key "${r.recipientKey}" — harvest first, curate second`);
  }
  console.log(`recipient_ticker: ${rows.length} confirmed row(s)${opts.dryRun ? ' (dry-run — DB unchanged)' : ''}`);
  if (opts.dryRun) return { rows: rows.length };
  await conn.run(`DELETE FROM recipient_ticker`);
  for (const r of rows) {
    await conn.run(
      `INSERT INTO recipient_ticker (recipient_key, recipient_name, ticker, basis, evidence, confirmed_at)
       VALUES (?,?,?,?,?,?)`,
      [r.recipientKey, r.recipientName, r.ticker, r.basis, r.evidence, r.confirmedAt],
    );
  }
  return { rows: rows.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadRecipientTicker({ dryRun: process.argv.includes('--dry-run') })
    .then(() => process.exit(0))
    .catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
