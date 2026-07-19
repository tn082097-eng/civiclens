// Assemble data/recipient_ticker.tsv from last session's curation state.
// Inputs (job 087bea9b): tierA-parent-keep.tsv (final-format mechanical keeps),
// verdicts-blind-agents.tsv (key-keyed verdicts), adjudication.tsv (name-keyed
// verdicts). Every one of the 427 worklist rows must resolve to exactly one of:
// keep / ACCEPT / REJECT / MANUAL / missing. MANUAL rows held out for the user.
import { readFileSync, writeFileSync } from 'node:fs';

const S = '/home/captainanime/.claude/jobs/087bea9b/tmp';
const WORKLIST = '/home/captainanime/Developer/civiclens/data/recipient_ticker.worklist.tsv';
const OUT = '/home/captainanime/Developer/civiclens/data/recipient_ticker.tsv';
const HOLD = '/home/captainanime/.claude/jobs/a4538a93/tmp/manual-holds.tsv';
const TODAY = '2026-07-19';

const rows = (p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean);

// worklist: key name parent ticker basis (header)
const wl = rows(WORKLIST).slice(1).map((l) => {
  const [key, name, parent, ticker, basis] = l.split('\t');
  return { key, name, parent, ticker, basis };
});

// mechanical keeps: final format w/ header
const keep = new Map<string, string>();
for (const l of rows(`${S}/tierA-parent-keep.tsv`).slice(1)) keep.set(l.split('\t')[0], l);

// key-keyed verdicts: key verdict evidence (no header)
const byKey = new Map<string, { verdict: string; evidence: string }>();
for (const l of rows(`${S}/verdicts-blind-agents.tsv`)) {
  const [key, verdict, evidence] = l.split('\t');
  byKey.set(key, { verdict, evidence });
}

// name-keyed verdicts: name parent ticker verdict evidence (no header)
const byName = new Map<string, { ticker: string; verdict: string; evidence: string }>();
for (const l of rows(`${S}/adjudication.tsv`)) {
  const [name, _parent, ticker, verdict, evidence] = l.split('\t');
  if (byName.has(name) && byName.get(name)!.verdict !== verdict) console.error(`CONFLICT name-verdicts: ${name}`);
  byName.set(name, { ticker, verdict, evidence });
}

const out: string[] = [];
const holds: string[] = ['recipient_key\trecipient_name\tsam_parent\tworklist_ticker\tsuggested\tevidence'];
let nKeep = 0, nAccept = 0, nReject = 0, nManual = 0;
const missing: string[] = [];
const conflicts: string[] = [];

for (const r of wl) {
  const k = keep.get(r.key);
  const kv = byKey.get(r.key);
  const nv = byName.get(r.name);
  if (k) {
    if (kv || nv) {
      const v = (kv ?? nv)!.verdict;
      if (v !== 'ACCEPT') { conflicts.push(`${r.key} ${r.name}: mechanical keep but verdict ${v}`); continue; }
    }
    out.push(k); nKeep++; continue;
  }
  const v = kv ?? nv;
  if (kv && nv && kv.verdict !== nv.verdict) conflicts.push(`${r.key} ${r.name}: key=${kv.verdict} name=${nv.verdict}`);
  if (!v) { missing.push(`${r.key}\t${r.name}`); continue; }
  if (nv && nv.ticker && nv.ticker !== r.ticker) conflicts.push(`${r.key} ${r.name}: adjudication ticker ${nv.ticker} != worklist ${r.ticker}`);
  if (v.verdict === 'ACCEPT') {
    out.push([r.key, r.name, r.ticker, r.basis, v.evidence, TODAY].join('\t')); nAccept++;
  } else if (v.verdict === 'REJECT') {
    nReject++;
  } else if (v.verdict.startsWith('MANUAL:')) {
    holds.push([r.key, r.name, r.parent, r.ticker, v.verdict.slice(7), v.evidence].join('\t')); nManual++;
  } else {
    conflicts.push(`${r.key} ${r.name}: unknown verdict ${v.verdict}`);
  }
}

out.sort((a, b) => (a.split('\t')[0] < b.split('\t')[0] ? -1 : 1));
const header = 'recipient_key\trecipient_name\tticker\tbasis\tevidence\tconfirmed_at';
writeFileSync(OUT, [header, ...out].join('\n') + '\n');
writeFileSync(HOLD, holds.join('\n') + '\n');

console.log(`worklist ${wl.length} → keep ${nKeep} + accept ${nAccept} + reject ${nReject} + manual-hold ${nManual} = ${nKeep + nAccept + nReject + nManual}`);
if (missing.length) { console.error(`MISSING VERDICTS (${missing.length}):`); for (const m of missing) console.error('  ' + m); }
if (conflicts.length) { console.error(`CONFLICTS (${conflicts.length}):`); for (const c of conflicts) console.error('  ' + c); }
if (missing.length || conflicts.length) process.exit(1);
console.log(`wrote ${OUT} (${out.length} confirms) + ${HOLD} (${nManual} holds)`);
process.exit(0);
