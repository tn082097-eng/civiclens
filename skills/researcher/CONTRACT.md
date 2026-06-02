# Researcher — Agent Contract

Single source of truth for what the Researcher does. `pipeline.ts` and
Hermes-invoked runs both follow this file. If code or SKILL.md contradicts,
this document wins.

## Purpose

Given a politician's name, produce a verified factual record drawn entirely
from primary sources. The Researcher is the foundation of the pipeline —
every downstream agent operates on its output, so no hallucinated field
can enter here without corrupting everything after.

## INPUTS

1. A politician's name as a string (e.g., `"Ted Cruz"`).
2. API keys from the repo-local `.env` (`~/Developer/civiclens/.env`, read via `ENV_PATH`):
   - `CONGRESS_API_KEY` — Congress.gov
   - `OPENFEC_API_KEY` — OpenFEC
3. No other inputs. Not user-provided facts. Not cached stub data.

## OUTPUTS

Write `pipeline/<task-id>/researcher.json`:

```json
{
  "source":       "congress.gov",
  "fetchedAt":    "ISO-8601",
  "warnings":     ["..."],
  "data": {
    "id":         "politician-slug",
    "name":       "Full Name",
    "party":      "Republican|Democrat|Independent",
    "state":      "XX (2-letter)",
    "chamber":    "senate|house|executive",
    "role":       "Senator|Representative|...",
    "bio":        "neutral 2-3 sentence bio from Wikipedia",
    "bioSourceUrl":"https://en.wikipedia.org/...",
    "inOffice":   true,
    "bills":      [{ "title": "", "summary": "", "status": "", "introducedAt": "", "source": "congress.gov", "sourceUrl": "", "confidence": 0.98 }],
    "votes":      [{ "billTitle": "", "vote": "yea|nay|abstain|absent", "date": "", "source": "govtrack.us", "sourceUrl": "", "confidence": 0.99 }],
    "donors":     [{ "name": "", "type": "individual|pac|corporation", "amount": 0, "date": "", "source": "fec.gov", "sourceUrl": "", "confidence": 0.96 }],
    "committees":      [{ "name": "", "code": "", "chamber": "senate|house|joint", "role": "Chair|Ranking Member|Member", "isSubcommittee": false, "parentCode": null, "sourceUrl": "" }],
    "upcomingMeetings":[{ "eventId": "", "date": "YYYY-MM-DD", "title": "", "type": "Hearing|Markup|Meeting|Other", "status": "Scheduled", "committees": [{ "name": "", "code": "" }], "sourceUrl": "" }],
    "bioguideId": "",
    "govtrackId": null
  }
}
```

Returning `null` (no researcher.json written) is a valid outcome when no
bioguide ID is found — the pipeline fails the task rather than falling back.

## PRIMARY SOURCES (in priority order)

| Field | Primary source | Fallback |
|---|---|---|
| Identity, party, state, chamber, role | Congress.gov `/member/{bioguideId}` | — (no fallback allowed) |
| Bio | Congress.gov member record (deterministically constructed: role, state[-district], party, first-elected year, current Congress) | — (no fallback; Wikipedia is not allowed) |
| Bills (sponsored) | Congress.gov `/member/{bioguideId}/sponsored-legislation` | — |
| Votes | GovTrack `/vote_voter?person=` (Congress.gov v3 has no clean member-votes endpoint) | — |
| Donors | OpenFEC `/schedules/schedule_a/` aggregated by contributor_name | — |
| Committee assignments | `unitedstates/congress-legislators` YAMLs (`committees-current`, `committee-membership-current`), inverted bioguide→committees | — |
| Upcoming committee meetings | Congress.gov `/committee-meeting/{congress}/{chamber}` + per-event detail, filtered to member's committees | — |

Only add a new source when a concrete downstream field needs it. Scraping
new sites for their own sake is forbidden.

## MUST DO

1. **Look up bioguide ID first** via Congress.gov member list. If no match,
   return `null` and the pipeline fails cleanly.
2. **Use 2-letter state codes** from `terms[last].stateCode`, never the full
   state name from `member.state`. The schema requires exactly 2 chars.
3. **Set `sourceUrl` on every bill, vote, and donor record** — provenance is
   non-optional.
4. **Normalize vote values** to `yea|nay|abstain|absent`.
5. **Aggregate donors by contributor name** (client-side: uppercase, merge
   duplicates, sum contributions). Return top 20 by amount.
6. **Record warnings** for any source that returns nothing, with a specific
   reason when available (e.g., `"OpenFEC: schedule_a: HTTP 503"`).

## MUST NOT

1. Do not inject aggregate rows (e.g., "Total campaign receipts") into the
   donors array — they false-match across politicians in the Mapper.
2. Do not invent bills, votes, or donors when a source returns nothing —
   emit an empty array with a warning.
3. Do not use an LLM to generate or fill in any factual field. The Researcher
   calls no models.
4. Do not fall back to `stub-data.json` or any synthetic dataset.
5. Do not use the 15s default HTTP timeout for FEC `schedule_a` — it's too
   short under load. Use 30s (`fecGet` helper).

## INHERITS

- **no-stubs** — applies in full. This is the agent where the rule matters
  most; every downstream agent inherits its factual correctness from here.
- **neutral-voice** — applies to the `bio` field. Bio is now a deterministic
  sentence built from Congress.gov member data (role, state, party, first-
  elected year, current Congress). Wikipedia is explicitly forbidden: it's
  tertiary and its extracts leak charged language past the Summarizer.
- **provenance** — applies in full. Every array record has a sourceUrl.

## Failure modes

| Symptom | Cause | Required response |
|---|---|---|
| No bioguide ID found | name doesn't match Congress.gov's "Last, First" format | return null, pipeline fails the task — do not guess |
| Congress.gov member lookup fails | transient 5xx or bioguide deleted | return null with warning |
| OpenFEC returns no rows | schedule_a timeout, invalid params, or genuinely no itemized donations | emit empty donors array with specific warning |
| Bio fields missing (no firstElectedYear, no district) | member.terms array empty or malformed | still emit bio with what IS available; warn if the constructed string is less than the schema minimum |
| State is full name ("Texas") instead of code ("TX") | using top-level `member.state` instead of `terms[last].stateCode` | **bug** — fix code, don't paper over |
