/**
 * OpenSecrets donor-industry loader (Pattern Discovery v2, Phase 2 — authoritative tier).
 *
 * Parses cached OpenSecrets "industries contribution details" widget HTML into
 * the donor_industry table. PURE PARSER — no network. OpenSecrets sits behind
 * Cloudflare, so plain HTTP 403s; the raw widget HTML is harvested separately
 * by a browser (browser-harness) and frozen to:
 *     pfd-cache/opensecrets/<cycle>/<member_id>.html
 * This loader reads those files, so it is headless/cron-safe and idempotent.
 *
 * Each member-cycle is DELETE-then-insert (source='opensecrets'), matching the
 * pfd_transactions / super_pac_ie "latest fetch wins" semantics.
 *
 * Only INDUSTRY-level rows are persisted (sector is kept as a grouping column).
 * Sector aggregate totals are NOT stored as their own rows — that would double
 * count against v_member_donor_theme, which sums industries.
 *
 * Usage:
 *   npx tsx db/load-opensecrets.ts 2024
 *   npx tsx db/load-opensecrets.ts 2024,2022 --dry-run
 *   npx tsx agents/pipeline.ts --load-opensecrets 2024
 *
 * See SOURCES.md → "OpenSecrets industries widget" and the domain skill at
 * ~/Developer/browser-harness/agent-workspace/domain-skills/opensecrets/.
 */

import { applySchema, getDb } from './init.js';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CACHE_ROOT = join(process.env.HOME ?? '', '.hermes/civiclens/pfd-cache/opensecrets');

// The 13 OpenSecrets top-level sector labels. A table row whose first label cell
// is one of these is a sector-aggregate row (and carries its first industry in
// the trailing cells); any other leading label is an industry under the current
// sector. Matching is case/spacing-insensitive.
const SECTOR_LABELS = [
  'Labor', 'Ideology/Single-Issue', 'Other', 'Misc Business',
  'Finance/Insur/RealEst', 'Communic/Electronics', 'Lawyers & Lobbyists',
  'Health', 'Energy/Nat Resource', 'Construction', 'Transportation',
  'Agribusiness', 'Defense',
];
const SECTOR_SET = new Set(SECTOR_LABELS.map(norm));

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface IndustryRow {
  sector: string | null;
  industry: string;
  total: number;
  individuals: number | null;
  pacs: number | null;
}

function money(s: string): number | null {
  const m = s.replace(/[^0-9.-]/g, '');
  if (m === '' || m === '-') return null;
  const n = Number(m);
  return Number.isFinite(n) ? n : null;
}

function isMoneyCell(s: string): boolean {
  return /^\$?[\d,]+(\.\d+)?$/.test(s.trim()) || s.trim() === '$0' || s.trim() === '0';
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Parse an OpenSecrets member "industries" profile page into industry-level
 * rows. The page is a DataTables nested-child layout: each sector is a top-level
 * <tr> (sector name + 3 totals) whose hidden cell holds a nested <table> of its
 * industries, each a clean [name, total, individuals, pacs] <tr>. We walk every
 * <tr>'s cells in groups of [label, $, $, $]; a leading group whose label is a
 * known sector sets the current sector and is skipped (its dollars are the sum
 * of its industries — storing it would double count); every other group is an
 * industry. Deduped by industry name within the page.
 *
 * NB: we deliberately parse the FULL page, not the turbo-frame with id
 * "industries-contribution-details-widget" — that frame holds the bubble chart,
 * not the table. The /widgets/ endpoint that returns the frame standalone is
 * Cloudflare-WAF-blocked; the profile page embeds the rendered table directly.
 */
export function parseWidgetHtml(html: string): IndustryRow[] {
  const trs = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
  const out: IndustryRow[] = [];
  const seen = new Set<string>();
  let currentSector: string | null = null;

  for (const tr of trs) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
      .map(m => stripTags(m[1]))
      .filter(c => c.length > 0);
    if (cells.length < 4) continue; // header / spacer / non-data rows

    // Split into groups of [label, money, money, money].
    let i = 0;
    let firstGroup = true;
    while (i + 3 < cells.length || (i + 1 < cells.length)) {
      if (i >= cells.length) break;
      const label = cells[i];
      if (isMoneyCell(label)) { i++; continue; } // stray money cell
      const total = cells[i + 1], indiv = cells[i + 2], pac = cells[i + 3];
      if (total === undefined || !isMoneyCell(total)) { i++; firstGroup = false; continue; }

      const isSector = firstGroup && SECTOR_SET.has(norm(label));
      if (isSector) {
        currentSector = label;
      } else if (!seen.has(norm(label))) {
        seen.add(norm(label));
        out.push({
          sector: currentSector,
          industry: label,
          total: money(total) ?? 0,
          individuals: isMoneyCell(indiv ?? '') ? money(indiv) : null,
          pacs: isMoneyCell(pac ?? '') ? money(pac) : null,
        });
      }
      i += 4;
      firstGroup = false;
    }
  }
  return out;
}

interface MemberResult {
  memberId: string;
  cycle: number;
  industries: number;
  total: number;
  error?: string;
}

async function loadMemberCycleFile(
  memberId: string,
  cycle: number,
  filePath: string,
  sourceUrl: string,
  opts: { dryRun?: boolean },
): Promise<MemberResult> {
  const res: MemberResult = { memberId, cycle, industries: 0, total: 0 };
  let rows: IndustryRow[];
  try {
    const html = readFileSync(filePath, 'utf-8');
    rows = parseWidgetHtml(html);
  } catch (e: any) {
    res.error = e?.message ?? String(e);
    return res;
  }
  if (rows.length === 0) {
    res.error = 'no industry rows parsed (empty/challenged page?)';
    return res;
  }

  res.industries = rows.length;
  res.total = rows.reduce((a, r) => a + r.total, 0);
  if (opts.dryRun) return res;

  const conn = await getDb();
  const fetchedAt = new Date().toISOString();
  await conn.run(
    `DELETE FROM donor_industry WHERE member_id = ? AND cycle = ? AND source = 'opensecrets'`,
    [memberId, cycle],
  );
  for (const r of rows) {
    await conn.run(
      `INSERT INTO donor_industry
       (member_id, cycle, sector, industry, total, individuals, pacs, source, source_url, fetched_at)
       VALUES (?,?,?,?,?,?,?, 'opensecrets', ?, ?)`,
      [memberId, cycle, r.sector, r.industry, r.total, r.individuals, r.pacs, sourceUrl, fetchedAt],
    );
  }
  return res;
}

export async function loadOpenSecrets(
  cycles: number[],
  opts: { dryRun?: boolean } = {},
): Promise<{ results: MemberResult[]; errored: number }> {
  await applySchema();
  const results: MemberResult[] = [];

  for (const cycle of cycles) {
    const dir = join(CACHE_ROOT, String(cycle));
    if (!existsSync(dir)) {
      console.log(`No cache dir for cycle ${cycle} (${dir}) — skipping.`);
      continue;
    }
    const files = readdirSync(dir).filter(f => f.endsWith('.html'));
    console.log(
      `\nLoading OpenSecrets industries for ${files.length} member file(s), cycle ${cycle}` +
      `${opts.dryRun ? ' (dry-run — DB unchanged)' : ''}…`,
    );
    for (const f of files) {
      const memberId = f.replace(/\.html$/, '');
      const sourceUrl = `https://www.opensecrets.org/members-of-congress/${memberId}/industries`;
      const r = await loadMemberCycleFile(memberId, cycle, join(dir, f), sourceUrl, opts);
      results.push(r);
    }
  }

  const errored = results.filter(r => r.error).length;
  return { results, errored };
}

function printSummary(results: MemberResult[]): void {
  const nameW = Math.max(20, ...results.map(r => r.memberId.length));
  const line = '─'.repeat(nameW + 34);
  console.log(line);
  console.log(`${'member'.padEnd(nameW)}  ${'cycle'.padStart(5)}  ${'inds'.padStart(5)}  ${'total $'.padStart(14)}`);
  console.log(line);
  for (const r of results) {
    if (r.error) { console.log(`${r.memberId.padEnd(nameW)}  ${String(r.cycle).padStart(5)}  ERROR ${r.error.slice(0, 40)}`); continue; }
    console.log(
      `${r.memberId.padEnd(nameW)}  ${String(r.cycle).padStart(5)}  ${String(r.industries).padStart(5)}  ` +
      `${Math.round(r.total).toLocaleString().padStart(14)}`,
    );
  }
  console.log(line);
  const ok = results.filter(r => !r.error).length;
  const errored = results.filter(r => r.error).length;
  console.log(`${results.length} member-cycle file(s): ${ok} loaded, ${errored} errored.`);
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
    const { results, errored } = await loadOpenSecrets(cycles, { dryRun });
    printSummary(results);
    process.exit(errored > 0 && results.every(r => r.error) ? 1 : 0);
  })().catch(e => { console.error(`\nFatal: ${e?.message ?? e}`); process.exit(2); });
}
