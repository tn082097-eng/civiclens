# Smoke attempt 1 - Guy Reschenthaler

**Outcome:** invalidated; development evidence only; not a fresh smoke pass.

The deterministic rank-1 selection was valid and the isolated pipeline append
completed for Guy Reschenthaler (`R000610`). Before the remaining onboarding
steps were run, an operator attempted to inspect the House fetcher's help text
with `skills/pfd-fetcher/fetch.ts --help`. That program has no help guard and
interpreted the call as an unscoped corpus download.

The process was terminated. Its writes were confined to the disposable trial
cache. The entire named trial worktree was removed and recreated from the
frozen source commit and database; no production database, central Track B
worktree, public artifact, or remote was changed.

Because the pipeline had already consumed Guy's primary-source inputs, he is no
longer untouched. He must not be rerun or counted as fresh evidence. Any later
run is a regression check only. The smoke proceeds to rank 2 under the same
frozen candidate ordering.
