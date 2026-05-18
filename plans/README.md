# CivicLens — Future Plans

Deeper drafts of specific initiatives. Shallow one-liners still live in `../IDEAS.md`.

Each plan should answer: what's the goal, why does it matter, what data/sources, what's the scope boundary.

## Current plans

- [Researcher parallelization](researcher-parallelization.md) — split the research phase into parallel sub-agents (Bills / Votes / Donors / Bio). Structural cleanup, cuts wall-time.
- [Revolving-door agent](revolving-door-agent.md) — new specialist agent tracking ex-officials who moved into industry (or the reverse). Enables the classic accountability pattern the pipeline currently can't surface.
- [Financial-disclosures agent](financial-disclosures-agent.md) — pulls STOCK Act, OGE 278, and judicial AO-10 filings so trade dates can be cross-referenced against policy dates. Unlocks cabinet, WH staff, and judiciary — all invisible to the pipeline today.
- [Prediction agent](prediction-agent.md) — backtestable base-rate predictions (votes, bill passage, revolving-door destinations) with a public calibration log. **MVP implemented** in `skills/predictor/` — vote calibration harness only.
- [Court-cases agent](court-cases-agent.md) — pulls federal-judge opinions (CourtListener, SCOTUS) plus legislators' pre-political litigation and party-to-litigation records. Enables the first CivicLens judge page and joins recusal patterns against judicial financial disclosures.

## Pending work (green-lit, not yet shipped)

Do these before drafting new plans.

1. ~~**Wire predictor into pipeline.ts**~~ — done 2026-04-25. Slotted between Data Checker and Connection Mapper, non-fatal. Warn-path verified on Pelosi (`task-1777087994834`); calibration path verified on Schumer (`task-1777093888884`, 497 binary votes, best=laplace-smoothed Brier 0.2232).
2. ~~**GovTrack vote fetch returning 0**~~ — done 2026-04-25 in `skills/researcher/fetch.ts`. Three edits: `get()` accepts a `timeoutMs` param (default 15s); `fetchGovTrackVotes` paginates in 100-vote batches at 25s each (single 600-call always blew past 15s and was silently caught); `sourceUrl` no longer double-prefixes when `v.vote.link` is absolute. Verified live: Schumer 500 votes, 0 warnings.
3. ~~**FEC multi-cycle donor union**~~ — done 2026-04-25 in `skills/researcher/fetch.ts`. Loops cycles `[current, -2, -4, -6]`; sums `amount` per donor; tracks latest contribution date and cycles touched. Schema unchanged (`amount` now means cumulative across 4 cycles, `date` = most recent). Verified live on Schumer (`task-1777095425982`, APPROVED) — top donors now reflect lifetime (Janney $1.37M, Stifel $71K, Blue Senate 2022 PAC $47K). Walltime adds ~90s. **Caveat**: Connection Mapper shared-donor count dropped (4 vs 20) until the rest of the corpus is re-fetched with multi-cycle — Schumer's lifetime top-20 doesn't overlap much with peers' single-cycle top-20s. Re-running the corpus is its own session.
4. ~~**Source-notes workflow on one existing sub-agent**~~ — done 2026-04-25. `skills/researcher/sources/govtrack.md` documents the `vote_voter` endpoint, pagination empirics, frozen sample (`govtrack-vote_voter-sample.json`), and the dropped fields with rationale. Open follow-up captured: restoring `vote.category` to the kept-fields set would give the predictor a per-category base-rate split (small change, real calibration upside).

## Session notes — 2026-04-25

- Predictor wired into pipeline.ts (between Data Checker and Connection Mapper, non-fatal). Warn-path verified on Pelosi; calibration-path verified on Schumer (Brier 0.2232 laplace-smoothed, 497 binary votes train/test split).
- GovTrack vote fetch regression fixed: `get()` accepts `timeoutMs`; `fetchGovTrackVotes` paginates 100/call at 25s; absolute `vote.link` no longer double-prefixed.
- FEC donor query now unions 4 cycles (`[current, -2, -4, -6]`); `amount` means cumulative, `date` is most recent. Adds ~90s/run. Connection Mapper shared-donor counts will be artificially low until corpus is re-fetched with multi-cycle (Schumer's lifetime top-20 doesn't overlap peers' cycle-only top-20s).
- Source-notes started under `skills/researcher/sources/`. Documented: GovTrack `vote_voter` (with `vote.category` flagged as a worth-restoring drop) and House Clerk PFD (endpoint, ZIP/XML shape, PTR text format, asset-type codes, amount bands, pitfalls).
- PFD PTR extractor shipped: `skills/pfd-fetcher/extract.ts` parses `pdftotext -layout` output → JSON. Verified on 25 PTRs (Pelosi 5, MTG 20) → 170 transactions; 84% ticker recovery (remaining nulls are Treasury Bills/LLCs/ETFs without public tickers, which is correct). Schema includes `subholding` (e.g. "Marjorie IRA") and `location` for retirement-account holdings. Annual reports (`O/A/D/T/B`) deliberately deferred — different multi-table layout. Not yet wired into the pipeline; consumed when there's a Policy Events dataset to join against.

## Session notes — 2026-04-20

- Bio switched from Wikipedia REST to deterministic Congress.gov-derived construction. Wikipedia is now forbidden as a primary source. See `skills/researcher/CONTRACT.md`.
- Predictor MVP shipped in `skills/predictor/` — vote-outcome calibration harness with 5 baseline models. Smoke-tested against synthetic data, math verified.
- Researcher's `fetchCongressMember` now returns `firstElectedYear` and `district`. Rubio now resolves; Hegseth still returns null (correct — no bioguide, gap closed by financial-disclosures plan).
