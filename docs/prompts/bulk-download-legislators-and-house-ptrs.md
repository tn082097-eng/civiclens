# Bulk Download — congress-legislators + House PTR ZIPs

Hand this prompt to a fresh Claude Code session running in `~/.hermes/civiclens/`.
Self-contained: includes context, file destinations, and verification steps.

---

## Context

CivicLens is a congressional transparency project. The DuckDB warehouse at
`~/.hermes/civiclens/civiclens.duckdb` is populated for 35 members but has
two known gaps that bulk downloads from primary sources will close:

1. **Committee assignments are sparse.** `committees` table has 300 rows but
   `v_trades_near_votes.member_on_bill_committee` is corpus-wide FALSE — the
   join key is broken or the table is incomplete. The
   `unitedstates/congress-legislators` GitHub repo has the canonical mapping
   (bioguide → committee → role) and would also have replaced today's
   FEC-candidate-id backfill workaround in one fetch.

2. **House PTR ingestion is per-filing scrape.** The official disclosure
   portal also publishes annual ZIPs containing every PTR PDF for that year
   plus an XML index keyed by doc ID. The ZIP is a one-shot replacement for
   per-PDF scraping for full-year coverage.

Existing cache convention is per-source directories at the project root:
`pfd-cache/`, `senate-ptr-cache/`, `pfd-cache/fec-ie/`. Match this.

This task is **download + verify only**. Do NOT load into DuckDB. Loading is
a separate task (will need new `db/load-legislators.ts` and updates to
`db/load-pfd.ts` to read from the bulk ZIP). The deliverable is files on
disk + a one-line summary per source.

## What to download

### 1. `unitedstates/congress-legislators` (small, ~50MB)

- Source: <https://github.com/unitedstates/congress-legislators>
- Method: `git clone --depth 1 https://github.com/unitedstates/congress-legislators.git`
- Destination: `~/.hermes/civiclens/legislators-cache/`
- Resulting layout: `legislators-cache/.git/`, `legislators-cache/legislators-current.yaml`,
  `legislators-cache/committees-current.yaml`, etc.
- Verify: `ls -la legislators-cache/*.yaml` shows at least
  `legislators-current.yaml`, `legislators-historical.yaml`,
  `committees-current.yaml`, `committee-membership-current.yaml`.

### 2. House PTR annual ZIPs for 2023, 2024, 2025

- Source URL pattern: `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/<year>FD.zip`
  - Note: capitalization may vary between years (`2023FD.zip` vs `2023fd.zip`).
    Try uppercase `FD` first; if 404, try lowercase `fd`. Log which worked.
- Method: plain `curl -L -o ...` (no auth needed). Add a User-Agent header
  (`-A 'CivicLens/1.0 (research)'`) to be polite — clerk.house.gov has
  occasionally returned 403 for default curl UA in the past.
- Destination: `~/.hermes/civiclens/pfd-cache/house-bulk/<year>/`
  - Save the raw ZIP as `pfd-cache/house-bulk/<year>/<year>FD.zip`
  - Extract into `pfd-cache/house-bulk/<year>/` (will produce one XML index
    + many PDFs).
- Verify per year:
  - ZIP file present and >10MB
  - XML index file present (named like `<year>FD.xml` or similar)
  - At least 1000 PDFs extracted (a year of PTRs has thousands)
  - `head -50 <xml-file>` shows recognizable filer rows with `DocID`,
    `FilingType`, `Year`, etc.

## Constraints

- **No browser harness.** These are static URLs. Use `curl` or `fetch`.
- **No DuckDB writes.** This task only writes to the filesystem.
- **No deletion of existing files.** If `legislators-cache/` already exists,
  do `git pull` instead of `clone`. If a year's ZIP already exists and is
  non-empty, skip re-downloading unless the user passes `--refresh`.
- **Polite rate.** No need for parallelism — these are 4 files total. Sleep
  500ms between requests.

## Background or foreground?

Run in **background** via `Bash` `run_in_background: true`. The PTR ZIPs
each take a few minutes; the user does not need to watch the bytes scroll.
Stream progress to a log file under `~/.hermes/civiclens/logs/bulk-download-<timestamp>.log`
and tail at the end.

## Deliverable (report back to user)

A 4-6 line summary like:

```
✓ legislators-cache/  (<N> YAML files, last commit <date>)
✓ pfd-cache/house-bulk/2023/2023FD.zip  (<size>MB, <N> PDFs extracted)
✓ pfd-cache/house-bulk/2024/2024FD.zip  (<size>MB, <N> PDFs extracted)
✓ pfd-cache/house-bulk/2025/2025FD.zip  (<size>MB, <N> PDFs extracted)
Logs: civiclens/logs/bulk-download-<ts>.log
```

If any source fails (404, network error, archive corrupt): report which one,
keep going on the rest. Don't abort the whole run for one bad URL.

## Out of scope

- FEC bulk Schedule E / A — separate task, deferred.
- Senate eFD bulk — already covered by `senate-ptr-cache/`.
- GovTrack votes / GovInfo bill summaries — already covered.
- Any DuckDB load step — explicitly the next task, not this one.
- PDF text extraction — also next-task material.

## Civic-core compliance

- Source-first: probe URLs live before assuming structure (e.g., check
  capitalization). If a URL pattern differs from what's documented here,
  update this file with the verified pattern before exiting.
- No stub data: if a download fails, leave it failed. Do not synthesize
  placeholder ZIPs.
- Ship over plan: do not propose a new pipeline architecture in the report.
  Just download and verify.
