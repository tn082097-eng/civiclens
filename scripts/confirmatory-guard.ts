// Manual preflight for preregistered confirmatory analyses (ADR 0003).
//
// A machine-checkable preflight: reads the registry docs/confirmatory-runs.md
// and reports, per detector id, whether a confirmatory run may proceed. Thin CLI
// over the shared core in pipeline/patterns/_confirmatory-guard.ts — the SAME
// logic the confirmatory runners call internally (assertConfirmatoryAllowed).
//
//   npm run guard:confirmatory -- <detector-id> [<detector-id> ...]
//
// Exit 0 = clear (registered-unconsumed, or invalidated with a repair pending).
// Exit 1 = STOP: a consumed, non-invalidated run exists (or the id is unknown).
// Exit 2 = usage / registry-parse error.
//
// This is the supported command-path preflight. Note it does NOT make reruns
// impossible on its own — enforcement for the supported runners comes from those
// runners calling assertConfirmatoryAllowed() in-path. A caller who invents a
// new, unguarded execution path is outside the guarded workflow (Phase 2 gap).

import { loadRegistry, checkDetectors, type CheckResult } from '../pipeline/patterns/_confirmatory-guard.js';

const ids = process.argv.slice(2).filter(a => !a.startsWith('-'));
if (ids.length === 0) {
  console.error('usage: npm run guard:confirmatory -- <detector-id> [<detector-id> ...]');
  process.exit(2);
}

let results: CheckResult[];
try {
  results = checkDetectors(ids, loadRegistry());
} catch (e: any) {
  console.error(`FAIL: ${e.message}`);
  process.exit(2);
}

let blocked = false;
for (const r of results) {
  if (r.blocked) { console.error(r.message); blocked = true; }
  else console.log(r.message);
}

if (blocked) {
  console.error('\nconfirmatory guard: BLOCKED — do not run any statistical computation for the above detector(s).');
  process.exit(1);
}
console.log('\nconfirmatory guard: clear.');
process.exit(0);
