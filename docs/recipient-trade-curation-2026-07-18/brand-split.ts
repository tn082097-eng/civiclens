/**
 * Refined blind rule for the demoted parent-name Tier A subclass.
 * QA found the stale-SAM.gov-parent failure mode (CARRIER→RTX): name
 * equality proves the parent IS the issuer, not that the link is CURRENT.
 * Brand-containment repair: re-accept mechanically ONLY when the
 * recipient's own name contains the issuer's distinctive brand token(s) —
 * a subsidiary still carrying the parent brand (STRYKER SALES→SYK).
 * Every observed failure (Carrier, Rome Research, HEAT, Aesynt, Peraton,
 * Messer, Atmosphere) fails this test. Outcome-blind, deterministic.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { normCorpName } from '/home/captainanime/Developer/civiclens/lib/recipient-match.js';

const A = '/home/captainanime/.claude/jobs/087bea9b/tmp/tierA-accepts.tsv';
const WORKLIST = '/home/captainanime/Developer/civiclens/.superpowers/sdd/recipient-worklist-2026-07-18.tsv';
const OUT_KEEP = '/home/captainanime/.claude/jobs/087bea9b/tmp/tierA-parent-keep.tsv';
const OUT_DEMOTE = '/home/captainanime/.claude/jobs/087bea9b/tmp/tierA-parent-demote.tsv';

// worklist gives us parent_name per key (accepts file lacks it)
const wl = new Map<string, { name: string; parent: string; ticker: string }>();
for (const line of readFileSync(WORKLIST, 'utf8').split('\n').slice(1).filter(Boolean)) {
  const [key, name, parent, ticker] = line.split('\t');
  wl.set(key, { name, parent, ticker });
}

const lines = readFileSync(A, 'utf8').split('\n').filter(Boolean);
const keep: string[] = [lines[0]];
const demote: string[] = ['recipient_key\trecipient_name\tparent_name\tcandidate_ticker\tbasis'];
let nOwn = 0, nKeep = 0, nDemote = 0;
for (const line of lines.slice(1)) {
  const [key, name, ticker, basis] = line.split('\t');
  if (basis === 'own-name') { keep.push(line); nOwn++; continue; }
  const w = wl.get(key);
  if (!w) throw new Error(`key ${key} missing from worklist`);
  const brandTokens = normCorpName(w.parent).split(' ').filter(Boolean);
  const nameTokens = new Set(normCorpName(w.name).split(' ').filter(Boolean));
  const contained = brandTokens.length > 0 && brandTokens.every((t) => nameTokens.has(t));
  if (contained) {
    // strengthen evidence wording to record the rule applied
    const cols = line.split('\t');
    cols[4] += `; brand-consistent subsidiary name ('${w.name}' carries issuer brand)`;
    keep.push(cols.join('\t'));
    nKeep++;
  } else {
    demote.push([key, w.name, w.parent, w.ticker, 'parent-name'].join('\t'));
    nDemote++;
  }
}
writeFileSync(OUT_KEEP, keep.join('\n') + '\n');
writeFileSync(OUT_DEMOTE, demote.join('\n') + '\n');
console.log(`own-name kept: ${nOwn} | parent-name brand-kept: ${nKeep} | demoted to verify: ${nDemote}`);
