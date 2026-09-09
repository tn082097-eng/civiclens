/**
 * PTR text-layer parser regression tests.
 *
 * Pins the 2026-08-22 repair of the `200xxxxx`-era House PTR layout, which
 * silently produced `transactions: []` for 19 launch-roster filings holding
 * 193 real transactions. Fixtures are trimmed from real cached filings and
 * span four members and all four observed layout variants.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPTRResult, extractPTR } from './extract.js';

/** Header block shared by the `200xxxxx`-era template (lowercase labels). */
const HEAD_LOWER = [
  '                        P erioDic t ranSaction r ePort',
  '          Clerk of the House of Representatives • Legislative Resource Center',
  'filer information',
  'name:              Hon. Lois Frankel',
  'Status:            Member',
  'State/District: FL21',
  'tranSactionS',
  'iD        owner asset                          transaction Date       notification amount',
  '                                               type                   Date',
].join('\n');

/** Modern template, capitalised labels — the layout that already worked. */
const HEAD_UPPER = [
  '                         Periodic Transaction Report',
  'Filer Information',
  'Name:               Hon. Nancy Pelosi',
  'Status:             Member',
  'State/District: CA11',
  'Transactions',
  'ID         Owner Asset                         Transaction Date       Notification Amount',
].join('\n');

const FOOTER = [
  '* For the complete list of asset type abbreviations, please visit https://fd.house.gov/reference/asset-type-codes.aspx.',
  // The certification paragraph is what identifies a PTR (see isPTR); real
  // filings render the banner as `P erioDic t ranSaction r ePort`, so this
  // line is the only clean occurrence of the phrase.
  ' b I CERTIFY that the statements I have made on the attached Periodic Transaction Report are true, complete, and correct.',
].join('\n');

function parse(text: string, id?: string) {
  return extractPTRResult(text, id);
}

// ─── Layout variant 1: trailing cap-gains checkbox glyph ────────────────────

test('variant 1: trailing checkbox glyph does not break the row', () => {
  const text = [HEAD_LOWER,
    '          American Express Company (AXP) P            12/03/2021 01/15/2022   $1,001 - $15,000        c',
    '                      [ST]',
    '                      FILING STATUS: New',
    FOOTER].join('\n');
  const r = parse(text, '20020235');
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  const [tx] = r.record.transactions;
  assert.equal(tx.type, 'purchase');
  assert.equal(tx.date, '2021-12-03');
  assert.equal(tx.notificationDate, '2022-01-15');
  assert.equal(tx.amountBand, '$1,001 - $15,000');
  assert.equal(tx.asset, 'American Express Company', 'checkbox glyph must not enter the asset name');
  assert.equal(tx.ticker, 'AXP');
});

test('variant 1: multi-line checkbox run (c d e f g) never pollutes the asset', () => {
  const text = [HEAD_LOWER,
    '          Affirm Holdings, Inc. - Class A      S (partial)   12/28/2021 01/04/2022   $1,001 - $15,000        c',
    '                                                                                                            d',
    '                                                                                                            e',
    '                                                                                                            f',
    '                                                                                                            g',
    '                      (AFRM) [ST]',
    '                      FILING STATUS: New',
    '                      SUBHOLDING OF: Morgan Stanley - Select UMA Account # 1',
    FOOTER].join('\n');
  const r = parse(text, '20020154');
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  const [tx] = r.record.transactions;
  assert.equal(tx.asset, 'Affirm Holdings, Inc. - Class A');
  assert.equal(tx.type, 'sale-partial');
  assert.equal(tx.ticker, 'AFRM');
  assert.equal(tx.assetType, 'ST');
  assert.equal(tx.subholding, 'Morgan Stanley - Select UMA Account # 1');
  assert.doesNotMatch(tx.asset, /FILING|SUBHOLDING|\b[b-g]\b/, 'no layout artifacts in the asset');
});

// ─── Layout variant 2: amount-high wrapped to a later line ──────────────────

test('variant 2: amount high wrapped onto a continuation line is joined', () => {
  const text = [HEAD_LOWER,
    '                     Wynn Resorts, Limited (WYNN)      P        12/20/2021 12/21/2021     $50,001 -           c',
    '                     [ST]                                                                 $100,000',
    '                     FILING STATUS: New',
    FOOTER].join('\n');
  const r = parse(text, '20020135');
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  const [tx] = r.record.transactions;
  assert.equal(tx.amountBand, '$50,001 - $100,000', 'wrapped high bound must be reassembled');
  assert.equal(tx.asset, 'Wynn Resorts, Limited');
});

// ─── Layout variant 3: single amount, no range ──────────────────────────────

test('variant 3: a single exact amount (no range) is preserved verbatim', () => {
  const text = [HEAD_UPPER,
    '           SP     Roblox Corporation Class A (RBLX)    S        01/20/2023 01/20/2023     $1.00',
    '                  [OP]',
    FOOTER].join('\n');
  const r = parse(text, '20022320');
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  const [tx] = r.record.transactions;
  assert.equal(tx.amountBand, '$1.00', 'exact options amounts are real disclosures, not bands');
  assert.equal(tx.holder, 'spouse');
  assert.equal(tx.assetType, 'OP');
});

// ─── Layout variant 4: leading numeric row id ───────────────────────────────

test('variant 4: a leading numeric row id does not shift the columns', () => {
  const text = [HEAD_UPPER,
    '2000097616 JT      Cerence Inc. (CRNC) [ST]            S        08/15/2022 09/06/2022     $1,001 - $15,000',
    FOOTER].join('\n');
  const r = parse(text, '20021727');
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  const [tx] = r.record.transactions;
  assert.equal(tx.holder, 'joint');
  assert.equal(tx.asset, 'Cerence Inc.');
  assert.equal(tx.ticker, 'CRNC');
  assert.equal(tx.type, 'sale');
  assert.equal(tx.date, '2022-08-15');
});

// ─── Transaction type comes from its own column ─────────────────────────────

test('transaction type is read from the type column, not from incidental text', () => {
  // The asset name itself contains a bare "P" and the description mentions
  // "purchased" — neither may influence the type, which is `S (partial)`.
  const text = [HEAD_UPPER,
    '           SP     Company P Holdings Inc. (XYZ) [ST]   S (partial)  03/01/2023 03/02/2023  $1,001 - $15,000',
    '                  D : 100 call options purchased 12/20/21',
    FOOTER].join('\n');
  const r = parse(text);
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  assert.equal(r.record.transactions[0].type, 'sale-partial');
});

// ─── Zero rows ⇒ unresolved (never a successful empty parse) ────────────────

test('a readable PTR that yields zero rows is unresolved, not an empty success', () => {
  // Header present and a date pair visible, but the row is unparseable.
  const text = [HEAD_LOWER, '   ??? garbled row 12/03/2021 01/15/2022 ???', FOOTER].join('\n');
  const r = parse(text, '20020235');
  assert.equal(r.kind, 'unresolved');
  if (r.kind !== 'unresolved') return;
  assert.equal(r.info.reason, 'no-transaction-rows');
  assert.equal(r.info.filingId, '20020235', 'identity is retained so the failure is attributable');
  assert.ok(r.info.evidence.datePairsSeen > 0, 'evidence records how many rows should have existed');
  assert.equal(r.info.evidence.rowsMatched, 0);
});

test('blank input is unresolved with reason empty-input', () => {
  const r = parse('   \n  \n');
  assert.equal(r.kind, 'unresolved');
  if (r.kind !== 'unresolved') return;
  assert.equal(r.info.reason, 'empty-input');
});

test('a non-PTR document is unresolved with reason not-a-ptr', () => {
  const r = parse('Filing Type:  Annual Report\nSome other document entirely.');
  assert.equal(r.kind, 'unresolved');
  if (r.kind !== 'unresolved') return;
  assert.equal(r.info.reason, 'not-a-ptr');
});

test('extractPTR (back-compat) returns null rather than a zero-row record', () => {
  const text = [HEAD_LOWER, '   ??? garbled 12/03/2021 01/15/2022 ???', FOOTER].join('\n');
  assert.equal(extractPTR(text), null);
});

// ─── Filing identity from the authoritative index ───────────────────────────

test('authoritative filing id wins over body text', () => {
  const text = [HEAD_LOWER, 'Filing ID #99999999',
    '          American Express Company (AXP) P    12/03/2021 01/15/2022   $1,001 - $15,000   c',
    FOOTER].join('\n');
  const r = parse(text, '20020235');
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  assert.equal(r.record.filingId, '20020235', 'index DocID is authoritative');
});

test('lowercase `Filing Id #` in body text is still recovered when no id is passed', () => {
  const text = [HEAD_LOWER, 'Filing Id #20020235',
    '          American Express Company (AXP) P    12/03/2021 01/15/2022   $1,001 - $15,000   c',
    FOOTER].join('\n');
  const r = parse(text);
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  assert.equal(r.record.filingId, '20020235');
});

// ─── Filer identity across both templates ───────────────────────────────────

test('filer name and state/district parse from the lowercase-label template', () => {
  const text = [HEAD_LOWER,
    '          American Express Company (AXP) P    12/03/2021 01/15/2022   $1,001 - $15,000   c',
    FOOTER].join('\n');
  const r = parse(text, '20020235');
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  assert.equal(r.record.filer.name, 'Hon. Lois Frankel');
  assert.equal(r.record.filer.status, 'Member');
  assert.equal(r.record.filer.stateDistrict, 'FL21');
});

// ─── Existing (already-working) layout is unchanged ─────────────────────────

test('the pre-existing capitalised layout produces identical normalized output', () => {
  const text = [HEAD_UPPER,
    '           SP     Walt Disney Company (DIS) [ST]       P        01/21/2022 01/21/2022     $1,000,001 - $5,000,000',
    '                  F S : New',
    FOOTER].join('\n');
  const r = parse(text, '20020515');
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  assert.deepEqual(r.record.transactions[0], {
    holder: 'spouse',
    asset: 'Walt Disney Company',
    ticker: 'DIS',
    assetType: 'ST',
    subholding: null,
    location: null,
    type: 'purchase',
    date: '2022-01-21',
    notificationDate: '2022-01-21',
    amountBand: '$1,000,001 - $5,000,000',
    filingStatus: 'New',
    description: '',
  });
});

// ─── Multi-row / multi-member ───────────────────────────────────────────────

test('multiple rows in one filing are kept distinct (no merging, no duplicates)', () => {
  const text = [HEAD_LOWER,
    '                     Wynn Resorts, Limited (WYNN)      P        12/20/2021 12/21/2021     $50,001 -           c',
    '                     [ST]                                                                 $100,000',
    '                     FILING STATUS: New',
    '                     Wynn Resorts, Limited (WYNN)      S        12/20/2021 12/21/2021     $50,001 -           b',
    '                     [ST]                                                                 $100,000',
    '                     FILING STATUS: New',
    FOOTER].join('\n');
  const r = parse(text, '20020135');
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  const txs = r.record.transactions;
  assert.equal(txs.length, 2, 'both rows recovered');
  assert.deepEqual(txs.map(t => t.type), ['purchase', 'sale'], 'same asset, opposite sides — order preserved');
  assert.equal(new Set(txs.map(t => `${t.asset}|${t.type}|${t.date}`)).size, 2, 'rows are distinct');
});

// ─── A2 repair: case-mangled labels, tickers, and asset types ───────────────
// The 200xxxxx-era template renders label text with mangled case in the text
// layer: `D`→`d`, `L`→`l`, `B`→`b`. Fixtures below are transcribed from cached
// filings — data/caches/pfd-cache/2022/gottheimer-josh-20020154.txt:221-230
// (Nitori) and the ticker/asset-type forms observed across the frozen 19.

test('spelled DESCRIPTION:/LOCATION: labels populate their fields, not the asset name', () => {
  const text = [HEAD_LOWER,
    '     JT    Nitori Holdings Co. Ltd AdR           S (partial)        12/09/2021 01/04/2022   $1,001 - $15,000      c',
    '           (NCLTY) [OT]',
    '           FILING STATUS: New',
    '           SUbHOLdING OF: Morgan Stanley - Select UMA Account # 1',
    '           LOCATION: US',
    '           dESCRIPTION: AdR stock',
    FOOTER].join('\n');
  const r = parse(text, '20020154');
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  const t = r.record.transactions[0];
  assert.doesNotMatch(t.asset, /LOCATION|DESCRIPTION/i, 'no label text survives in the asset name');
  assert.equal(t.asset, 'Nitori Holdings Co. Ltd AdR');
  assert.equal(t.location, 'US');
  assert.equal(t.description, 'AdR stock');
});

test('mangled-case lOCATION: is recognised the same as LOCATION:', () => {
  const text = [HEAD_LOWER,
    '     SP    Chubb Limited (Cb)                    P        01/03/2022 01/04/2022   $1,001 - $15,000',
    '           lOCATION: US',
    FOOTER].join('\n');
  const r = parse(text, '20020235');
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  assert.equal(r.record.transactions[0].location, 'US');
  assert.doesNotMatch(r.record.transactions[0].asset, /LOCATION/i);
});

test('abbreviated L label preserves a full city, state, and country location', () => {
  // jackson-jonathan-20022795.txt:18-22. The abbreviated location label can
  // carry more than a two-letter country code; the whole value belongs in the
  // location field and none of the label may leak into the asset name.
  const text = [HEAD_UPPER,
    '                      3 I Roadwork, Inc. [OL]                S              04/28/2023 05/10/2023        $1,001 - $15,000',
    '                      F     S        : New',
    '                      L         : Chicago, IL, US',
    '                      D            : Roadwork Company',
    FOOTER].join('\n');
  const r = parse(text, '20022795');
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  const tx = r.record.transactions[0];
  assert.equal(tx.asset, '3 I Roadwork, Inc.');
  assert.equal(tx.location, 'Chicago, IL, US');
});

test('abbreviated country-only location remains separate from a same-line subholding', () => {
  const text = [HEAD_UPPER,
    '          JT    Example Holdings (EX) [ST]           P              04/28/2023 05/10/2023        $1,001 - $15,000',
    '                S O : Morgan Stanley Trust Account  L : US',
    FOOTER].join('\n');
  const r = parse(text, '20022795');
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  const tx = r.record.transactions[0];
  assert.equal(tx.subholding, 'Morgan Stanley Trust Account');
  assert.equal(tx.location, 'US');
  assert.equal(tx.asset, 'Example Holdings');
});

test('a DESCRIPTION on the primary row line does not pollute the asset', () => {
  // gottheimer-josh-20020393 tx 19 — options rows carry the description inline.
  const text = [HEAD_LOWER,
    '     JT    Microsoft Corporation                 P        08/16/2022 09/07/2022   $1,001 - $15,000',
    '           (MSFT) [OP]',
    '           dESCRIPTION: Call options; Strike Price $145; Expires 9/16/2022',
    FOOTER].join('\n');
  const r = parse(text, '20020393');
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  const t = r.record.transactions[0];
  assert.equal(t.asset, 'Microsoft Corporation');
  assert.match(t.description, /^Call options; Strike Price \$145/);
});

test('case-mangled tickers are recovered and normalised to uppercase', () => {
  // Real forms from the frozen 19: (AAPl) (AMd) (AbbV) (Cb) (TSlA) (luV) (KMb).
  for (const [raw, want] of [
    ['(AAPl)', 'AAPL'], ['(AMd)', 'AMD'], ['(AbbV)', 'ABBV'],
    ['(Cb)', 'CB'], ['(TSlA)', 'TSLA'], ['(luV)', 'LUV'], ['(KMb)', 'KMB'],
  ] as const) {
    const text = [HEAD_LOWER,
      `     SP    Some Holding Company ${raw}            P        01/03/2022 01/04/2022   $1,001 - $15,000`,
      FOOTER].join('\n');
    const r = parse(text, '20020235');
    assert.equal(r.kind, 'parsed', `${raw} parsed`);
    if (r.kind !== 'parsed') continue;
    assert.equal(r.record.transactions[0].ticker, want, `${raw} → ${want}`);
  }
});

test('case-mangled asset types are recovered and normalised', () => {
  const text = [HEAD_LOWER,
    '     JT    AllianceBernstein Holding L.P. units   P        01/03/2022 01/04/2022   $1,001 - $15,000',
    '           [Ol]',
    FOOTER].join('\n');
  const r = parse(text, '20020235');
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  assert.equal(r.record.transactions[0].assetType, 'OL', '[Ol] is [OL] with a mangled L');
});

test('uppercase tickers and asset types are unchanged by the case-tolerant patterns', () => {
  const text = [HEAD_LOWER,
    '     SP    Apple Inc. (AAPL)                      P        01/03/2022 01/04/2022   $1,001 - $15,000',
    '           [ST]',
    FOOTER].join('\n');
  const r = parse(text, '20020235');
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  assert.equal(r.record.transactions[0].ticker, 'AAPL');
  assert.equal(r.record.transactions[0].assetType, 'ST');
});

// ─── A2 repair: structural row-count invariant ─────────────────────────────
// A filing where SOME rows match is more dangerous than one where none do: it
// passes the loader's per-row validation gate and REPLACES a complete filing
// with a partial one. The invariant counts structural candidate rows inside
// the transaction table only — never a global date-pair scan, which would
// count header, certification, and footer dates outside the table region.

test('a filing whose table rows partially match is unresolved, not partially parsed', () => {
  // Three structural rows in the table; the middle one uses a shape the
  // primary matcher does not cover, so only two would be recovered.
  const text = [HEAD_LOWER,
    '     SP    Apple Inc. (AAPL)                      P        01/03/2022 01/04/2022   $1,001 - $15,000',
    '     SP    Broken Row Inc. (BRK)                  ?        01/05/2022 01/06/2022   $1,001 - $15,000',
    '     SP    Cisco Systems (CSCO)                   P        01/07/2022 01/08/2022   $1,001 - $15,000',
    FOOTER].join('\n');
  const r = parse(text, '20020235');
  assert.equal(r.kind, 'unresolved', 'a partial parse must not be reported as success');
  if (r.kind !== 'unresolved') return;
  assert.equal(r.info.reason, 'row-count-mismatch');
  assert.equal(r.info.evidence.rowsMatched, 2);
  assert.equal(r.info.evidence.datePairsSeen, 3, 'structural candidate rows inside the table');
});

test('the row-count invariant ignores date pairs outside the transaction table', () => {
  // A date pair in the certification/footer block must not inflate the
  // structural count and spuriously withhold a complete filing.
  const text = [HEAD_LOWER,
    '     SP    Apple Inc. (AAPL)                      P        01/03/2022 01/04/2022   $1,001 - $15,000',
    FOOTER,
    '     Certified on 02/01/2022 02/02/2022 by the filer.',
  ].join('\n');
  const r = parse(text, '20020235');
  assert.equal(r.kind, 'parsed', 'a complete filing is not withheld by out-of-table dates');
  if (r.kind !== 'parsed') return;
  assert.equal(r.record.transactions.length, 1);
});

test('a fully-matching multi-row filing satisfies the invariant', () => {
  const text = [HEAD_LOWER,
    '     SP    Apple Inc. (AAPL)                      P        01/03/2022 01/04/2022   $1,001 - $15,000',
    '     SP    Cisco Systems (CSCO)                   S        01/07/2022 01/08/2022   $1,001 - $15,000',
    FOOTER].join('\n');
  const r = parse(text, '20020235');
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  assert.equal(r.record.transactions.length, 2);
});

test('a wrapped spelled DESCRIPTION continues into the description, not the asset', () => {
  // pelosi-nancy-20020515.txt:18-27 — the description runs onto an unlabeled
  // continuation line. Without continuation handling the tail is appended to
  // the asset AND the description is truncated mid-sentence: both fields wrong.
  const text = [HEAD_LOWER,
    '          SP        AllianceBernstein Holding l.P.            P                 01/27/2022 01/27/2022            $250,001 -',
    '                    units (AB) [Ol]                                                                              $500,000',
    '                    FIlINg STATuS: New',
    '                    lOCATION: New York, NY, uS',
    '                    DESCRIPTION: Purchased 10,000 units in a global asset management firm providing investment management and research',
    '                    services worldwide to institutional, high-net-worth and retail investors.',
    FOOTER].join('\n');
  const r = parse(text, '20020515');
  assert.equal(r.kind, 'parsed');
  if (r.kind !== 'parsed') return;
  const t = r.record.transactions[0];
  assert.equal(t.asset, 'AllianceBernstein Holding l.P. units', 'wrapped description text stays out of the asset');
  assert.match(t.description, /research services worldwide to institutional/, 'description is joined, not truncated');
  assert.match(t.description, /retail investors\.$/);
  assert.equal(t.ticker, 'AB');
  assert.equal(t.assetType, 'OL');
});
