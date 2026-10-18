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
  /**
   * Non-empty by construction. A Periodic Transaction Report exists to report
   * transactions, so a PTRRecord with zero rows is a parser failure, not a
   * filing with nothing in it. The tuple type makes `transactions: []`
   * unrepresentable — the failure has to come back as `unresolved` instead.
   */
  transactions: [Transaction, ...Transaction[]];
}

/**
 * Why a readable PTR yielded no rows. Carries the evidence needed to tell
 * "the layout beat the parser" apart from "there was nothing to find", which
 * is exactly the distinction that let 19 launch filings load as empty.
 */
export interface PTRUnresolved {
  filingId: string;
  reason: 'no-transaction-rows' | 'row-count-mismatch' | 'not-a-ptr' | 'empty-input';
  evidence: {
    textBytes: number;
    tableEntered: boolean;
    datePairsSeen: number;   // independent count: how many rows SHOULD exist
    rowsMatched: number;
  };
}

export type PTRResult =
  | { kind: 'parsed'; record: PTRRecord }
  | { kind: 'unresolved'; info: PTRUnresolved };

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

// ─── OCR trigger ──────────────────────────────────────────────────────────────
// `pdftotext` on a scanned PDF does not always return an empty string: ~5
// cached filings carry 51–83 bytes of junk (stray glyphs, form feeds), which
// is truthy, so the old `!text.trim()` test silently skipped OCR for them.

/** Below this many non-whitespace characters a text layer is too thin to trust. */
export const MIN_TEXT_LAYER_CHARS = 200;
/** Below this many 3+-letter words a text layer has no usable structure. */
export const MIN_TEXT_LAYER_WORDS = 20;

/**
 * True when a `pdftotext` result is too thin or structureless to parse and
 * the PDF should be OCR'd instead. Conservative in the other direction: any
 * real text-layer PTR runs to thousands of characters and hundreds of words,
 * so it never trips either threshold.
 */
export function textLayerNeedsOcr(text: string): boolean {
  const nonWs = text.replace(/\s+/g, '').length;
  if (nonWs < MIN_TEXT_LAYER_CHARS) return true;
  const words = text.match(/[A-Za-z]{3,}/g)?.length ?? 0;
  return words < MIN_TEXT_LAYER_WORDS;
}

// ─── OCR page orientation ─────────────────────────────────────────────────────
// The scanned PTRs are frequently rotated, and orientation is a property of
// the page, not the file (docs/2026-07-28-pfd-ocr-rotation-finding.md).
//
// Angle convention: counter-clockwise quarter turns, the same convention as
// PIL's `Image.rotate`, which the probes used. "+90" there is the direction
// that made sideways scans readable; rotating the other way (-90 = 270 here)
// produces MIRRORED text that looks almost plausible and is silently wrong.
//
// The finding doc records that `--psm 0` OSD is unreliable on this bilevel
// corpus (one page reported 180°/"Cyrillic" at 0.20 confidence). So OSD only
// proposes an angle: a low-confidence answer is ignored in favour of the
// page-shape prior, and every angle is accepted only on keyword evidence in
// the psm-6 output. Byte count is deliberately NOT a signal — mirrored output
// measured larger than correct output on at least one page.

export type QuarterTurn = 0 | 90 | 180 | 270;

export interface OsdResult {
  /** `Orientation in degrees:` — how far the page content is turned. */
  orientation: QuarterTurn;
  /** `Rotate:` — counter-clockwise turn that makes the page upright. */
  rotate: QuarterTurn;
  confidence: number;
  script: string | null;
  scriptConfidence: number | null;
}

const QUARTER_TURNS: readonly QuarterTurn[] = [0, 90, 180, 270];

function asQuarterTurn(n: number): QuarterTurn | null {
  return (QUARTER_TURNS as readonly number[]).includes(n) ? (n as QuarterTurn) : null;
}

/**
 * Parse `tesseract <img> - --psm 0` output. Returns null when OSD produced no
 * usable answer (e.g. "Too few characters"), so the caller falls back to the
 * page-shape prior rather than to a default angle.
 */
export function parseOsd(out: string): OsdResult | null {
  const num = (label: string): number | null => {
    const m = out.match(new RegExp(`^\\s*${label}:\\s*(-?\\d+(?:\\.\\d+)?)\\s*$`, 'mi'));
    return m ? Number(m[1]) : null;
  };
  const orientation = asQuarterTurn(num('Orientation in degrees') ?? NaN);
  const rotate = asQuarterTurn(num('Rotate') ?? NaN);
  const confidence = num('Orientation confidence');
  if (orientation === null || rotate === null || confidence === null) return null;
  return {
    orientation,
    rotate,
    confidence,
    script: out.match(/^\s*Script:\s*(\S+)\s*$/mi)?.[1] ?? null,
    scriptConfidence: num('Script confidence'),
  };
}

/**
 * OSD answers below this are ignored. The only two measured answers on this
 * corpus are 0.82 (plausible) and 0.20 (a wrong 180°), so this is a floor
 * between them, not a calibrated value.
 */
export const OSD_MIN_CONFIDENCE = 0.5;

export type OrientationSource = 'osd' | 'page-shape' | 'fallback';

export interface RotationCandidate { angle: QuarterTurn; source: OrientationSource }

/**
 * Ordered angles to try for one rasterized page. Confident OSD first, then
 * the page-shape prior from the page's own pixel dimensions (never `pdfinfo`,
 * which can disagree with the page images), then the remaining angles.
 *
 * Shape prior, measured on cached McCaul/Khanna scans: landscape pixels ⇒ 0°,
 * portrait pixels ⇒ 90°. It is evidence for those strata only, which is why
 * it is a candidate to validate rather than a rule.
 */
export function rotationCandidates(
  osd: OsdResult | null, width: number, height: number,
): RotationCandidate[] {
  const out: RotationCandidate[] = [];
  const add = (angle: QuarterTurn, source: OrientationSource) => {
    if (!out.some(c => c.angle === angle)) out.push({ angle, source });
  };
  if (osd && osd.confidence >= OSD_MIN_CONFIDENCE) add(osd.rotate, 'osd');
  add(width > height ? 0 : 90, 'page-shape');
  for (const a of QUARTER_TURNS) add(a, 'fallback');
  return out;
}

/**
 * PTR header phrases that only read correctly at the right angle. Loose
 * spacing and one wildcard vowel absorb OCR noise (`Poriodic`).
 */
const ORIENTATION_KEYWORDS: readonly RegExp[] = [
  /p.riodic\s*transaction\s*report/i,
  /full\s*asset\s*name/i,
  /amount\s*of\s*transaction/i,
  /transaction\s*type/i,
  /date\s*(?:of\s*)?transaction/i,
];

/** Number of distinct orientation keywords present in OCR output. */
export function scoreOrientationKeywords(text: string): number {
  return ORIENTATION_KEYWORDS.filter(re => re.test(text)).length;
}

/** Hits at which an angle is accepted without trying the rest. */
export const ORIENTATION_EARLY_ACCEPT_HITS = 2;

export interface OrientationAttempt extends RotationCandidate { keywordHits: number }

export interface OrientationChoice extends OrientationAttempt {
  /** False when no angle produced any keyword: the angle is a guess. */
  validated: boolean;
}

/**
 * Pick the angle from attempts made in candidate order: most keyword hits,
 * ties going to the earlier (better-supported) candidate. With no hits
 * anywhere the first candidate is kept and marked unvalidated — the page's
 * text still flows to the parser, which will report it unresolved.
 */
export function pickOrientation(attempts: readonly OrientationAttempt[]): OrientationChoice {
  if (attempts.length === 0) throw new Error('pickOrientation: no attempts');
  let best = attempts[0];
  for (const a of attempts) if (a.keywordHits > best.keywordHits) best = a;
  return { ...best, validated: best.keywordHits > 0 };
}

/**
 * Rotate a binary PGM (P5, 8-bit) by a counter-clockwise quarter turn.
 * Pure TS because ImageMagick is not installed on the pipeline host.
 */
export function rotatePgm(pgm: Buffer, angle: QuarterTurn): Buffer {
  const { width: w, height: h, maxval, offset } = parsePgmHeader(pgm);
  if (angle === 0) return pgm;
  const src = pgm.subarray(offset, offset + w * h);
  if (src.length < w * h) throw new Error('rotatePgm: truncated pixel data');
  const [nw, nh] = angle === 180 ? [w, h] : [h, w];
  const dst = Buffer.alloc(nw * nh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx: number, dy: number;
      if (angle === 90)       { dx = y;         dy = w - 1 - x; }
      else if (angle === 180) { dx = w - 1 - x; dy = h - 1 - y; }
      else                    { dx = h - 1 - y; dy = x; }
      dst[dy * nw + dx] = src[y * w + x];
    }
  }
  return Buffer.concat([Buffer.from(`P5\n${nw} ${nh}\n${maxval}\n`, 'ascii'), dst]);
}

export function parsePgmHeader(pgm: Buffer): { width: number; height: number; maxval: number; offset: number } {
  let i = 0;
  const token = (): string => {
    for (;;) {
      while (i < pgm.length && /\s/.test(String.fromCharCode(pgm[i]))) i++;
      if (pgm[i] === 0x23) { while (i < pgm.length && pgm[i] !== 0x0a) i++; continue; } // '#' comment
      break;
    }
    const start = i;
    while (i < pgm.length && !/\s/.test(String.fromCharCode(pgm[i]))) i++;
    return pgm.toString('ascii', start, i);
  };
  if (token() !== 'P5') throw new Error('parsePgmHeader: not a binary PGM (P5)');
  const width = Number(token()), height = Number(token()), maxval = Number(token());
  if (!(width > 0 && height > 0)) throw new Error('parsePgmHeader: bad dimensions');
  if (!(maxval > 0 && maxval < 256)) throw new Error('parsePgmHeader: only 8-bit PGM supported');
  return { width, height, maxval, offset: i + 1 }; // single whitespace byte precedes pixels
}

/** What was done to one page, written alongside the filing's extracted values. */
export interface OcrPageRecord {
  page: number;          // 1-based
  width: number;         // rasterized pixels, before rotation
  height: number;
  osd: OsdResult | null;
  angle: QuarterTurn;    // counter-clockwise turn actually applied
  source: OrientationSource;
  keywordHits: number;
  validated: boolean;
  anglesTried: QuarterTurn[];
}

export interface OcrResult { text: string; pages: OcrPageRecord[] }

// ─── OCR fallback ─────────────────────────────────────────────────────────────
// Used when the text layer is missing or junk (scanned image PDFs). Rasterizes
// each page, detects its orientation, rotates it, then runs the psm-6 pass.
//
// 200 dpi matches the scans' native 200 ppi CCITT fax images; the old 250
// upsampled a bilevel image, and the only configuration measured readable was
// `-r 200` + rotation + psm 6.
function tesseractStdout(args: string[]): string {
  const r = spawnSync('tesseract', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout ?? '') : '';
}

export function ocrPdfDetailed(pdfPath: string, dpi = 200): OcrResult {
  const tmpDir = resolve(os.tmpdir(), `civiclens-ocr-${crypto.randomBytes(6).toString('hex')}`);
  mkdirSync(tmpDir, { recursive: true });
  try {
    spawnSync('pdftoppm', ['-r', String(dpi), '-gray', pdfPath, resolve(tmpDir, 'page')], { stdio: 'ignore' });
    const pageFiles = readdirSync(tmpDir).filter(f => f.endsWith('.pgm')).sort();
    const parts: string[] = [];
    const pages: OcrPageRecord[] = [];
    pageFiles.forEach((file, idx) => {
      const imgPath = resolve(tmpDir, file);
      const pgm = readFileSync(imgPath);
      const { width, height } = parsePgmHeader(pgm);
      const osd = parseOsd(tesseractStdout([imgPath, '-', '--psm', '0']));

      const attempts: (OrientationAttempt & { text: string })[] = [];
      for (const c of rotationCandidates(osd, width, height)) {
        const rotPath = resolve(tmpDir, `rot-${c.angle}-${file}`);
        writeFileSync(rotPath, rotatePgm(pgm, c.angle));
        // psm 6 = uniform block of text — preserves column pipe structure better
        const text = tesseractStdout([rotPath, '-', '--psm', '6']);
        attempts.push({ ...c, keywordHits: scoreOrientationKeywords(text), text });
        if (attempts.at(-1)!.keywordHits >= ORIENTATION_EARLY_ACCEPT_HITS) break;
      }
      const choice = pickOrientation(attempts);
      parts.push(attempts.find(a => a.angle === choice.angle)!.text);
      pages.push({
        page: idx + 1, width, height, osd,
        angle: choice.angle, source: choice.source,
        keywordHits: choice.keywordHits, validated: choice.validated,
        anglesTried: attempts.map(a => a.angle),
      });
    });
    return { text: parts.join('\n'), pages };
  } finally {
    spawnSync('rm', ['-rf', tmpDir], { stdio: 'ignore' });
  }
}

/** Text-only wrapper kept for existing callers. */
export function ocrPdf(pdfPath: string, dpi = 200): string {
  return ocrPdfDetailed(pdfPath, dpi).text;
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

  // Same non-empty invariant as the text parser. No OCR behaviour changes
  // here: a zero-row OCR result was already discarded by the caller (it hit
  // the "scanned table — needs commercial OCR" branch), so returning null
  // reaches the identical outcome through the type system instead.
  if (transactions.length === 0) return null;

  return {
    filingId,
    source: 'house-clerk-ptr',
    filer: { name, status: 'Member', stateDistrict },
    signedAt: null,
    transactions: transactions as [Transaction, ...Transaction[]],
  };
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * One transaction row.
 *
 * Generalised 2026-08-22 to cover four layout variants observed across the
 * House PTR corpus. All four are structural — none is keyed to a member, a
 * DocID, or a filing year:
 *
 *   1. trailing checkbox glyph after the amount   `… $1,001 - $15,000    c`
 *      (the cap-gains checkbox renders as a stray letter in the text layer)
 *   2. amount-high wrapped to a later line        `$50,001 -` … `$100,000`
 *   3. single amount, no range                    `$1.00`  (options rows)
 *   4. leading numeric row id before the owner    `2000097616 JT  Cerence …`
 *
 * Transaction type is read from its own column between the asset and the
 * transaction date — never inferred from position or surrounding prose.
 */
const PRIMARY_RE = new RegExp(
  '^\\s*(?:\\d{6,}\\s+)?' +                          // (4) optional leading row id
  '(SP|JT|DC)?\\s*' +                                // owner (optional, blank=self)
  '(.+?)\\s+' +                                      // asset name (non-greedy)
  '(P|S \\(partial\\)|S|E|X)\\s+' +                  // transaction type (own column)
  '(\\d{2}\\/\\d{2}\\/\\d{4})\\s+' +                 // transaction date
  '(\\d{2}\\/\\d{2}\\/\\d{4})\\s+' +                 // notification date
  '\\$([\\d,.]+)' +                                  // amount-low (3: allows $1.00)
  '(?:\\s*-\\s*(?:\\$([\\d,.]+))?)?' +               // (2) dash and/or high, both optional
  '\\s*[a-z]?\\s*$'                                  // (1) trailing checkbox glyph
);

/** Table header, case-insensitively — some filings render `transaction Date`. */
const TABLE_HEADER_RE = /transaction\s+date/i;
const NOTIFICATION_RE = /notification/i;

// Right-anchored; tolerates a trailing checkbox glyph so a wrapped
// amount-high (`$50,001 -` on the row, `$100,000` on a later line) is still
// picked up when the checkbox letter lands on the continuation line.
const AMT_HIGH_RE   = /\$([\d,.]+)\s*[a-z]?\s*$/;
// Two adjacent US dates — the structural signature of a transaction row.
const DATE_PAIR_RE  = /\d{2}\/\d{2}\/\d{4}\s+\d{2}\/\d{2}\/\d{4}/;
// Tickers and asset-type codes are uppercase at the source, but the
// `200xxxxx`-era text layer mangles individual capitals (`D`→`d`, `L`→`l`,
// `B`→`b`): `(AAPl)`, `(AMd)`, `(AbbV)`, `(Cb)`, `[Ol]`. Match either case and
// normalise with `.toUpperCase()` at every capture site — never store the
// mangled form.
const TICKER_RE     = /\(([A-Za-z][A-Za-z0-9.]*)\)/;  // allow single-letter (e.g. Visa "V")
const ASSET_TYPE_RE = /\[([A-Za-z]{2})\]/;
// Matches both the abbreviated `F S :` form and the fully-spelled
// `FILING STATUS:` form used by the 200xxxxx-era template (any case).
const FILING_STATUS_RE = /(?:F\s+S|FILING\s+STATUS)\s*:\s*(.+?)\s*$/i;
const SUBHOLDING_RE    = /(?:S\s+O|SUBHOLDING\s+OF)\s*:\s*(.+?)\s*$/i;

/**
 * Strip cap-gains checkbox glyphs from an asset-name fragment.
 *
 * The checkbox column renders in the text layer as a run of isolated single
 * letters (`c d e f g`), one per line, which land inside the asset name when
 * lines are joined. They are layout artifacts, not part of the asset.
 */
function stripCheckboxGlyphs(s: string): string {
  return s
    .replace(/(?:^|\s)[b-g](?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const DESC_START_RE = /^\s+D\s+:\s*(.*)$/;     // "D : <text>"
const SUB_OWNER_RE  = /\bS\s+O\s*:\s*(.+?)(?:\s+L\s*:|\s*$)/;  // "S O : Marjorie IRA"
const LOCATION_RE   = /\bL\s*:\s*([A-Z]{2})\b/;                 // "L : US"
// The same template also spells these labels out, with the same mangled case
// (`dESCRIPTION:`, `lOCATION:`). Unmatched, they fell through to the
// asset-name continuation branch and were appended to the asset — the source
// of the 25 label-polluted assets and of descriptions never being populated.
const DESC_SPELLED_RE     = /(?:^|\s)DESCRIPTION\s*:\s*(.+?)\s*$/i;
const LOCATION_SPELLED_RE = /(?:^|\s)LOCATION\s*:\s*(.+?)\s*$/i;

/**
 * Parse a text-layer PTR.
 *
 * `authoritativeFilingId` — the DocID from the House Clerk index (or the
 * cache filename derived from it). The PDF body text is not a reliable source
 * for this: the `200xxxxx`-era template renders the label as `Filing Id #`
 * (lowercase `d`), so a case-sensitive body match yields '' and the filing
 * loses its identity. Prefer the authoritative id whenever the caller has it.
 */
export function extractPTRResult(text: string, authoritativeFilingId?: string): PTRResult {
  const textBytes = text.length;
  if (!text.trim()) {
    return { kind: 'unresolved', info: { filingId: authoritativeFilingId ?? '',
      reason: 'empty-input',
      evidence: { textBytes, tableEntered: false, datePairsSeen: 0, rowsMatched: 0 } } };
  }
  if (!isPTR(text)) {
    return { kind: 'unresolved', info: { filingId: authoritativeFilingId ?? '',
      reason: 'not-a-ptr',
      evidence: { textBytes, tableEntered: false, datePairsSeen: 0, rowsMatched: 0 } } };
  }

  // Body text is the fallback, not the source of truth. Match the label
  // case-insensitively so the lowercase-`d` template still yields an id when
  // no authoritative one was passed.
  const filingId =
    authoritativeFilingId ?? text.match(/Filing\s*ID\s*#(\d+)/i)?.[1] ?? '';
  // Case-insensitive: the 200xxxxx-era template renders these labels
  // lowercase (`name:`, `Status:`, `filer information`). A case-sensitive
  // match left filer.name empty, which the loader's identity gate rejects.
  const name =
    text.match(/^name:\s+(.+?)\s*$/im)?.[1].trim() ?? '';
  const status =
    text.match(/^status:\s+(.+?)\s*$/im)?.[1].trim() ?? '';
  const stateDistrict =
    text.match(/state\/district:?\s+(\S+)/i)?.[1] ?? '';
  const signed =
    text.match(/digitally signed:.+?,\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1] ?? null;

  const lines = text.split('\n');
  const transactions: Transaction[] = [];
  let current: Partial<Transaction> & { amountLow?: string; amountHigh?: string } | null = null;
  let inDescription = false;

  const flush = () => {
    if (!current) return;
    const tx: Transaction = {
      holder:           current.holder           ?? 'self',
      asset:            stripCheckboxGlyphs(current.asset ?? ''),
      ticker:           current.ticker           ?? null,
      assetType:        current.assetType        ?? null,
      subholding:       current.subholding       ?? null,
      location:         current.location         ?? null,
      type:             current.type             ?? '',
      date:             current.date             ?? '',
      notificationDate: current.notificationDate ?? '',
      // A single amount (no range) is legitimate — options rows disclose an
      // exact figure like `$1.00`. Only emit the range form when a high bound
      // was actually found, on the row or on a continuation line.
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
  // Structural candidate rows seen INSIDE the table region. A PTR row is
  // identified by its two adjacent MM/DD/YYYY cells (transaction date and
  // notification date) — a shape that does not occur in the header, the
  // certification block, or the footer. Counting these inside the table (as
  // opposed to a global scan of the document) is what makes the invariant
  // below a statement about the table's own structure.
  let candidateRows = 0;
  for (const raw of lines) {
    // Detect table region. The table-header line is fragmented by
    // pdftotext, so anchor on the unambiguous "Transaction Date" cell.
    if (!inTable) {
      // Case-insensitive: the 200xxxxx-era template renders this header as
      // `transaction Date` / `notification`, which a case-sensitive test
      // misses — the table is then never entered and the filing parses as
      // empty. That was the cause for 12 of the 19 repaired launch filings.
      if (TABLE_HEADER_RE.test(raw) && NOTIFICATION_RE.test(raw)) {
        inTable = true;
      }
      continue;
    }
    // Page-break artifact: multi-page PDFs repeat the table header on each
    // page. pdftotext emits it inline as text, which would otherwise be
    // appended to whatever asset/description we're inside.
    // Case-insensitive for the same reason as the header test above: this
    // template renders the repeated header as `iD  owner asset`.
    if (/id\s+owner\s+asset/i.test(raw) || /cap\.\s*$/i.test(raw) || /gains\s*>/i.test(raw) || /^\s*\$200\?/.test(raw)) {
      continue;
    }
    // Header cells that wrap onto their own line in the narrow-column
    // template (`transaction Date` above `type`). Without this they would be
    // appended to the previous row's asset name as continuation text.
    if (/^\s*(type|date|transaction\s+date|notification\s+date|amount)\s*$/i.test(raw)) {
      continue;
    }
    // Table ends at the asset-type-codes URL footer.
    if (/asset type abbreviations/.test(raw)) {
      flush();
      break;
    }
    if (!raw.trim()) continue;

    if (DATE_PAIR_RE.test(raw)) candidateRows++;

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
        ticker:           tk?.[1]?.toUpperCase() ?? undefined,
        assetType:        at?.[1]?.toUpperCase() ?? undefined,
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
    if (tk && !current.ticker) { current.ticker = tk[1].toUpperCase(); consumed = true; }

    const at = raw.match(ASSET_TYPE_RE);
    if (at && !current.assetType) { current.assetType = at[1].toUpperCase(); consumed = true; }

    const ah = raw.match(AMT_HIGH_RE);
    if (ah && !current.amountHigh) { current.amountHigh = ah[1]; consumed = true; }

    const so = raw.match(SUB_OWNER_RE) ?? raw.match(SUBHOLDING_RE);
    if (so && !current.subholding) { current.subholding = so[1].trim(); consumed = true; }

    const loc = raw.match(LOCATION_RE) ?? raw.match(LOCATION_SPELLED_RE);
    if (loc && !current.location) { current.location = loc[1].trim(); consumed = true; }

    const dsc = raw.match(DESC_SPELLED_RE);
    if (dsc && !current.description) {
      current.description = dsc[1].trim();
      // A description can wrap onto an unlabeled continuation line. Enter the
      // same continuation mode the abbreviated `D :` form uses, so the tail
      // joins the description instead of being appended to the asset name —
      // which would leave BOTH fields wrong (asset polluted, description cut
      // mid-sentence).
      inDescription = true;
      consumed = true;
      continue;
    }

    // Asset-name continuation: strip the parts we've consumed and append
    // any remaining alphabetic text to the asset name.
    let leftover = raw
      .replace(TICKER_RE, '')
      .replace(ASSET_TYPE_RE, '')
      .replace(AMT_HIGH_RE, '')
      .replace(SUB_OWNER_RE, '')
      .replace(SUBHOLDING_RE, '')
      .replace(FILING_STATUS_RE, '')
      .replace(LOCATION_RE, '')
      .replace(LOCATION_SPELLED_RE, '')
      .replace(DESC_SPELLED_RE, '')
      .trim();
    // Drop lines that are only checkbox glyphs — `c`, `d e f g`, etc.
    if (leftover && !stripCheckboxGlyphs(leftover)) leftover = '';
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

  // A readable PTR that produced no rows is a parser failure, not an empty
  // filing. Report it as unresolved with the evidence needed to diagnose it —
  // `datePairsSeen` is an independent count of how many rows the text layer
  // contains, so `datePairsSeen > 0 && rowsMatched === 0` names the defect
  // precisely.
  if (transactions.length === 0) {
    return { kind: 'unresolved', info: { filingId, reason: 'no-transaction-rows',
      evidence: { textBytes, tableEntered: inTable,
        datePairsSeen: candidateRows, rowsMatched: 0 } } };
  }

  // Row-count invariant. Recovering SOME rows is more dangerous than
  // recovering none: a partial extraction passes the loader's per-row
  // validation gate (every row it did recover is individually valid) and then
  // REPLACES a complete filing with a truncated one. Whole-for-whole
  // replacement is only sound when the row count matches the table's own
  // structure, so a shortfall is withheld as `unresolved` rather than loaded.
  if (transactions.length < candidateRows) {
    return { kind: 'unresolved', info: { filingId, reason: 'row-count-mismatch',
      evidence: { textBytes, tableEntered: inTable,
        datePairsSeen: candidateRows, rowsMatched: transactions.length } } };
  }

  return {
    kind: 'parsed',
    record: {
      filingId,
      source: 'house-clerk-ptr',
      filer: { name, status, stateDistrict },
      signedAt: usToIso(signed),
      transactions: transactions as [Transaction, ...Transaction[]],
    },
  };
}

/**
 * Back-compat wrapper: returns the record or null.
 *
 * Callers that need to distinguish "not a PTR" from "a PTR the parser could
 * not read" must use `extractPTRResult` — that distinction is the whole point
 * of the union and is erased here.
 */
export function extractPTR(text: string, authoritativeFilingId?: string): PTRRecord | null {
  const r = extractPTRResult(text, authoritativeFilingId);
  return r.kind === 'parsed' ? r.record : null;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

/** `p1:90°/osd p2:0°/page-shape? …` — `?` marks an angle no keyword confirmed. */
export function describeOcrPages(pages: readonly OcrPageRecord[]): string {
  return pages.map(p => `p${p.page}:${p.angle}°/${p.source}${p.validated ? '' : '?'}`).join(' ');
}

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
    let ocrPages: OcrPageRecord[] = [];

    // A missing OR junk text layer falls back to OCR — see textLayerNeedsOcr.
    if (textLayerNeedsOcr(text) && existsSync(pdfPath)) {
      process.stdout.write(`  ⟳ ${basename(f)} (${text.trim().length} B text layer — running OCR…)\r`);
      const ocr = ocrPdfDetailed(pdfPath);
      text = ocr.text;
      ocrPages = ocr.pages;
      usedOcr = true;
    }

    try {
      // The DocID in the cache filename comes from the House Clerk index and
      // is authoritative. The PDF body is not: the 200xxxxx-era template
      // renders the label `Filing Id #`, so a body-text match can come back
      // empty and strand the filing without an identity.
      const authoritativeId = basename(f).replace(/\.txt$/, '').match(/(\d{6,})$/)?.[1];

      const result = extractPTRResult(text, authoritativeId);
      let rec = result.kind === 'parsed' ? result.record : null;
      if (!rec && usedOcr) rec = extractPTR_OCR(text);

      // Source-agnostic: a PTR that yields no rows is never written as a
      // success, whether the text came from pdftotext or from OCR. Writing
      // one is what let 19 launch filings load as legitimately-empty.
      if (!rec) {
        if (usedOcr) process.stdout.write('\n');
        if (result.kind === 'unresolved' &&
            (result.info.reason === 'no-transaction-rows' ||
             result.info.reason === 'row-count-mismatch')) {
          const ev = result.info.evidence;
          const partial = result.info.reason === 'row-count-mismatch';
          console.warn(
            `  ⚠ ${basename(f)} [unresolved] → ${ev.rowsMatched} of ${ev.datePairsSeen} row(s) ` +
            `from ${ev.textBytes} B; table${ev.tableEntered ? '' : ' NOT'} entered` +
            (partial
              ? ' — PARTIAL PARSE, filing withheld (replacement must be whole-for-whole)'
              : usedOcr ? ' (scanned table — needs commercial OCR)'
                        : ' — LAYOUT NOT PARSED, filing withheld'),
          );
        }
        if (usedOcr) console.warn(`    OCR pages: ${describeOcrPages(ocrPages)}`);
        skipped++;
        continue;
      }
      const jsonPath = txtPath.replace(/\.txt$/, '.json');
      // OCR'd filings carry the per-page angle actually applied, so a later
      // session can reconcile a result without re-deriving the orientation.
      // Extra top-level keys are ignored by db/load-pfd.ts.
      writeFileSync(jsonPath, JSON.stringify(usedOcr ? { ...rec, ocr: { pages: ocrPages } } : rec, null, 2));
      parsed++;
      txTotal += rec.transactions.length;
      if (usedOcr) process.stdout.write('\n');
      console.log(`  ✓ ${basename(f)}${usedOcr ? ` [OCR ${describeOcrPages(ocrPages)}]` : ''} → ${rec.transactions.length} tx`);
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
