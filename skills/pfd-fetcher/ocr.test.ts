/**
 * OCR trigger and per-page orientation — the pure parts only.
 *
 * Nothing here runs tesseract or pdftoppm. OSD fixtures reproduce tesseract
 * 5.3 `--psm 0` output, including the two cases recorded in
 * docs/2026-07-28-pfd-ocr-rotation-finding.md: the Khanna cover page
 * (270 / Rotate 90 / 0.82) and the unreliable 180°/"Cyrillic" at 0.20.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  textLayerNeedsOcr, MIN_TRUSTED_TEXT_CHARS,
  parseOsd, orientationCandidates, scoreOrientation, orientationAccepted,
  chooseOrientation, parsePnm, encodePnm, rotatePnm, summarizeOrientation,
  type OsdResult, type OrientationTrial, type PnmImage, type OcrPageOrientation,
} from './extract.js';

// ─── OCR trigger ─────────────────────────────────────────────────────────────

const REAL_HEADER = [
  '                         Periodic Transaction Report',
  'Clerk of the House of Representatives • Legislative Resource Center',
  'Filer Information',
  'Name:               Hon. Nancy Pelosi',
  'Status:             Member',
  'State/District: CA11',
  'Transactions',
  'ID         Owner Asset                         Transaction Date       Notification Amount',
  '          SP    Apple Inc. (AAPL) [ST]        P   01/02/2024  01/15/2024   $1,000,001 - $5,000,000',
].join('\n');

test('trigger: empty and whitespace-only text layers need OCR', () => {
  assert.equal(textLayerNeedsOcr(''), true);
  assert.equal(textLayerNeedsOcr(' \n\f \n'), true);
});

test('trigger: a few dozen bytes of junk need OCR (the 51–83 B case)', () => {
  // Shapes taken from the finding doc's before-rotation noise.
  for (const junk of [
    'Te 7 EDS\nze ge a\nPW) oo |e b ! a\ngogo j= li\n',
    '\f\f\f  ~ . ,  \n i  l  |  \f',
    'Report Report Report', // vocabulary alone does not make it trusted
  ]) {
    assert.ok(Buffer.byteLength(junk) < 90);
    assert.equal(textLayerNeedsOcr(junk), true, JSON.stringify(junk));
  }
});

test('trigger: long text with no form vocabulary needs OCR', () => {
  const soup = Array.from({ length: 60 }, (_, i) => `xq${i} zv wpl ${i * 7} gk`).join('\n');
  assert.ok((soup.match(/[A-Za-z0-9]/g) ?? []).length >= MIN_TRUSTED_TEXT_CHARS);
  assert.equal(textLayerNeedsOcr(soup), true);
});

test('trigger: a real PTR text layer is trusted, in both template casings', () => {
  assert.equal(textLayerNeedsOcr(REAL_HEADER), false);
  const lowerEra = [
    '                        P erioDic t ranSaction r ePort',
    'filer information',
    'name:              Hon. Lois Frankel',
    'tranSactionS',
    'iD        owner asset                          transaction Date       notification amount',
    '          American Express Company (AXP) P            12/03/2021 01/15/2022   $1,001 - $15,000',
    ' b I CERTIFY that the statements I have made on the attached Periodic Transaction Report are true, complete, and correct.',
  ].join('\n');
  assert.equal(textLayerNeedsOcr(lowerEra), false);
});

test('trigger: the threshold boundary is on letters+digits, not bytes', () => {
  const at = 'Filer ' + 'a'.repeat(MIN_TRUSTED_TEXT_CHARS - 5);
  assert.equal(textLayerNeedsOcr(at), false);
  const padded = 'Filer ' + 'a'.repeat(MIN_TRUSTED_TEXT_CHARS - 6) + ' .|-'.repeat(200);
  assert.equal(textLayerNeedsOcr(padded), true);
});

// ─── OSD parsing ─────────────────────────────────────────────────────────────

const OSD_KHANNA = [
  'Estimating resolution as 200',
  'Page number: 0',
  'Orientation in degrees: 270',
  'Rotate: 90',
  'Orientation confidence: 0.82',
  'Script: Latin',
  'Script confidence: 1.67',
  '',
].join('\n');

const OSD_CYRILLIC = [
  'Page number: 0',
  'Orientation in degrees: 180',
  'Rotate: 180',
  'Orientation confidence: 0.20',
  'Script: Cyrillic',
  'Script confidence: 0.33',
].join('\n');

test('osd: parses a full tesseract block', () => {
  assert.deepEqual(parseOsd(OSD_KHANNA), {
    rotate: 90, orientation: 270, orientationConfidence: 0.82,
    script: 'Latin', scriptConfidence: 1.67,
  });
});

test('osd: parses the unreliable Cyrillic reading as-is (filtering is not its job)', () => {
  const r = parseOsd(OSD_CYRILLIC);
  assert.equal(r?.rotate, 180);
  assert.equal(r?.script, 'Cyrillic');
  assert.equal(r?.orientationConfidence, 0.2);
});

test('osd: upright page (0 / 0) parses', () => {
  const r = parseOsd('Orientation in degrees: 0\nRotate: 0\nOrientation confidence: 4.10\n');
  assert.equal(r?.rotate, 0);
  assert.equal(r?.script, null);
  assert.equal(r?.scriptConfidence, null);
});

test('osd: failures and corrupt blocks return null', () => {
  for (const out of [
    '',
    'Too few characters. Skipping this page\nWarning. Invalid resolution 0 dpi. Using 70 instead.\nError during processing.\n',
    'Failed loading language \'osd\'\nTesseract couldn\'t load any languages!\n',
    'Orientation in degrees: 270\nOrientation confidence: 0.82\n',          // no Rotate
    'Orientation in degrees: 45\nRotate: 315\nOrientation confidence: 1\n', // off-grid
    'Orientation in degrees: 270\nRotate: 270\nOrientation confidence: 1\n', // pair disagrees
    'Orientation in degrees: 90\nRotate: 270\nOrientation confidence: .\n',  // NaN confidence
  ]) {
    assert.equal(parseOsd(out), null, JSON.stringify(out));
  }
});

// ─── Rotation choice ─────────────────────────────────────────────────────────

const PORTRAIT = { width: 1679, height: 2168 };
const LANDSCAPE = { width: 2200, height: 1696 };
const osd = (rotate: 0 | 90 | 180 | 270, conf: number, script: string | null = 'Latin'): OsdResult =>
  ({ rotate, orientation: ((360 - rotate) % 360) as OsdResult['orientation'],
     orientationConfidence: conf, script, scriptConfidence: null });

test('candidates: always all four angles, each once', () => {
  for (const page of [PORTRAIT, LANDSCAPE]) {
    for (const o of [null, osd(270, 3), osd(180, 0.2, 'Cyrillic')]) {
      const angles = orientationCandidates(page, o).map(c => c.angle);
      assert.deepEqual([...angles].sort((a, b) => a - b), [0, 90, 180, 270]);
    }
  }
});

test('candidates: no OSD → page shape first (portrait 90, landscape 0)', () => {
  assert.deepEqual(orientationCandidates(PORTRAIT, null)[0], { angle: 90, source: 'page-shape' });
  assert.deepEqual(orientationCandidates(LANDSCAPE, null)[0], { angle: 0, source: 'page-shape' });
});

test('candidates: a confident Latin OSD reading goes first', () => {
  const c = orientationCandidates(LANDSCAPE, osd(270, 2.5));
  assert.deepEqual(c.slice(0, 2), [{ angle: 270, source: 'osd' }, { angle: 0, source: 'page-shape' }]);
});

test('candidates: the 0.20 Cyrillic reading does not lead', () => {
  const c = orientationCandidates(PORTRAIT, parseOsd(OSD_CYRILLIC));
  assert.deepEqual(c[0], { angle: 90, source: 'page-shape' });
  assert.equal(c.find(x => x.angle === 180)?.source, 'search');
});

test('candidates: confident but non-Latin OSD does not lead', () => {
  assert.equal(orientationCandidates(PORTRAIT, osd(180, 5, 'Cyrillic'))[0].source, 'page-shape');
});

test('candidates: OSD agreeing with page shape is credited to OSD, not duplicated', () => {
  const c = orientationCandidates(PORTRAIT, osd(90, 1.2));
  assert.deepEqual(c[0], { angle: 90, source: 'osd' });
  assert.equal(c.filter(x => x.angle === 90).length, 1);
});

// ─── Keyword validation ──────────────────────────────────────────────────────

// Readable output the finding doc recorded after the correct rotation.
const READABLE = [
  'Poriodic Transaction Report',
  'FULL ASSET NAME | TYPE OF | DATE | DATE NOTIFIED | AMOUNT OF TRANSACTION',
  'U.S. House of Representatives',
].join('\n');
// Mirrored output from the wrong direction, also verbatim from the doc.
const MIRRORED = 'dX3 OTZ Wd OWNS X37J Id¥v/TVS\nNOLLOVSNVUL 4O LNNORY\n';

test('score: readable header scores, mirrored text does not', () => {
  assert.deepEqual(scoreOrientation(READABLE), { keywordHits: 4, mirroredHits: 0 });
  assert.equal(orientationAccepted(scoreOrientation(READABLE)), true);
  assert.equal(scoreOrientation(MIRRORED).keywordHits, 0);
  assert.equal(orientationAccepted(scoreOrientation(MIRRORED)), false);
});

test('score: literally reversed text is flagged as mirrored', () => {
  const reversed = READABLE.split('\n').map(l => [...l].reverse().join('')).join('\n');
  const s = scoreOrientation(reversed);
  assert.equal(s.keywordHits, 0);
  assert.equal(s.mirroredHits, 4);
  assert.equal(orientationAccepted(s), false);
});

test('score: one keyword is not enough to accept', () => {
  assert.equal(orientationAccepted(scoreOrientation('FULL ASSET NAME\nnoise')), false);
});

test('score: byte count is irrelevant — more bytes of noise never win', () => {
  // 2205 B mirrored vs 1931 B correct, per the 2026-08-21 measurement.
  const bigNoise = MIRRORED.repeat(80);
  assert.ok(bigNoise.length > READABLE.length * 10);
  const trials: OrientationTrial[] = [
    { angle: 270, source: 'osd', score: scoreOrientation(bigNoise) },
    { angle: 90, source: 'page-shape', score: scoreOrientation(READABLE) },
  ];
  assert.deepEqual(chooseOrientation(trials), { index: 1, validated: true });
});

const trial = (angle: 0 | 90 | 180 | 270, keywordHits: number, mirroredHits = 0): OrientationTrial =>
  ({ angle, source: 'search', score: { keywordHits, mirroredHits } });

test('choose: first accepted trial wins even if a later one scores higher', () => {
  assert.deepEqual(chooseOrientation([trial(0, 1), trial(90, 2), trial(270, 4)]),
    { index: 1, validated: true });
});

test('choose: nothing accepted → most hits, unvalidated; ties to the earlier', () => {
  assert.deepEqual(chooseOrientation([trial(90, 0), trial(0, 1), trial(270, 1), trial(180, 0)]),
    { index: 1, validated: false });
});

test('choose: a mirrored-dominant trial is never the fallback pick', () => {
  assert.deepEqual(chooseOrientation([trial(90, 0), trial(270, 1, 3)]),
    { index: 0, validated: false });
});

test('choose: nothing scores anywhere → first candidate, unvalidated', () => {
  assert.deepEqual(chooseOrientation([trial(90, 0), trial(0, 0), trial(270, 0), trial(180, 0)]),
    { index: 0, validated: false });
  assert.throws(() => chooseOrientation([]));
});

// ─── PNM rotation ────────────────────────────────────────────────────────────

/** 3 wide × 2 tall:  a b c / d e f */
const GRID: PnmImage = { magic: 'P5', width: 3, height: 2, maxval: 255, data: Buffer.from('abcdef') };
const rows = (img: PnmImage) => {
  const out: string[] = [];
  for (let y = 0; y < img.height; y++) out.push(img.data.toString('latin1', y * img.width, (y + 1) * img.width));
  return out;
};

test('rotate: 90 is counter-clockwise (PIL rotate(90, expand=True))', () => {
  const r = rotatePnm(GRID, 90);
  assert.equal(r.width, 2);
  assert.equal(r.height, 3);
  // Right column comes to the top, read top to bottom → left to right.
  assert.deepEqual(rows(r), ['cf', 'be', 'ad']);
});

test('rotate: 270 is clockwise, 180 flips both axes, 0 is identity', () => {
  assert.deepEqual(rows(rotatePnm(GRID, 270)), ['da', 'eb', 'fc']);
  assert.deepEqual(rows(rotatePnm(GRID, 180)), ['fed', 'cba']);
  assert.equal(rotatePnm(GRID, 0), GRID);
});

test('rotate: inverse pairs and four quarter-turns return the original', () => {
  assert.deepEqual(rotatePnm(rotatePnm(GRID, 90), 270), GRID);
  assert.deepEqual(rotatePnm(rotatePnm(GRID, 180), 180), GRID);
  let r = GRID;
  for (let i = 0; i < 4; i++) r = rotatePnm(r, 90);
  assert.deepEqual(r, GRID);
});

test('rotate: P6 keeps RGB triples together', () => {
  const rgb: PnmImage = { magic: 'P6', width: 2, height: 1, maxval: 255,
    data: Buffer.from([1, 2, 3, 4, 5, 6]) };
  const r = rotatePnm(rgb, 90);
  assert.deepEqual([r.width, r.height], [1, 2]);
  assert.deepEqual([...r.data], [4, 5, 6, 1, 2, 3]);
});

test('pnm: parse handles comments and round-trips through encode', () => {
  const raw = Buffer.concat([Buffer.from('P5\n# pdftoppm\n3 2\n# c\n255\n', 'latin1'), Buffer.from('abcdef')]);
  const img = parsePnm(raw);
  assert.deepEqual([img.magic, img.width, img.height, img.maxval], ['P5', 3, 2, 255]);
  assert.equal(img.data.toString('latin1'), 'abcdef');
  assert.deepEqual(parsePnm(encodePnm(rotatePnm(img, 90))), rotatePnm(img, 90));
});

test('pnm: raster bytes that look like whitespace are not eaten', () => {
  const raw = Buffer.concat([Buffer.from('P5 2 1 255\n', 'latin1'), Buffer.from([0x0a, 0x20])]);
  assert.deepEqual([...parsePnm(raw).data], [0x0a, 0x20]);
});

test('pnm: rejects what it cannot rotate correctly', () => {
  assert.throws(() => parsePnm(Buffer.from('P4\n2 2\n\x00\x00')), /magic/);
  assert.throws(() => parsePnm(Buffer.from('P5\n2 2\n65535\n')), /maxval/);
  assert.throws(() => parsePnm(Buffer.from('P5\n2 2\n255\nab')), /truncated/);
  assert.throws(() => parsePnm(Buffer.from('P5\n0 2\n255\n')), /dimensions/);
});

// ─── Provenance summary ──────────────────────────────────────────────────────

test('summary: counts applied angles and unvalidated pages', () => {
  const page = (angle: 0 | 90, validated: boolean): OcrPageOrientation =>
    ({ page: 1, width: 1, height: 1, angle, source: 'page-shape', validated,
       keywordHits: 0, osd: null, tried: [] });
  assert.equal(summarizeOrientation([page(90, true), page(0, true), page(90, true)]), '90°×2 0°×1');
  assert.equal(summarizeOrientation([page(90, true), page(90, false)]), '90°×2, 1 unvalidated');
});
