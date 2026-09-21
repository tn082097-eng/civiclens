/**
 * Ingests the SAM.gov Contract Opportunities public extract into compact JSON.
 *
 * Source: the public data extract, which needs no account and no API key and
 * carries no quota — verified on a runner (see .github/workflows/venture-probe).
 * The keyed API is useless here: a public key allows 10 requests/day.
 *
 * Runs in GitHub Actions, never locally: the dev container has no egress.
 *
 *   npx tsx ventures/govcon/ingest.ts [--out <dir>] [--source <url>]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CsvStreamParser } from './csv.ts';

const FULL_CSV =
  'https://sam.gov/api/prod/fileextractservices/v1/api/download/Contract%20Opportunities/datagov/ContractOpportunitiesFullCSV.csv?privacy=Public';

/** Notice types a bidder can actually act on. Award/justification notices are history, not opportunity. */
const ACTIONABLE = new Set([
  'Solicitation',
  'Combined Synopsis/Solicitation',
  'Presolicitation',
  'Sources Sought',
  'Special Notice',
]);

/** Set-aside values that mean "no set-aside". Anything else is a real restriction. */
const NO_SET_ASIDE = new Set(['', 'NONE', 'No Set aside used', 'N/A']);

const REQUIRED = [
  'NoticeId', 'Title', 'Department/Ind.Agency', 'Sub-Tier', 'Office',
  'PostedDate', 'Type', 'SetASide', 'SetASideCode', 'ResponseDeadLine',
  'NaicsCode', 'PopState', 'PopCity', 'Active', 'Link', 'Description',
  'PrimaryContactFullname', 'PrimaryContactEmail',
] as const;

export interface Opportunity {
  id: string;
  title: string;
  sol: string;
  agency: string;
  subTier: string;
  office: string;
  posted: string;
  type: string;
  setAside: string;
  setAsideCode: string;
  deadline: string;
  naics: string;
  psc: string;
  popState: string;
  popCity: string;
  link: string;
  contact: string;
  email: string;
  description: string;
}

/** SAM descriptions carry HTML and entities; the site renders text, so normalise here. */
export function cleanText(raw: string, max = 700): string {
  const text = raw
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function isOpen(deadline: string, now: number): boolean {
  if (!deadline) return false;
  const t = Date.parse(deadline);
  return Number.isFinite(t) && t > now;
}

export function hasSetAside(setAside: string, code: string): boolean {
  return !NO_SET_ASIDE.has(setAside.trim()) && !NO_SET_ASIDE.has(code.trim());
}

export interface Stats {
  generatedAt: string;
  rowsRead: number;
  malformedRows: number;
  active: number;
  actionable: number;
  openDeadline: number;
  published: number;
  bySetAside: Record<string, number>;
  byNaicsSector: Record<string, number>;
  byState: Record<string, number>;
  byAgency: Record<string, number>;
}

function bump(m: Record<string, number>, k: string): void {
  if (!k) return;
  m[k] = (m[k] ?? 0) + 1;
}

export async function ingest(sourceUrl: string, outDir: string): Promise<Stats> {
  const now = Date.now();
  const res = await fetch(sourceUrl, { redirect: 'follow' });
  if (!res.ok) throw new Error(`extract fetch failed: ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error('extract response had no body');

  let header: string[] | null = null;
  let index: Record<string, number> = {};
  const kept: Opportunity[] = [];
  const stats: Stats = {
    generatedAt: new Date(now).toISOString(),
    rowsRead: 0, malformedRows: 0, active: 0, actionable: 0,
    openDeadline: 0, published: 0,
    bySetAside: {}, byNaicsSector: {}, byState: {}, byAgency: {},
  };

  const parser = new CsvStreamParser((row) => {
    if (!header) {
      header = row;
      index = Object.fromEntries(row.map((h, i) => [h.trim(), i]));
      const missing = REQUIRED.filter((c) => !(c in index));
      // Fail loudly rather than publish a half-mapped feed.
      if (missing.length) throw new Error(`extract is missing columns: ${missing.join(', ')}`);
      return;
    }
    stats.rowsRead++;
    if (row.length !== header.length) { stats.malformedRows++; return; }

    const get = (c: string): string => (row[index[c]] ?? '').trim();

    if (get('Active') !== 'Yes') return;
    stats.active++;

    const type = get('Type');
    if (!ACTIONABLE.has(type)) return;
    stats.actionable++;

    const deadline = get('ResponseDeadLine');
    if (!isOpen(deadline, now)) return;
    stats.openDeadline++;

    const setAside = get('SetASide');
    const setAsideCode = get('SetASideCode');
    if (!hasSetAside(setAside, setAsideCode)) return;

    const naics = get('NaicsCode');
    const popState = get('PopState');
    const agency = get('Department/Ind.Agency');

    kept.push({
      id: get('NoticeId'),
      title: cleanText(get('Title'), 240),
      sol: get('Sol#'),
      agency,
      subTier: get('Sub-Tier'),
      office: get('Office'),
      posted: get('PostedDate'),
      type,
      setAside,
      setAsideCode,
      deadline,
      naics,
      psc: get('ClassificationCode'),
      popState,
      popCity: get('PopCity'),
      link: get('Link'),
      contact: get('PrimaryContactFullname'),
      email: get('PrimaryContactEmail'),
      description: cleanText(get('Description')),
    });

    bump(stats.bySetAside, setAside);
    bump(stats.byNaicsSector, naics.slice(0, 2));
    bump(stats.byState, popState);
    bump(stats.byAgency, agency);
  });

  const decoder = new TextDecoder('utf-8');
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    parser.write(decoder.decode(chunk, { stream: true }));
  }
  parser.write(decoder.decode());
  parser.end();

  if (!header) throw new Error('extract produced no rows');

  // Soonest deadline first: the only ordering a bidder cares about.
  kept.sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline));
  stats.published = kept.length;

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'opportunities.json'), JSON.stringify(kept));
  writeFileSync(join(outDir, 'stats.json'), JSON.stringify(stats, null, 2));

  return stats;
}

function topN(m: Record<string, number>, n: number): string {
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => `    ${String(v).padStart(6)}  ${k}`).join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const arg = (f: string, d: string): string => {
    const i = args.indexOf(f);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
  };
  const outDir = arg('--out', join(process.cwd(), 'ventures/govcon/data'));
  const source = arg('--source', FULL_CSV);

  ingest(source, outDir).then((s) => {
    console.log(`rows read        ${s.rowsRead}`);
    console.log(`  malformed      ${s.malformedRows}`);
    console.log(`  active         ${s.active}`);
    console.log(`  actionable     ${s.actionable}`);
    console.log(`  open deadline  ${s.openDeadline}`);
    console.log(`PUBLISHED        ${s.published}`);
    console.log(`\n  top set-asides:\n${topN(s.bySetAside, 12)}`);
    console.log(`\n  top states:\n${topN(s.byState, 12)}`);
    console.log(`\n  top NAICS sectors:\n${topN(s.byNaicsSector, 12)}`);
    console.log(`\n  top agencies:\n${topN(s.byAgency, 10)}`);
    if (s.published === 0) { console.error('\nno opportunities published — refusing to call this a success'); process.exit(1); }
  }).catch((e) => { console.error(e); process.exit(1); });
}
