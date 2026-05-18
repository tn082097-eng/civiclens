# GovTrack — `vote_voter` source notes

Frozen reference for the votes branch of `fetch.ts`. The Researcher pulls
member-level vote records from this endpoint because Congress.gov v3 has no
first-class member-votes resource. If the response shape changes, update this
file *and* the parser in lockstep.

## Endpoint

```
GET https://www.govtrack.us/api/v2/vote_voter
    ?person=<govtrack_id>
    &limit=<n>
    &offset=<n>
    &sort=-created
```

- `person` — GovTrack numeric ID (resolved via `legislators-{current,historical}.yaml`
  in `unitedstates/congress-legislators`, mapped from bioguide → govtrack).
- `limit` — server returns up to this many objects per call. Hard cap is
  effectively response-time bound; see "Pagination" below.
- `offset` — zero-based skip.
- `sort=-created` — newest first.

No auth. No rate-limit headers. Public read.

## Pagination

Empirically (2026-04-25, see live probe `/tmp/probe-votes.ts`):

| limit | wall time |
|------:|----------:|
|   100 |     ~14 s |
|   200 |     >30 s |
|   600 |     >60 s |

Response time grows roughly linearly with limit; large limits silently exceed
the 15s default timeout in `get()`. **Always paginate in batches of 100 with a
~25s per-call timeout.** Do *not* bump to 200+ "to be faster" — you'll hit
silent zero-results regressions like the one fixed 2026-04-25.

## Response shape (frozen sample)

See `govtrack-vote_voter-sample.json` for one full object captured from
Schumer (person=300087) on 2026-04-25. Shape summary:

```
{
  meta: { limit, offset, total_count },
  objects: [{
    created:    ISO-8601 timestamp of the vote record,
    option:     { key: "+"|"-"|"0"|"P", value: "Yea"|"Nay"|"Not Voting"|"Present", vote: <id>, winner: bool },
    person:     { bioguideid, firstname, lastname, link, ... }   # member metadata
    person_role:{ role_type, role_type_label, party, state, ... } # member's role at vote time
    vote: {
      category:        "passage"|"amendment"|"nomination"|"cloture"|"procedural"|"other",
      category_label:  human-readable category,
      chamber:         "senate"|"house",
      congress:        number,
      created:         ISO-8601,
      link:            absolute URL — https://www.govtrack.us/congress/votes/<congress>-<session>/<chamber-letter><number>,
      number:          vote number within session,
      passed:          bool,
      question:        full vote question text (often prefixed with "S.123:" / "H.R.456:"),
      question_details:short context,
      related_bill:    GovTrack bill id or null,
      required:        "1/2"|"2/3"|...,
      result:          "Bill Passed"|"Amendment Rejected"|...,
      session:         year string,
      source:          "senate"|"house",
      total_plus:      yea count,
      total_minus:     nay count,
      total_other:     present/not-voting count,
      vote_type:       "On Passage"|"On the Amendment"|...,
      ...
    },
    voter_type:       "member"|...,
    voteview_extra_code: string
  }]
}
```

`vote.link` was relative in earlier API versions and absolute as of 2026-04-25.
The parser handles both via a `startsWith('http')` check on line 705 of
`fetch.ts`.

## What the parser keeps

`fetch.ts` `fetchPolitician` reduces each object to:

```ts
{
  billTitle:  vote.question — stripped of "H.R.\d+:" / "S.\d+:" prefix,
  vote:       normalizeVote(option.value),  // "yea" | "nay" | "abstain" | "absent"
  date:       created.slice(0, 10),
  source:     "govtrack.us",
  sourceUrl:  vote.link,
  confidence: 0.99,
}
```

Then filters to `date <= today` (excludes future-dated records, which
GovTrack occasionally produces during recess sessions) and slices to 500.

## What the parser drops

| Field                       | Why dropped                                                         |
|-----------------------------|---------------------------------------------------------------------|
| `vote.category`             | **Worth bringing back.** Distinguishes passage / amendment / nomination / cloture — useful for predictor base-rate splits and for narrative ("voted against cloture on X"). Currently lost. |
| `vote.category_label`       | Human-readable mirror of the above.                                 |
| `vote.passed`, `result`     | Whole-chamber outcome. Useful for "voted against the prevailing side". |
| `vote.required`             | Threshold (1/2, 2/3, 3/5). Relevant for cloture vs. simple-majority nuance. |
| `vote.related_bill`         | GovTrack bill ID — would let us join to bill metadata.              |
| `vote.margin`, `total_*`    | Closeness metrics. Could feed predictor as a feature.               |
| `person_role.party`         | Party at vote time. We use current-party from Congress.gov instead, which loses party-switch history. |
| `option.key`                | Single-char code. `option.value` is sufficient.                     |
| Everything in `person`      | Member bio — already pulled from Congress.gov.                      |

## Open follow-up

- **Restore `vote.category`** to the kept fields. Predictor's base-rate model
  is currently flat across vote types; splitting it per category (passage,
  amendment, nomination, cloture) is a small change with calibration upside.
- The `total_count` in `meta` is the total votes cast by this member ever
  (Schumer ≈ 18 378). Could expose to the UI as a tenure metric.

## Provenance

- Sample captured 2026-04-25 from `?person=300087&limit=100&sort=-created`.
- Trimmed to one object for repo-friendliness — fetch live for full shape verification.
- API has no documented public version contract. Treat as best-effort.
