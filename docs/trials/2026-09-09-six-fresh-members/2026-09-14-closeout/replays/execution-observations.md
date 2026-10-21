# Execution observations

Candidate: d2992fda5c7e412e86b3cd47ef0248fd039e8d46.

All commands run through an external path-asserting recorder, with isolated DB/cache/pipeline/vault paths and a candidate HEAD assertion. Recorder code is archived with final evidence.

After freeze, logging was extended to include DB WAL hashes. Earlier DB-file-only hashes are not proofs of logical equality: loaders exit with a WAL containing changes. Final row comparisons include recovered WAL state, and use read-only connections after serialized writes finish. Decision: does-not-invalidate; observation-only addition changes no command, source, acceptance rule, or implementation.

Live enrichment differs from historical runs (for example Tina Smith now has 2,831 cosponsored results, rather than 2,827). This is a new replay with newly fetched inputs; the historical pass is not reused. Runtime responses/artifacts and exact commands are retained in their isolated worktree, with hashes captured at closeout. Frozen disclosure/identity/classification inputs remain byte-identical.
