/**
 * PFD PTR extractor — turns cached `pdftotext -layout` output into JSON.
 *
 * Source format: see `../researcher/sources/house-clerk.md` for shape and
 * pitfalls. Annual disclosures (FilingType O/A/D/T/B) are *not* handled
 * yet — they use a different multi-table layout. PTRs only.
 *
 * Usage:
 *   npx tsx skills/pfd-fetcher/extract.ts <pfd-cache-year-dir>
 *   npx tsx skills/pfd-fetcher/extract.ts ../../pfd-cache/2024
 *
 * Writes a sibling `<basename>.json` next to each `*.txt` whose PDF is a
 * Periodic Transaction Report (detected by header text). Skips Annual etc.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

// ─── Code mappings ────────────────────────────────────────────────────────────

const HOLDER: Record<string, string> = {
  SP: 'spouse',
  JT: 'joint',
  DC: 'dependent-child',
  '': 'self',
};

const TX_TYPE: Record<string, string> = {
  P: 'purchase',
  S: 'sale',
  'S (partial)': 'sale-partial',
  E: 'exchange',
  X: 'exchange', // some filings use X
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Transaction {
  holder: string;
  asset: string;
  ticker: string | null;
  assetType: string | null;
  subholding: string | null;  // "S O :" — e.g. "Marjorie IRA" (account/sub-holder)
  location: string | null;    // "L :" — e.g. "US"
  type: string;
  date: string;             // ISO YYYY-MM-DD
  notificationDate: string; // ISO YYYY-MM-DD
  amountBand: string;       // e.g. "$1,000,001 - $5,000,000"
  filingStatus: string;     // "New" | "Amended" | ...
  description: string;
}

export interface PTRRecord {
  filingId: string;
  source: 'house-clerk-ptr';
  filer: { name: string; status: string; stateDistrict: string };
  signedAt: string | null;  // ISO YYYY-MM-DD
  transactions: Transaction[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function usToIso(us: string | undefined | null): string | null {
  if (!us) return null;
  const m = us.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

function isPTR(text: string): boolean {
  // Annual reports have "Filing Type:  Annual Report" in the header. PTRs
  // certify "Periodic Transaction Report" in the cert paragraph and do not
  // have a "Filing Type:" line.
  return /Periodic Transaction Report/.test(text) && !/Filing Type:\s*Annual/.test(text);
}

// ─── OCR fallback ─────────────────────────────────────────────────────────────
// Used when pdftotext returns empty (scanned image PDFs).
// Converts each page to a PPM via pdftoppm, runs tesseract, returns full text.
export function ocrPdf(pdfPath: string, dpi = 250): string {
  const tmpDir = resolve(os.tmpdir(), `civiclens-ocr-${crypto.randomBytes(6).toString('hex')}`);
  mkdirSync(tmpDir, { recursive: true });
  try {
    spawnSync('pdftoppm', ['-r', String(dpi), pdfPath, resolve(tmpDir, 'page')], { stdio: 'ignore' });
    const pages = readdirSync(tmpDir).filter(f => f.endsWith('.ppm')).sort();
    const parts: string[] = [];
    for (const page of pages) {
      const imgPath = resolve(tmpDir, page);
      const outBase = imgPath.replace(/\.ppm$/, '');
      // psm 6 = uniform block of text — preserves column pipe structure better
      spawnSync('tesseract', [imgPath, outBase, '--psm', '6'], { stdio: 'ignore' });
      const txtPath = `${outBase}.txt`;
      if (existsSync(txtPath)) parts.push(readFileSync(txtPath, 'utf-8'));
    }
    return parts.join('\n');
  } finally {
    spawnSync('rm', ['-rf', tmpDir], { stdio: 'ignore' });
  }
}

// ─── OCR-aware PTR parser ─────────────────────────────────────────────────────
// psm 6 OCR preserves the PTR pipe-grid structure. Each transaction row looks like:
//   | oc |ASSET NAME CMN | |x| | | | MM/DD/YY| MM/DD/YY| x | | | ...
//   or a two-line variant where the asset wraps to the line above the date/type row.
//
// Transaction type is P or S appearing before the two dates.
// Amount band is determined by which column after the notification date has an x/X.
//
// Amount band columns in PTR form order (after notification date):
const OCR_AMOUNT_BANDS = [
  '$1,001 - $15,000',
  '$15,001 - $50,000',
  '$50,001 - $100,000',
  '$100,001 - $250,000',
  '$250,001 - $500,000',
  '$500,001 - $1,000,000',
  '$1,000,001 - $5,000,000',
  '$5,000,001 - $25,000,000',
  'Over $25,000,000',
];

function fixOcrDate(raw: string): string | null {
  const cleaned = raw.replace(/[|\\l]/g, '/').replace(/\s/g, '').trim();
  // 2-digit year: MM/DD/YY
  const m2 = cleaned.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (m2) return `20${m2[3]}-${m2[1]}-${m2[2]}`;
  return usToIso(cleaned);
}

function ocrAmountBand(cols: string): string {
  const parts = cols.split('|').map(s => s.trim());
  for (let i = 0; i < parts.length; i++) {
    if (/^[xX*+]$/.test(parts[i]) && i < OCR_AMOUNT_BANDS.length) {
      return OCR_AMOUNT_BANDS[i];
    }
  }
  return '';
}

function ocrHolder(code: string): string {
  const u = code.toUpperCase().replace(/[^A-Z]/g, '');
  if (u === 'SP') return 'spouse';
  if (u === 'JT') return 'joint';
  if (u === 'DC') return 'dependent-child';
  return 'self';
}

// Full row: | holder |ASSET | P/S cols | MM/DD/YY| MM/DD/YY| amount cols
// The P or S appears somewhere between the asset name and the first date.
const OCR_FULL_RE = /^\s*[|_]?\s*(SP|JT|DC|OC|oc|dc|sp|jt)?\s*[|_]\s*(.+?)\s*[|_]\s*(?:[^|]*[|_]){0,3}?\s*(P|S)\s*(?:[|_][^|]*){0,4}?[|_]\s*(\d{2}[/|\\l]\d{2}[/|\\l]\d{2,4})\s*[|_]\s*(\d{2}[/|\\l]\d{2}[/|\\l]\d{2,4})\s*[|_](.+)$/;

export function extractPTR_OCR(text: string): PTRRecord | null {
  if (!isPTR(text)) return null;

  const filingId = text.match(/(?:Filing\s*ID\s*#?|DocID[:\s])(\d+)/i)?.[1] ?? '';
  const name = text.match(/NAME[:\s]+(.+?)(?:\s{2,}|Page\s|\n)/i)?.[1]?.trim() ?? '';
  const stateRaw = text.match(/State:\s*([A-Z]{2})/i)?.[1] ?? '';
  const distRaw  = text.match(/District:\s*(\d+)/i)?.[1] ?? '';
  const stateDistrict = stateRaw ? `${stateRaw}${distRaw.padStart(2,'0')}` : '';

  const lines = text.split('\n');
  const transactions: Transaction[] = [];
  let pendingAsset: string | null = null;
  let pendingHolder = 'self';

  for (const raw of lines) {
    // Skip header/footer artifacts
    if (/Transaction\s*Date|Notification|Filing\s*Type|Annual\s*Report|asset type abbrev/i.test(raw)) continue;
    if (/^\s*[|_\s]*$/.test(raw)) continue;

    // Full row with asset + type + dates + amounts all on one line
    const full = raw.match(OCR_FULL_RE);
    if (full) {
      const asset = full[2].replace(/[|_]/g, '').replace(/\s+/g, ' ').trim();
      if (asset.length < 3) continue;
      const date = fixOcrDate(full[4]);
      const notifDate = fixOcrDate(full[5]);
      if (!date) continue;
      transactions.push({
        holder:           ocrHolder(full[1] ?? ''),
        asset,
        ticker:           null,
        assetType:        null,
        subholding:       null,
        location:         null,
        type:             TX_TYPE[full[3]] ?? (full[3] === 'P' ? 'purchase' : 'sale'),
        date,
        notificationDate: notifDate ?? '',
        amountBand:       ocrAmountBand(full[6]),
        filingStatus:     'New',
        description:      '',
      });
      pendingAsset = null;
      continue;
    }

    // Two-line variant: asset name line (no dates) followed by date/type/amount line
    // Asset line: starts with holder code or contains uppercase asset name, no dates
    const hasDate = /\d{2}[/|\\]\d{2}[/|\\]\d{2}/.test(raw);
    if (!hasDate) {
      // Possible asset line
      const am = raw.match(/^\s*[|_]?\s*(SP|JT|DC|OC|oc|dc|sp|jt)?\s*[|_]?\s*([A-Z][A-Z0-9 ,./&'()\-]{3,})\s*[|_]?\s*$/);
      if (am && am[2].length > 3) {
        pendingHolder = ocrHolder(am[1] ?? '');
        pendingAsset  = am[2].replace(/[|_]/g, '').replace(/\s+/g, ' ').trim();
      }
      continue;
    }

    // Date-bearing line — may be standalone or following a pending asset
    // Pattern: optional type (P/S) then two dates then amount cols
    const dm = raw.match(/\b(P|S)\b.*?(\d{2}[/|\\l]\d{2}[/|\\l]\d{2,4})[^0-9]*(\d{2}[/|\\l]\d{2}[/|\\l]\d{2,4})(.*)/);
    if (dm && pendingAsset) {
      const date = fixOcrDate(dm[2]);
      const notifDate = fixOcrDate(dm[3]);
      if (date) {
        transactions.push({
          holder:           pendingHolder,
          asset:            pendingAsset,
          ticker:           null,
          assetType:        null,
          subholding:       null,
          location:         null,
          type:             TX_TYPE[dm[1]] ?? (dm[1] === 'P' ? 'purchase' : 'sale'),
          date,
          notificationDate: notifDate ?? '',
          amountBand:       ocrAmountBand(dm[4]),
          filingStatus:     'New',
          description:      '',
        });
      }
      pendingAsset = null;
    }
  }

  return {
    filingId,
    source: 'house-clerk-ptr',
    filer: { name, status: 'Member', stateDistrict },
    signedAt: null,
    transactions,
  };
}

// ─── Parser ───────────────────────────────────────────────────────────────────

const PRIMARY_RE = new RegExp(
  '^\\s+(SP|JT|DC)?\\s*' +                           // owner (optional, blank=self)
  '(.+?)\\s+' +                                      // asset name (non-greedy)
  '(P|S \\(partial\\)|S|E|X)\\s+' +                  // transaction type
  '(\\d{2}\\/\\d{2}\\/\\d{4})\\s+' +                 // transaction date
  '(\\d{2}\\/\\d{2}\\/\\d{4})\\s+' +                 // notification date
  '\\$([\\d,]+)\\s*-' +                              // amount-low + dash
  '(?:\\s*\\$([\\d,]+))?' +                          // amount-high (optional, same line)
  '\\s*$'
);

const AMT_HIGH_RE   = /\$([\d,]+)\s*$/;        // right-anchored
const TICKER_RE     = /\(([A-Z][A-Z0-9.]*)\)/;  // allow single-letter (e.g. Visa "V")
const ASSET_TYPE_RE = /\[([A-Z]{2})\]/;
const FILING_STATUS_RE = /F\s+S\s*:\s*(.+?)\s*$/;
const DESC_START_RE = /^\s+D\s+:\s*(.*)$/;     // "D : <text>"
const SUB_OWNER_RE  = /\bS\s+O\s*:\s*(.+?)(?:\s+L\s*:|\s*$)/;  // "S O : Marjorie IRA"
const LOCATION_RE   = /\bL\s*:\s*([A-Z]{2})\b/;                 // "L : US"

export function extractPTR(text: string): PTRRecord | null {
  if (!isPTR(text)) return null;

  const filingId =
    text.match(/Filing ID #(\d+)/)?.[1] ?? '';
  const name =
    text.match(/^Name:\s+(.+?)\s*$/m)?.[1].trim() ?? '';
  const status =
    text.match(/^Status:\s+(.+?)\s*$/m)?.[1].trim() ?? '';
  const stateDistrict =
    text.match(/State\/District:?\s+(\S+)/)?.[1] ?? '';
  const signed =
    text.match(/Digitally Signed:.+?,\s*(\d{2}\/\d{2}\/\d{4})/)?.[1] ?? null;

  const lines = text.split('\n');
  const transactions: Transaction[] = [];
  let current: Partial<Transaction> & { amountLow?: string; amountHigh?: string } | null = null;
  let inDescription = false;

  const flush = () => {
    if (!current) return;
    const tx: Transaction = {
      holder:           current.holder           ?? 'self',
      asset:            (current.asset ?? '').replace(/\s+/g, ' ').trim(),
      ticker:           current.ticker           ?? null,
      assetType:        current.assetType        ?? null,
      subholding:       current.subholding       ?? null,
      location:         current.location         ?? null,
      type:             current.type             ?? '',
      date:             current.date             ?? '',
      notificationDate: current.notificationDate ?? '',
      amountBand:       current.amountLow && current.amountHigh
                        ? `$${current.amountLow} - $${current.amountHigh}`
                        : current.amountLow
                        ? `$${current.amountLow}`
                        : '',
      filingStatus:     current.filingStatus     ?? '',
      description:      (current.description     ?? '').replace(/\s+/g, ' ').trim(),
    };
    transactions.push(tx);
    current = null;
    inDescription = false;
  };

  let inTable = false;
  for (const raw of lines) {
    // Detect table region. The table-header line is fragmented by
    // pdftotext, so anchor on the unambiguous "Transaction Date" cell.
    if (!inTable) {
      if (/Transaction\s+Date/.test(raw) && /Notification/.test(raw)) {
        inTable = true;
      }
      continue;
    }
    // Page-break artifact: multi-page PDFs repeat the table header on each
    // page. pdftotext emits it inline as text, which would otherwise be
    // appended to whatever asset/description we're inside.
    if (/ID\s+Owner\s+Asset/.test(raw) || /Cap\.\s*$/.test(raw) || /Gains\s*>/.test(raw) || /^\s*\$200\?/.test(raw)) {
      continue;
    }
    // Table ends at the asset-type-codes URL footer.
    if (/asset type abbreviations/.test(raw)) {
      flush();
      break;
    }
    if (!raw.trim()) continue;

    // Primary transaction line — start of a new record.
    const primary = raw.match(PRIMARY_RE);
    if (primary) {
      flush();
      // Asset name may already contain ticker `(XXX)` and/or asset-type
      // bracket `[XX]` if it fits on one line — pull them out here so the
      // continuation-line scan doesn't have to.
      let asset = primary[2].trim();
      const tk = asset.match(TICKER_RE);
      const at = asset.match(ASSET_TYPE_RE);
      if (tk) asset = asset.replace(TICKER_RE, '').trim();
      if (at) asset = asset.replace(ASSET_TYPE_RE, '').trim();
      current = {
        holder:           HOLDER[primary[1] ?? ''] ?? 'self',
        asset,
        ticker:           tk?.[1] ?? undefined,
        assetType:        at?.[1] ?? undefined,
        type:             TX_TYPE[primary[3]] ?? primary[3],
        date:             usToIso(primary[4]) ?? '',
        notificationDate: usToIso(primary[5]) ?? '',
        amountLow:        primary[6],
        amountHigh:       primary[7],  // optional — when amount band fits on one line
      };
      inDescription = false;
      continue;
    }

    if (!current) continue;

    // Description continuation — once we're in description, every following
    // non-anchor line is part of it until we hit a known terminator.
    if (inDescription) {
      // A new "F S :" or end-of-block can break us out.
      if (FILING_STATUS_RE.test(raw)) {
        // Some filings put F/S after D — handle by closing description.
        inDescription = false;
        current.filingStatus = raw.match(FILING_STATUS_RE)?.[1].trim() ?? '';
        continue;
      }
      current.description = (current.description ?? '') + ' ' + raw.trim();
      continue;
    }

    // Description start.
    const dm = raw.match(DESC_START_RE);
    if (dm) {
      current.description = dm[1].trim();
      inDescription = true;
      continue;
    }

    // Filing status.
    const fm = raw.match(FILING_STATUS_RE);
    if (fm) {
      current.filingStatus = fm[1].trim();
      continue;
    }

    // Continuation line (asset wrap, amount-high, ticker, bracket,
    // sub-owner, location). Multiple signals can co-occur on one line.
    let consumed = false;

    const tk = raw.match(TICKER_RE);
    if (tk && !current.ticker) { current.ticker = tk[1]; consumed = true; }

    const at = raw.match(ASSET_TYPE_RE);
    if (at && !current.assetType) { current.assetType = at[1]; consumed = true; }

    const ah = raw.match(AMT_HIGH_RE);
    if (ah && !current.amountHigh) { current.amountHigh = ah[1]; consumed = true; }

    const so = raw.match(SUB_OWNER_RE);
    if (so && !current.subholding) { current.subholding = so[1].trim(); consumed = true; }

    const loc = raw.match(LOCATION_RE);
    if (loc && !current.location) { current.location = loc[1]; consumed = true; }

    // Asset-name continuation: strip the parts we've consumed and append
    // any remaining alphabetic text to the asset name.
    let leftover = raw
      .replace(TICKER_RE, '')
      .replace(ASSET_TYPE_RE, '')
      .replace(AMT_HIGH_RE, '')
      .replace(SUB_OWNER_RE, '')
      .replace(LOCATION_RE, '')
      .trim();
    if (leftover && /[A-Za-z]/.test(leftover)) {
      current.asset = (current.asset ?? '') + ' ' + leftover;
      consumed = true;
    }

    if (!consumed) {
      // Unknown line inside table region — ignore quietly.
    }
  }

  // Flush trailing record if file ends without the URL footer.
  flush();

  return {
    filingId,
    source: 'house-clerk-ptr',
    filer: { name, status, stateDistrict },
    signedAt: usToIso(signed),
    transactions,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: extract.ts <pfd-cache-year-dir>');
    process.exit(1);
  }
  const root = resolve(process.cwd(), dir);
  if (!existsSync(root)) {
    console.error(`not found: ${root}`);
    process.exit(1);
  }

  const txtFiles = readdirSync(root).filter(f => f.endsWith('.txt'));
  let parsed = 0, skipped = 0, txTotal = 0, errored = 0;

  for (const f of txtFiles) {
    const txtPath = resolve(root, f);
    const pdfPath = txtPath.replace(/\.txt$/, '.pdf');
    let text = readFileSync(txtPath, 'utf-8');
    let usedOcr = false;

    // If pdftotext returned empty and a PDF exists, fall back to OCR
    if (!text.trim() && existsSync(pdfPath)) {
      process.stdout.write(`  ⟳ ${basename(f)} (empty — running OCR…)\r`);
      text = ocrPdf(pdfPath);
      usedOcr = true;
    }

    try {
      // Try standard parser first; if it returns null on OCR text, use OCR parser
      let rec = extractPTR(text);
      if (!rec && usedOcr) rec = extractPTR_OCR(text);
      if (!rec) { skipped++; if (usedOcr) process.stdout.write('\n'); continue; }
      // Skip writing empty OCR results — scanned table PDFs produce 0 tx
      if (usedOcr && rec.transactions.length === 0) {
        if (usedOcr) process.stdout.write('\n');
        console.warn(`  ⚠ ${basename(f)} [OCR] → 0 tx (scanned table — needs commercial OCR)`);
        skipped++;
        continue;
      }
      const jsonPath = txtPath.replace(/\.txt$/, '.json');
      writeFileSync(jsonPath, JSON.stringify(rec, null, 2));
      parsed++;
      txTotal += rec.transactions.length;
      if (usedOcr) process.stdout.write('\n');
      console.log(`  ✓ ${basename(f)}${usedOcr ? ' [OCR]' : ''} → ${rec.transactions.length} tx`);
    } catch (e: any) {
      errored++;
      if (usedOcr) process.stdout.write('\n');
      console.warn(`  ✗ ${basename(f)}: ${e.message}`);
    }
  }

  console.log(`\nParsed ${parsed} PTR(s) → ${txTotal} transactions; skipped ${skipped} non-PTR; ${errored} errors`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
