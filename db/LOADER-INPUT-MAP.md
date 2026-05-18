# Loader Input Map

The contract the bulk "organizer" must target. For each `db/load-*.ts` /
`db/backfill-*.ts`: what it reads, where, and the exact input shape.

Two classes:
- **FILE-fed** — reads local files. The organizer produces these files; no keys, no rate limits. *These are the organizer's targets.*
- **API-fed** — fetches live inside the loader. Needs keys / hits rate limits. *These must be redirected to bulk sources (rewrite the fetch, or pre-stage a file the loader reads).*

---

## FILE-fed loaders (organizer targets)

### `db/load-from-tasks.ts` — THE member-creation loader

This is how a member row is born. Walks `pipeline/task-*/`, picks the latest
dir per member where `final-review.json.readyToApply === true` and
`state.json.target.name` is set, then reads `researcher.json`.

- **Reads:** per task dir —
  - `state.json` → `{ target: { name }, updatedAt }` (selection only)
  - `final-review.json` → `{ readyToApply: bool, decision, notes }` (gate + `pipeline_runs`)
  - `researcher.json` → the payload (below)
  - optional: `summarizer.json`, `trade-analyst.json`, `predictor.json`
- **`researcher.json` shape (the contract):**
  ```
  { source, fetchedAt, target:{name,type}, confidence, warnings[],
    corrections[],
    data: {
      id, name, party, chamber, state, district, role, inOffice,
      firstElectedYear, bioguideId, fecCandidateId,
      bio,                       // string OR { summary, sourceUrl }
      donors:[ {name,type,amount,date,source,sourceUrl,confidence} ],
      votes:[ {billTitle,vote,date,question?,category?,partyPosition?,
               billNumber?,source,sourceUrl,confidence} ],
      bills:[ {title,summary?,status,sponsorRole?,introducedAt,
               source,sourceUrl,confidence,billId?} ],
      committees:[ {name,code,chamber,role,isSubcommittee,parentCode,
                    sourceUrl} ],
      controversies:[ {topic|title,summary,date,source,sourceUrl} ],
      connections:[], upcomingMeetings:[…]   // not loaded into DB
    } }
  ```
- **Writes:** `members` (from `data.id` — required, else row skipped), `donors`,
  `votes`, `bills`, `committees`, `controversies`, `pipeline_runs`, optional
  `predictions` / `members.trade_activity`.
- **Key derivations the organizer must satisfy:**
  - `members.member_id = data.id` (slug). MUST be set.
  - `votes.vote_id` = regex `…/votes/(congress-session/chamber+num)` from
    `vote.sourceUrl` → row dropped if no GovTrack-shaped URL.
  - `bills.bill_id` = from `bill.sourceUrl` `…/bill/{congress}th-congress/{slug}/{n}`
    → `"{congress}/hr|s/{n}"` (note: `/`-delimited here), else `bill.billId`.
  - `donors.donor_canonical` via `canonicalDonor()` (upper, strip suffixes).
  - dates coerced to `YYYY-MM-DD`.

> The organizer's primary job: synthesize a `researcher.json` (+ `state.json`,
> `final-review.json{readyToApply:true}`) under a fresh `pipeline/task-*/` dir,
> from bulk sources, then `load-from-tasks.ts` ingests with zero keys.

### `db/load-pfd.ts` — House PFD transactions

- **Reads:** `pfd-cache/{year}/*.json` (one JSON per filing; output of
  `skills/pfd-fetcher/extract.ts`). CLI: `--year YYYY[,YYYY] [--dry-run]`.
- **Per-file shape:**
  ```
  { filingId, source, filer:{ name, status, stateDistrict },
    signedAt,
    transactions:[ { holder, asset, ticker, assetType, subholding,
                     location, type, date, notificationDate,
                     amountBand, filingStatus, description } ] }
  ```
- **Writes:** `pfd_transactions` (DELETE by `filing_id`, then re-insert).
  Resolves filer→member by `stateDistrict` state + last-name LIKE against
  `members`. Member must already exist.
- See SOURCES.md "House Clerk … Bulk Data" — bulk index `DocID` ≠ `filingId`
  trap is documented there.

### `db/load-senate-ptr.ts` — Senate PTR transactions

- **Reads:** `senate-ptr-cache/{year}/*.json` (output of `skills/senate-ptr/fetch.ts`).
  CLI: `[--dry-run]`. Iterates all `\d{4}` year dirs.
- **Per-file shape:**
  ```
  { filingId, source, filer:{ firstName, lastName }, dateReceived,
    ptrUrl,
    transactions:[ { transactionDate, owner, ticker, asset, assetType,
                     type, amountBand, comment } ] }
  ```
- **Writes:** `pfd_transactions` (same table as House; `source_url=ptrUrl`,
  `filer_state_district=null`). Resolves by last-name LIKE vs
  `members WHERE chamber='senate'`. Member must already exist.

---

## API-fed loaders (must be redirected to bulk)

| Loader | Live source | Auth / limit | Reads | Writes | Bulk replacement |
|---|---|---|---|---|---|
| `backfill-bioguide.ts` | Congress.gov `/member?currentMember=true` (paged) | `CONGRESS_API_KEY` | `members` WHERE bioguide NULL | `members.bioguide_id` | unitedstates `legislators-current.yaml` (key-free; has bioguide + name + state + district) — fully replaces this |
| `backfill-committees.ts` | unitedstates `committees-current.yaml` + `committee-membership-current.yaml` | **none** | `members` WHERE bioguide NOT NULL | `committees` | **already bulk & key-free.** No change needed; just ensure bioguide is populated first. |
| `backfill-fec-candidate.ts` | OpenFEC `/candidates/search/` | `OPENFEC_API_KEY` (DEMO_KEY rate-capped) | `members` WHERE fec NULL | `members.fec_candidate_id` | FEC bulk `candidate master` (cn.txt) — match by name+state+office, replaces the keyed search |
| `load-cosponsored.ts` | Congress.gov `/member/{bio}/cosponsored-legislation` | `CONGRESS_API_KEY` | `members` w/ bioguide | `bills` (sponsor_role=cosponsor) | GovTrack/unitedstates bulk bill+cosponsor data, or fold sponsored+cosponsored into the organizer's `researcher.json` bills[] |
| `load-bill-summaries.ts` | Congress.gov `/bill/.../summaries` + GovTrack `/api/v2/vote` | `CONGRESS_API_KEY` | `votes` | `bill_summaries`, `votes.bill_id` | GovTrack bulk vote data (resolves vote→bill offline); bill text/summary from bulk bill data |
| `load-bill-committees.ts` | Congress.gov `/bill/.../committees` | `CONGRESS_API_KEY` | `bill_summaries` | `bill_committees` | GovTrack/unitedstates bulk bill metadata (committee refs) |
| `load-lda.ts` | `lda.senate.gov/api/v1/filings/` | none, but 25/page hard cap (~3800 pp/yr) | — | `lda_filings`, `lda_lobbyists` | Senate LDA **bulk download** (quarterly XML/JSON dumps) instead of the paged API — out of first-task scope but same pattern |

Notes:
- `backfill-committees.ts` is the proof the bulk pattern already works in-tree
  (key-free YAML → DB). Model the organizer's other sources on it.
- `load-cosponsored.ts` / `load-bill-summaries.ts` / `load-bill-committees.ts`
  are *enrichment* passes, not member-creation. A member can be ingested
  end-to-end without them; they deepen the profile. Prioritize the
  member-creation path (`load-from-tasks` ← organizer) first.

---

## Bulk source → loader routing (summary)

| Bulk source (key-free) | Feeds |
|---|---|
| House Clerk `{YEAR}FD.zip` + `ptr-pdfs/{YEAR}/{DocID}.pdf` | `load-pfd.ts` (via `extract.ts`) |
| Senate eFD (browser-harness — only JS-gated source) | `load-senate-ptr.ts` |
| unitedstates `legislators-current.yaml` | member identity → organizer `researcher.json` `data`, replaces `backfill-bioguide` |
| unitedstates `committees-current.yaml` + membership | `backfill-committees.ts` (already wired) |
| FEC bulk (`cn.txt`, `cm.txt`, contributions) | `backfill-fec-candidate.ts` replacement + organizer `donors[]` |
| GovTrack bulk votes / bills | organizer `votes[]`/`bills[]`, replaces `load-bill-summaries` API pass |
