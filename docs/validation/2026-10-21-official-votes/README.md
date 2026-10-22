# Full-window official-vote evidence, 2026-10-21

This compact package accompanies the generic House label / Senate empty-document
repairs. Its archive files are byte-identical copies of completed local evidence,
indexed by original path, size and SHA-256 in `manifest.json`. Absolute paths in
those records identify the original executions; they are not checkout-portable.
The archived `candidate-fingerprint.json` identifies the code used for validation,
not the later documentation/packaging commit.

**PASS_AFTER_LOCAL_REPAIRS; NOT CERTIFIED.** The listing snapshot covers
2022-10-21 through 2026-10-21: House1,989rolls and Senate1,675rolls. Two members per
chamber normalized and persisted7,328rows in isolated test DBs. Both reference
member snapshots remained unchanged after loading the second member. Unsupported
and ambiguous bill resolutions stay explicit with null bill identities.

`house-summary.json` / `senate-summary.json` give complete run outcomes;
`*-census.json` and `*-persistence.json` give the count and isolation evidence.
The incomplete original House acquisition and failed original Senate replay are
retained in failure records. House offline revalidation is explicitly derived,
retains original outcomes/receipts and binds its decision logic. Reviewer outputs
and controller dispositions distinguish source review from executed verification.

## Availability limits

The full retained HTTP bodies, listing pages, acquisition manifests, bridge outputs,
normalized vote exports and temporary DuckDBs remain in the original local
`artifacts/full-window-validation-2026-10-21/` run directories. They are not
committed here. The archive retains their hashes and provenance but cannot by itself
independently replay or certify the full source window from a fresh clone. Two
exact official source fixtures and original receipt records are committed under
`fixtures/votes/official-samples/` for portable regression/interoperability checks.

Archived harness and revalidation utility files have `.txt` suffixes and retain
their original bytes. Their relative-root assumptions and original run dependencies
are historical. They are evidence of what ran, not a standalone replay distribution.
Original execution-plan exclusions describe the delegated lead's phase; later
controller repairs/replays and their review dispositions are separate recorded work.

See the [validation report](../../full-window-official-vote-validation-2026-10-21.md)
for exact results, failed-attempt accounting and remaining certification gates.
Fresh integration checks are recorded in `integration-verification.json`.
