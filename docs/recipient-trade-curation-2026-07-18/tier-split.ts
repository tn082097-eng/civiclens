/**
 * Blind-curation tier split for the recipient-trade worklist.
 * Deterministic, outcome-blind: uses ONLY identity fields + SEC universe.
 *
 * Tier A (mechanical accept): the matched-side name equals the SEC issuer
 * title with suffixes INCLUDED (only case/punctuation differ), OR the
 * suffix-stripped normalized name has >=2 tokens (distinctive multi-token
 * match). Single-token stripped matches (FRONTIER-trap shape) -> Tier B.
 * Tier B: subagent identity verification, reject-on-doubt.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { normCorpName } from '/home/captainanime/Developer/civiclens/lib/recipient-match.js';

const WORKLIST = '/home/captainanime/Developer/civiclens/.superpowers/sdd/recipient-worklist-2026-07-18.tsv';
const SEC = '/home/captainanime/Developer/civiclens/data/caches/sec-cache/company_tickers.json';
const OUT_A = '/home/captainanime/.claude/jobs/087bea9b/tmp/tierA-accepts.tsv';
const OUT_B = '/home/captainanime/.claude/jobs/087bea9b/tmp/tierB-verify.tsv';
const TODAY = '2026-07-18';

// suffix-INCLUSIVE loose normalization: case/punct/whitespace only.
const loose = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const secRows: Array<{ ticker: string; title: string }> = JSON.parse(readFileSync(SEC, 'utf8'));
// cik not in the trimmed cache (ticker,title only) — cite issuer title; CIK optional.
const byTicker = new Map<string, string>();
for (const r of secRows) if (!byTicker.has(r.ticker.toUpperCase())) byTicker.set(r.ticker.toUpperCase(), r.title);

const lines = readFileSync(WORKLIST, 'utf8').split('\n').filter(Boolean);
const header = lines[0];
if (header !== 'recipient_key\trecipient_name\tparent_name\tcandidate_ticker\tbasis') {
  throw new Error(`unexpected worklist header: ${header}`);
}

const aOut: string[] = ['recipient_key\trecipient_name\tticker\tbasis\tevidence\tconfirmed_at'];
const bOut: string[] = [header];
let nA = 0, nB = 0;
for (let i = 1; i < lines.length; i++) {
  const [key, name, parent, ticker, basis] = lines[i].split('\t');
  const matched = basis === 'parent-name' ? parent : name;
  const title = byTicker.get(ticker);
  if (!title) { bOut.push(lines[i]); nB++; continue; } // ticker vanished from SEC cache — force verify
  const fullEq = loose(matched) === loose(title);
  const tokens = normCorpName(matched).split(' ').filter(Boolean);
  if (fullEq || tokens.length >= 2) {
    const evidence =
      basis === 'parent-name'
        ? `SAM.gov parent '${parent}' matches SEC issuer '${title}' (${ticker}); subsidiary '${name}' per SAM.gov hierarchy`
        : `Recipient name '${name}' matches SEC issuer '${title}' (${ticker})`;
    aOut.push([key, name, ticker, basis, evidence, TODAY].join('\t'));
    nA++;
  } else {
    bOut.push(lines[i]);
    nB++;
  }
}
writeFileSync(OUT_A, aOut.join('\n') + '\n');
writeFileSync(OUT_B, bOut.join('\n') + '\n');
console.log(`Tier A accepts: ${nA}  |  Tier B to verify: ${nB}  |  total ${nA + nB}`);
