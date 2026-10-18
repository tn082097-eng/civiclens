/**
 * OCR trigger and page-orientation tests.
 *
 * Pure-function tests only: tesseract, poppler and the PFD PDF cache are not
 * exercised here. OSD fixtures are the outputs recorded in
 * docs/2026-07-28-pfd-ocr-rotation-finding.md; OCR snippets are quoted from
 * the same document. None of this proves the pipeline reads real scans.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  textLayerNeedsOcr, parseOsd, rotationCandidates, scoreOrientationKeywords,
  pickOrientation, rotatePgm, parsePgmHeader, describeOcrPages,
  OSD_MIN_CONFIDENCE, type OsdResult, type OcrPageRecord,
} from './extract.js';

// ─── textLayerNeedsOcr ───────────────────────────────────────────────────────

const REAL_TEXT_LAYER = [
  '                         Periodic Transaction Report',
  'Clerk of the House of Representatives • Legislative Resource Center',
  'Filer Information',
  'Name:               Hon. Nancy Pelosi',
  'Status:             Member',
  'State/District: CA11',
  'Transactions',
  'ID         Owner Asset                         Transaction Date       Notification Amount',
  '                                               Type                   Date',
  '           SP    Apple Inc. (AAPL) [ST]         P   01/14/2024 01/16/2024 $1,000,001 - $5,000,000',
  '                 F S : New',
  '                 D : Purchased 50 call options with a strike price of $100.',
  '* For the complete list of asset type abbreviations, please visit https://fd.house.gov/reference/asset-type-codes.aspx.',
  'I CERTIFY that the statements I have made on the attached Periodic Transaction Report are true, complete, and correct.',
].join('\n');

test('empty and whitespace-only text layers need OCR', () => {
  assert.equal(textLayerNeedsOcr(''), true);
  assert.equal(textLayerNeedsOcr(' \n\f\n  \t'), true);
});

test('a few dozen bytes of junk need OCR (the old !text.trim() trigger skipped these)', () => {
  // Shape of the 51–83 byte junk files: stray glyphs and form feeds.
  const junk = '\f  ~ ‘ . i |\n\f , ; - ! l\n\f Te 7 EDS ze ge a\n\f PW) oo |e b\n\f';
  assert.ok(junk.trim().length > 0, 'fixture must be truthy to reproduce the bug');
  assert.ok(Buffer.byteLength(junk) >= 51 && Buffer.byteLength(junk) <= 83);
  assert.equal(textLayerNeedsOcr(junk), true);
});

test('long but structureless text (symbols, no words) needs OCR', () => {
  const noise = '| ~ |= li . | 7 . ; | |e b ! a ;\n'.repeat(20);
  assert.ok(noise.replace(/\s+/g, '').length >= 200);
  assert.equal(textLayerNeedsOcr(noise), true);
});

test('a real text-layer PTR is trusted and never sent to OCR', () => {
  assert.equal(textLayerNeedsOcr(REAL_TEXT_LAYER), false);
});

// ─── parseOsd ─────────────────────────────────────────────────────────────────

/** Recorded on 2024/khanna-rohit-8220626.pdf (finding doc, "Evidence"). */
const OSD_KHANNA = [
  'Page number: 0',
  'Orientation in degrees: 270',
  'Rotate: 90',
  'Orientation confidence: 0.82',
  'Script: Latin',
  'Script confidence: 1.67',
  '',
].join('\n');

/** The unreliable answer the finding doc warns about: 180° / Cyrillic at 0.20. */
const OSD_UNRELIABLE = [
  'Page number: 0',
  'Orientation in degrees: 180',
  'Rotate: 180',
  'Orientation confidence: 0.20',
  'Script: Cyrillic',
  'Script confidence: 0.53',
].join('\n');

test('parseOsd reads rotation, orientation, confidence and script', () => {
  assert.deepEqual(parseOsd(OSD_KHANNA), {
    orientation: 270, rotate: 90, confidence: 0.82, script: 'Latin', scriptConfidence: 1.67,
  });
  assert.deepEqual(parseOsd(OSD_UNRELIABLE), {
    orientation: 180, rotate: 180, confidence: 0.2, script: 'Cyrillic', scriptConfidence: 0.53,
  });
});

test('parseOsd tolerates CRLF and leading tesseract warnings', () => {
  const noisy = 'Estimating resolution as 200\r\nWarning: Invalid resolution 0 dpi.\r\n' +
    OSD_KHANNA.replace(/\n/g, '\r\n');
  assert.equal(parseOsd(noisy)?.rotate, 90);
});

test('parseOsd returns null when OSD gave no answer', () => {
  assert.equal(parseOsd(''), null);
  assert.equal(parseOsd('Too few characters. Skipping this page\nError during processing.\n'), null);
  // Missing confidence is not an answer either.
  assert.equal(parseOsd('Orientation in degrees: 270\nRotate: 90\n'), null);
});

test('parseOsd rejects angles that are not quarter turns', () => {
  assert.equal(parseOsd(OSD_KHANNA.replace('Rotate: 90', 'Rotate: 45')), null);
});

// ─── rotationCandidates ───────────────────────────────────────────────────────

const osd = (rotate: 0 | 90 | 180 | 270, confidence: number): OsdResult =>
  ({ orientation: ((360 - rotate) % 360) as 0 | 90 | 180 | 270, rotate, confidence, script: 'Latin', scriptConfidence: 1 });

test('confident OSD is tried first, then the page-shape prior, then the rest', () => {
  const c = rotationCandidates(parseOsd(OSD_KHANNA), 1679, 2168);
  assert.deepEqual(c.map(x => x.angle), [90, 0, 180, 270]);
  assert.deepEqual(c.map(x => x.source), ['osd', 'fallback', 'fallback', 'fallback']);
});

test('low-confidence OSD is ignored — the 180°/Cyrillic page falls to the shape prior', () => {
  const c = rotationCandidates(parseOsd(OSD_UNRELIABLE), 1696, 2200);
  assert.deepEqual(c[0], { angle: 90, source: 'page-shape' });
  assert.ok(c.findIndex(x => x.angle === 180) > 0);
});

test('page-shape prior: landscape pixels ⇒ 0°, portrait pixels ⇒ +90° (never −90)', () => {
  assert.deepEqual(rotationCandidates(null, 2200, 1696)[0], { angle: 0, source: 'page-shape' });
  assert.deepEqual(rotationCandidates(null, 1696, 2200)[0], { angle: 90, source: 'page-shape' });
  // 270 = −90, the mirrored direction: always last-resort, never the default.
  assert.equal(rotationCandidates(null, 1696, 2200).at(-1)!.angle, 270);
});

test('OSD at exactly the confidence floor counts; just below does not', () => {
  assert.equal(rotationCandidates(osd(180, OSD_MIN_CONFIDENCE), 2200, 1696)[0].source, 'osd');
  assert.equal(rotationCandidates(osd(180, OSD_MIN_CONFIDENCE - 0.01), 2200, 1696)[0].source, 'page-shape');
});

test('every candidate list covers all four angles exactly once', () => {
  for (const o of [null, osd(0, 5), osd(90, 5), osd(270, 5), osd(180, 0.1)]) {
    for (const [w, h] of [[100, 200], [200, 100]]) {
      const angles = rotationCandidates(o, w, h).map(x => x.angle).sort((a, b) => a - b);
      assert.deepEqual(angles, [0, 90, 180, 270]);
    }
  }
});

// ─── keyword scoring / pickOrientation ───────────────────────────────────────

/** Correct-angle output quoted in the finding doc. */
const READABLE = 'Periodic Transaction Report\nFULL ASSET NAME | TYPE OF | DATE | DATE NOTIFIED | AMOUNT OF TRANSACTION\nU.S. House of Representatives';
/** Wrong-direction (mirrored) output quoted in the finding doc. */
const MIRRORED = 'dX3 OTZ Wd OWNS X37J Id¥v/TVS\nNOLLOVSNVUL 4O LNNORY';
/** Unrotated noise quoted in the finding doc. */
const NOISE = 'Te 7 EDS\nze ge a\nPW) oo |e b ! a\ngogo j= li';

test('keyword score separates readable output from mirrored output and noise', () => {
  assert.equal(scoreOrientationKeywords(READABLE), 3);
  assert.equal(scoreOrientationKeywords('Poriodic Transaction Report\nNAME: Rohit Khanna'), 1);
  assert.equal(scoreOrientationKeywords(MIRRORED), 0);
  assert.equal(scoreOrientationKeywords(NOISE), 0);
});

test('pickOrientation takes the most keyword hits, not the most bytes', () => {
  // Mirrored output measured LARGER than correct output (2205 B vs 1931 B).
  const choice = pickOrientation([
    { angle: 270, source: 'osd', keywordHits: scoreOrientationKeywords(MIRRORED.repeat(10)) },
    { angle: 90, source: 'page-shape', keywordHits: scoreOrientationKeywords(READABLE) },
  ]);
  assert.equal(choice.angle, 90);
  assert.equal(choice.validated, true);
});

test('pickOrientation breaks ties toward the earlier candidate', () => {
  const choice = pickOrientation([
    { angle: 90, source: 'osd', keywordHits: 1 },
    { angle: 0, source: 'page-shape', keywordHits: 1 },
  ]);
  assert.equal(choice.angle, 90);
});

test('pickOrientation marks a page with no keyword anywhere as unvalidated', () => {
  const choice = pickOrientation([
    { angle: 0, source: 'page-shape', keywordHits: 0 },
    { angle: 90, source: 'fallback', keywordHits: 0 },
  ]);
  assert.deepEqual(choice, { angle: 0, source: 'page-shape', keywordHits: 0, validated: false });
  assert.throws(() => pickOrientation([]));
});

// ─── rotatePgm ────────────────────────────────────────────────────────────────

/** 3×2 image:  a b c / d e f  (pixel values 1..6). */
const pgm3x2 = () => Buffer.concat([Buffer.from('P5\n# test\n3 2\n255\n', 'ascii'), Buffer.from([1, 2, 3, 4, 5, 6])]);
const pixels = (b: Buffer) => [...b.subarray(parsePgmHeader(b).offset)];

test('rotatePgm 0° returns the image unchanged', () => {
  assert.deepEqual(rotatePgm(pgm3x2(), 0), pgm3x2());
});

test('rotatePgm +90° is counter-clockwise (PIL rotate(90)): top-right corner moves to top-left', () => {
  const r = rotatePgm(pgm3x2(), 90);
  assert.deepEqual(parsePgmHeader(r), { width: 2, height: 3, maxval: 255, offset: parsePgmHeader(r).offset });
  // c f / b e / a d
  assert.deepEqual(pixels(r), [3, 6, 2, 5, 1, 4]);
});

test('rotatePgm 180° reverses the image', () => {
  assert.deepEqual(pixels(rotatePgm(pgm3x2(), 180)), [6, 5, 4, 3, 2, 1]);
});

test('rotatePgm 270° (−90, clockwise) is the mirror image of +90, not the same turn', () => {
  const r = rotatePgm(pgm3x2(), 270);
  // d a / e b / f c
  assert.deepEqual(pixels(r), [4, 1, 5, 2, 6, 3]);
  assert.notDeepEqual(pixels(r), pixels(rotatePgm(pgm3x2(), 90)));
});

test('four quarter turns compose to the identity', () => {
  let b: Buffer = pgm3x2();
  for (let i = 0; i < 4; i++) b = rotatePgm(b, 90);
  assert.deepEqual(pixels(b), pixels(pgm3x2()));
  assert.deepEqual(pixels(rotatePgm(rotatePgm(pgm3x2(), 90), 270)), pixels(pgm3x2()));
});

test('rotatePgm rejects non-P5 input and truncated pixel data', () => {
  assert.throws(() => rotatePgm(Buffer.from('P6\n1 1\n255\n\0\0\0'), 90), /P5/);
  assert.throws(() => rotatePgm(Buffer.from('P5\n3 2\n255\n\x01\x02'), 90), /truncated/);
  assert.throws(() => rotatePgm(Buffer.from('P5\n1 1\n65535\n\0\0'), 90), /8-bit/);
});

// ─── describeOcrPages ─────────────────────────────────────────────────────────

test('describeOcrPages records the applied angle and flags unvalidated pages', () => {
  const page = (n: number, angle: 0 | 90, source: OcrPageRecord['source'], validated: boolean): OcrPageRecord =>
    ({ page: n, width: 1, height: 1, osd: null, angle, source, keywordHits: validated ? 2 : 0, validated, anglesTried: [angle] });
  assert.equal(describeOcrPages([page(1, 90, 'osd', true), page(2, 0, 'page-shape', false)]),
    'p1:90°/osd p2:0°/page-shape?');
});
