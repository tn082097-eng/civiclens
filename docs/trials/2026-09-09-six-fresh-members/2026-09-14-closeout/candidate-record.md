# Local candidate preparation — 2026-09-14

This commit is a candidate for replays, not final certification. All six frozen members remain unchanged. No earlier pass counts toward this candidate.

## Authorized generic changes

Reconciled the existing uncommitted formatting-hold work. The House loader now checks the available authoritative inventory even when extracted JSON exists; missing, corrupt, duplicate, ambiguous, or mismatched identities fail before target rows are written. Malformed indexes cannot prove absence. Filing-year district history is used for indexed identity. Unsupported source text gets a durable `*.hold.json` receipt containing PDF/text hashes, DocID, reason and `needs_manual_formatting`; a corroborated receipt overrides stale JSON and preserves rows. Unreadable/missing sources and conversion errors fail. Withheld loads remain nonzero, including dry runs. A zero-target run without proof of emptiness remains nonzero.

The artifact validator fails corrupt JSON, requires every task to contain each required family, and rejects an unbacked empty declaration. Vault output has an isolated path override; trials set it explicitly. No detector procedure, dependency, seed, or registry changed.

## Precommit observed checks

- Targeted regression suite: 82/82 pass; red evidence retained.
- Applicable full suite: 342/342 pass, 48 files. Two baseline-related test files excluded to obey the explicit runner prohibition; exact list and classification retained.
- TypeScript: exit 0. Diff check: exit 0.
- New validator against historical Van Hollen corpus: exit 0. This is regression evidence only, not a new replay.
- Baseline in fresh disposable precommit worktree, using unchanged baseline verifier at dcd1375: exit 0; 57 members, 80.3% linkage. It is source health evidence only.
- Both parked detector status preflights: registered and unconsumed, exit 0; no permission to compute inferred.

## Frozen source recovery

The old transient source directory is no longer present. Byte-identical DB, YAML and four House XML indexes were recovered from the untouched final-s2 worktree into `../civiclens-track-b-trials/closeout-2026-09-14-inputs`; manifest records their paths and hashes. No source input was replaced with different bytes.

Eric Burlison official PDF: https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2023/8219414.pdf . Retrieval succeeded; 57,314 bytes, SHA-256 517bdde3ed131ecf67631098857fb08c3135fe38f7c6c39e5902fafb46a60f50. `pdftotext -layout` yielded only a form feed, SHA-256 7060584c3e59f0b2f12f34aa0b40faadf4aa5790a0459f3319852bcd63262cbb. Both exactly match the frozen dynamic source manifest. No OCR executed.

## Evidence conventions after freeze

Each replay starts in a new detached worktree at the candidate commit, with a fresh DB copy, initially empty runtime cache, explicitly copied hash-checked frozen disclosure/identity inputs, an isolated vault path and no previous task artifacts. Runtime outputs are evidence, not implementation edits. Commands, environment choices, source hashes, outcomes and failures will be retained. Any later implementation/protocol/input change receives an explicit invalidate/does-not-invalidate decision before certification.

Production DB starts at a766c8917a0e6b42ddc488758eb0b1a66abb37d24c873a74b4cc9d6fd7e4a38b with no WAL. Main committed HEAD is c8e1b28bc890402849e337e2c8367f98880c6136; main/Track B merge base is 04d23bf10ae3d95b6468a147bfcec29016af7d33. Dirty main is separately preserved.
