# Plan: Court-Cases Agent

## Goal
Surface relevant court-case records for the people the pipeline publishes — and extend the pipeline's scope to federal judges it currently can't see at all. Every case cited to a primary docket so the reader can pull the record themselves.

## Why
The pipeline today stops at "what laws did they sponsor, how did they vote, who paid them." For two kinds of accountability, that's not enough:

1. **Judges are invisible.** SCOTUS, circuit, and district judges have no bioguide ID, no sponsored bills, no FEC committee. The strongest accountability surface for a judge is their own written record: the opinions they authored, joined, or dissented from. CivicLens can't produce a judge page today.
2. **Legislators with prior legal careers have their most substantive record offstage.** A senator who spent 20 years as a prosecutor, or a representative who argued appellate civil-rights cases, has a paper trail of actual positions taken under oath — which matters more than campaign-trail posturing and isn't captured by voting records.

The court record is also where several adjacent stories live: confirmation-hearing context (what did the nominee write before?), impeachment (what was the conduct?), recusal patterns (judge's holdings × cases they heard — joins with the financial-disclosures plan).

## Who's in scope
- **Federal judges** — SCOTUS, circuit, district. Their authored/joined/dissented opinions.
- **Politicians with prior legal careers** — cases they argued as attorneys, with their role (counsel of record, amicus, etc.).
- **Politicians as party to litigation** — civil suits, criminal cases, ethics proceedings where they're named.
- **Confirmation-hearing context** — for pending judicial or agency-head nominees, their full case/opinion record joined to committee questioning.

Not in scope initially:
- State trial-court judges (below appellate) — scope is too large and quality varies too much.
- Routine civil cases unrelated to a person's public role (divorce, small claims, traffic).
- Sealed dockets — publishing sealed material is contempt. Flag the existence where known, decline to expose contents.
- Unverified allegations — if it isn't filed on a docket, it isn't evidence.

## Data sources (primary, in priority order)
1. **CourtListener** — `courtlistener.com`. Free nonprofit mirror of PACER via the RECAP archive. Has a public REST API (`/api/rest/v3/search/`, `/opinions/`, `/dockets/`). Canonical primary source for federal case records.
2. **SCOTUS opinions** — `supremecourt.gov/opinions/`. PDFs plus bench-ready transcripts. Small N (~70 decisions/term), high value.
3. **PACER directly** — `pacer.uscourts.gov`. Paywalled but authoritative when CourtListener is stale. Use sparingly and only when a specific docket is needed.
4. **Free Law Project / Caselaw Access Project** — `case.law`. Historical case corpus, useful for pre-2000 records.
5. **Judicial financial-disclosure records (AO-10)** — already planned under financial-disclosures-agent. Cross-references: which cases did a judge hear while holding which assets?

Secondary aids (never a citation): Ballotpedia, Oyez (SCOTUS), Wikipedia.

## What the agent produces
For each tracked person, a record like:

```json
{
  "personId": "kavanaugh-brett",
  "cases": [
    {
      "role": "judge",
      "caseName": "Seila Law LLC v. Consumer Financial Protection Bureau",
      "court": "D.C. Circuit",
      "docket": "18-7011",
      "filed": "2018-05-09",
      "resolved": "2019-07-26",
      "opinion": "authored-majority",
      "outcome": "affirmed",
      "sourceUrl": "https://www.courtlistener.com/opinion/...",
      "source": "courtlistener"
    },
    {
      "role": "counsel-of-record",
      "caseName": "...",
      "court": "U.S. Supreme Court",
      "docket": "...",
      "filed": "...",
      "resolved": "...",
      "clientSide": "petitioner",
      "sourceUrl": "https://www.supremecourt.gov/...",
      "source": "scotus"
    }
  ]
}
```

For judges, `opinion` is one of `authored-majority | authored-concurrence | authored-dissent | joined-majority | joined-dissent`. For attorneys, `clientSide` is `petitioner | respondent | amicus`. Both patterns cite the same docket record.

## Pipeline integration
- Runs as a new specialist agent in the Researcher phase (post-parallelization) — or as its own stage if we want to scrape on a different cadence than per-politician runs.
- **Identity challenge**: judges have no bioguide. A parallel identity scheme is needed — FJC (Federal Judicial Center) biographical database has persistent IDs for federal judges. This is a prerequisite, not part of the MVP.
- **Connection Mapper joins**:
  - `judge × litigant × donor` — when a judge rules on a case, is the litigant or their counsel a donor to the senator who voted to confirm the judge?
  - `legislator-as-attorney × client × current-committee-jurisdiction` — a senator who represented a pharmaceutical company now sits on the HELP committee: that's a record to surface.
- **Financial-disclosures join** — judge's AO-10 holdings × cases they heard at the time = recusal-pattern visibility.

## How the story is told (editorial discipline)
A judge's 300-opinion record can be rendered as ideological if you pick the 3 most charged ones. That's the canonical "curated docket" attack, and it's indistinguishable from the editorializing the mission forbids.

Two disciplined modes, both acceptable:
1. **Complete list by transparent filter** — e.g., "all civil-rights opinions authored since 2020, N = 42" with the full list linked.
2. **Top-of-docket summary** — most-cited opinions, most-recent opinions, or opinions in a named topic; the selection criterion is stated, the full list linked.

A curator's pick with no stated criterion is never acceptable, even when the selection is factually accurate.

For legislators: an attorney's representation of a client is not an endorsement of the client's position. Label clearly. "Represented" ≠ "believes."

## Scope caveats
- **Sealed dockets.** Flag where the existence is known from metadata; decline to expose contents. No exceptions.
- **Ongoing cases.** Label `resolved: null` prominently. Outcome is not final, appellate review may still come.
- **Representation ≠ agreement.** An attorney's client list is a professional record, not an ideological one. Caveat in the UI, not just the data.
- **Volume at the circuit/district level.** A district judge may issue hundreds of orders per year. Filter by disposition type (opinion vs. routine scheduling order) and by topic — don't try to page the full docket to the reader.
- **Judicial identity drift.** Judges elevate (district → circuit → SCOTUS) and switch chambers. Use FJC's persistent ID across all roles; never rekey by current court alone.
- **Error rate in CourtListener.** The RECAP archive is crowdsourced — metadata can be wrong. When a high-stakes claim depends on a case record, verify against the court's own PACER docket before publishing.

## Rough order of work
1. **SCOTUS** first — smallest N, highest value. Build the opinions-by-justice view from `supremecourt.gov` + CourtListener's opinion corpus.
2. **Federal-judge identity layer** — ingest FJC biographical data, build persistent IDs, match to SCOTUS justices.
3. **Circuit-court opinions** — CourtListener API, paginate by judge ID, filter to authored opinions.
4. **District-court coverage** — much larger volume. Restrict to disposition opinions, skip routine orders.
5. **Legislators-as-attorneys lookup** — for members with `pre-Congress-employment.industry: legal`, search CourtListener by name + bar admission.
6. **Legislators-as-parties lookup** — named-party search in CourtListener (civil) + DOJ press releases (criminal).
7. **Connection Mapper integration** — judge × litigant × donor joins.

## Unlocks
- **First CivicLens judge page.** SCOTUS justices get the full treatment — opinions, financial disclosures (via AO-10), recusal record, confirmation-hearing questioning.
- **Confirmation-hearing context.** When a judicial nominee is up for the Senate, every committee member can see the nominee's full opinion record in one place, cross-referenced against their own committee's past questioning patterns.
- **Recusal-pattern visibility.** Once AO-10 + case records are both in the pipeline, "this judge heard N cases against companies they held stock in" becomes a structurally answerable question rather than a journalistic one.
- **Attorney-to-legislator cross-reference.** A senator's pre-political litigation record is often more substantive than their campaign record. Making it browsable is a useful transparency surface no existing project covers end-to-end.
- **Ethics-proceeding surface.** Members under OCE inquiry or House/Senate ethics review have those records partially public; joining them to the member's page is a straightforward extension.
