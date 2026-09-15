# Command classification before execution

- `npm run guard:confirmatory -- trade-vote-alignment spousal-trade-timing`: `scripts/confirmatory-guard.ts` and `pipeline/patterns/_confirmatory-guard.ts` inspected completely. Filesystem-only status check; no computation. Exit 0, both registered and unconsumed. No authority to compute follows from this result.
- `npm run verify:baseline`: `scripts/verify-baseline.ts` inspected completely. Database health queries, not a confirmatory runner. Its connection opens writable; run only in fresh scratch worktrees.
- `npm test`: package script runs test files, not baseline CLIs. Inspect timing test entry points before full suite.
- No outcome-bearing command has run.

Initial Track B HEAD: dcd1375faff9e82bc99d09389446439797906d7b. Production DB and untouched final-s2 source copy both SHA-256 a766c8917a0e6b42ddc488758eb0b1a66abb37d24c873a74b4cc9d6fd7e4a38b; production WAL absent. Track B default DB is 12 KB, SHA-256 cc752c5cb51a8084506c6fb04d61f175969c4fc179825a77dcae18d640619bce; do not use it for ingestion.

## Applicable test suite

The package test glob includes `pipeline/patterns/confirmatory-guard-inpath.test.ts`, which spawns two real `*-baseline.ts` runners, and `pipeline/patterns/timing-detectors-baseline.test.ts`, which imports the parked timing control harness. Both files were inspected. The user prohibits executing any baseline runner; these two files are excluded from the applicable non-confirmatory suite. No package script or registry is changed. The selected test file list and output are retained. Remaining tests operate on fixtures/throwaway databases.

Vault isolation: `CIVICLENS_VAULT_DIR` selects an isolated trial output directory; default behavior is preserved. This path configuration prevents a scratch onboarding from regenerating shared member notes.
