/**
 * PFD Fetcher — downloads House Personal Financial Disclosure PDFs.
 *
 * Source: https://disclosures-clerk.house.gov
 *   1. Annual ZIP (XML index of all filings for a year)
 *   2. Per-document PDF endpoint
 *   3. pdftotext extracts raw text alongside each PDF
 *
 * Usage:
 *   npx tsx skills/pfd-fetcher/fetch.ts --year 2024
 *   npx tsx skills/pfd-fetcher/fetch.ts --year 2024 --names ../../names.txt
 *   npx tsx skills/pfd-fetcher/fetch.ts --year 2024 --name "Pelosi"
 *   npx tsx skills/pfd-fetcher/fetch.ts --years 2022,2023,2024 --names ../../names.txt
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PFD_CACHE } from '../../lib/paths.js';

// Canonical cache location (data/caches/pfd-cache) — must match db/load-pfd.ts,
// which ingests from PFD_CACHE. The old repo-root pfd-cache/ predates the
// data/ restructure and nothing reads it.
const CACHE_DIR = PFD_CACHE;
const UA        = 'CivicLens/1.0 (research; civiclens.org)';

interface FilingRecord {
  last: string;
  first: string;
  suffix: string;
  filingType: string;     // A=Annual, P=Periodic, C=Candidate, N=New, T=Termination
  stateDist: string;
  year: string;
  filingDate: string;
  docId: string;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
async function fetchBuffer(url: string): Promise<Buffer> {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

// ─── Index download + parse ───────────────────────────────────────────────────
async function ensureIndexXml(year: number): Promise<string> {
  const xmlPath = resolve(CACHE_DIR, 'index', `${year}FD.xml`);
  if (existsSync(xmlPath)) return readFileSync(xmlPath, 'utf-8');

  mkdirSync(dirname(xmlPath), { recursive: true });
  const zipPath = resolve(CACHE_DIR, 'index', `${year}FD.zip`);
  const url = `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`;
  console.log(`[index] downloading ${url}`);
  const buf = await fetchBuffer(url);
  writeFileSync(zipPath, buf);

  // unzip the bundled XML
  execFileSync('unzip', ['-o', '-d', dirname(xmlPath), zipPath], { stdio: 'pipe' });
  if (!existsSync(xmlPath)) throw new Error(`expected ${xmlPath} not produced by unzip`);
  return readFileSync(xmlPath, 'utf-8');
}

function parseIndex(xml: string): FilingRecord[] {
  const records: FilingRecord[] = [];
  const memberRe = /<Member>([\s\S]*?)<\/Member>/g;
  const fieldRe  = (tag: string) =>
    new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>|<${tag}\\s*/>`);
  let m: RegExpExecArray | null;
  while ((m = memberRe.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag: string) => {
      const fm = block.match(fieldRe(tag));
      return (fm?.[1] ?? '').trim();
    };
    records.push({
      last:       get('Last'),
      first:      get('First'),
      suffix:     get('Suffix'),
      filingType: get('FilingType'),
      stateDist:  get('StateDst'),
      year:       get('Year'),
      filingDate: get('FilingDate'),
      docId:      get('DocID'),
    });
  }
  return records;
}

// ─── Name matching ────────────────────────────────────────────────────────────
function normalize(s: string): string {
  return s.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

function matchName(query: string, records: FilingRecord[]): FilingRecord[] {
  const q = normalize(query);
  const tokens = q.split(' ');
  const last = tokens[tokens.length - 1];
  const first = tokens.length > 1 ? tokens[0] : '';

  return records.filter(r => {
    const rl = normalize(r.last);
    const rf = normalize(r.first);
    if (rl !== last) return false;
    if (!first) return true;
    // Allow Bernie/Bernard, Liz/Elizabeth — startsWith either way
    return rf.startsWith(first) || first.startsWith(rf);
  });
}

// ─── PDF download + text extraction ───────────────────────────────────────────
async function downloadPdf(rec: FilingRecord): Promise<{ pdfPath: string; txtPath: string; skipped: boolean }> {
  const yearDir = resolve(CACHE_DIR, rec.year);
  mkdirSync(yearDir, { recursive: true });
  const slug    = `${rec.last}-${rec.first}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const pdfPath = resolve(yearDir, `${slug}-${rec.docId}.pdf`);
  const txtPath = resolve(yearDir, `${slug}-${rec.docId}.txt`);

  if (existsSync(pdfPath) && existsSync(txtPath)) {
    return { pdfPath, txtPath, skipped: true };
  }

  if (!existsSync(pdfPath)) {
    // P (periodic transaction report) lives under /ptr-pdfs/; everything else under /financial-pdfs/
    const subdir = rec.filingType === 'P' ? 'ptr-pdfs' : 'financial-pdfs';
    const url = `https://disclosures-clerk.house.gov/public_disc/${subdir}/${rec.year}/${rec.docId}.pdf`;
    const buf = await fetchBuffer(url);
    writeFileSync(pdfPath, buf);
  }

  if (!existsSync(txtPath)) {
    try {
      execFileSync('pdftotext', ['-layout', pdfPath, txtPath], { stdio: 'pipe' });
    } catch (e: any) {
      writeFileSync(txtPath, `[pdftotext failed: ${e.message}]`);
    }
  }

  return { pdfPath, txtPath, skipped: false };
}

// ─── Orchestration ────────────────────────────────────────────────────────────
async function fetchForYear(year: number, names: string[] | null): Promise<void> {
  const xml = await ensureIndexXml(year);
  const records = parseIndex(xml);
  console.log(`[${year}] ${records.length} filings in index`);

  // Filter out non-substantive filings:
  //   C = Candidate (pre-election)
  //   E = Exempt
  //   G = Gift
  //   X = Extension request (no content)
  // Keep:
  //   A/O/D/H/W/B = Annual disclosure variants (assets, spouse employment)
  //   P = Periodic Transaction Report (STOCK Act stock trades)
  //   T = Termination
  const SKIP_TYPES = new Set(['C', 'E', 'G', 'X']);
  const substantive = records.filter(r => !SKIP_TYPES.has(r.filingType));
  console.log(`[${year}] ${substantive.length} substantive filings (annual + periodic)`);

  let targets: FilingRecord[];
  if (names && names.length > 0) {
    targets = [];
    for (const name of names) {
      const matches = matchName(name, substantive);
      if (matches.length === 0) {
        console.warn(`[${year}] no match: "${name}"`);
        continue;
      }
      // Download ALL matching filings for this name (annual + every periodic)
      targets.push(...matches);
    }
  } else {
    targets = substantive;
  }

  console.log(`[${year}] downloading ${targets.length} PDF(s)…`);
  let ok = 0, skip = 0, err = 0;
  for (const rec of targets) {
    try {
      const r = await downloadPdf(rec);
      if (r.skipped) { skip++; }
      else {
        ok++;
        console.log(`  ✓ ${rec.last}, ${rec.first} (${rec.stateDist}) → ${r.pdfPath.replace(CACHE_DIR + '/', '')}`);
      }
    } catch (e: any) {
      err++;
      console.warn(`  ✗ ${rec.last}, ${rec.first}: ${e.message}`);
    }
  }
  console.log(`[${year}] done — ${ok} new, ${skip} cached, ${err} errors`);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): { years: number[]; names: string[] | null } {
  let years: number[] = [new Date().getFullYear() - 1];
  let names: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--year') years = [parseInt(argv[++i], 10)];
    else if (a === '--years') years = argv[++i].split(',').map(s => parseInt(s.trim(), 10));
    else if (a === '--names') {
      const path = resolve(process.cwd(), argv[++i]);
      names = readFileSync(path, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean);
    } else if (a === '--name') {
      const v = argv[++i] ?? '';
      names = names ? [...names, v] : [v];
    }
  }
  return { years, names };
}

async function main() {
  const { years, names } = parseArgs(process.argv.slice(2));
  if (names) console.log(`Targeting ${names.length} name(s): ${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''}`);
  else        console.log('No --names given — downloading ALL annual filings (large).');

  for (const year of years) {
    await fetchForYear(year, names);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
