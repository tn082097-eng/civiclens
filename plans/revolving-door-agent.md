# Plan: Revolving-Door Agent

## Goal
Surface people who moved between government and the industries they regulated. The pattern is one of the highest-signal accountability stories available in public data, and the pipeline currently can't see it.

## Why
The revolving door is where regulatory capture actually happens:
- Senator retires → lobbies for industry they oversaw on committee
- Agency head leaves → joins firm whose filings they approved
- Industry lawyer → confirmed to agency → returns to industry at a higher rate
- Ex-staffers → lobbying shops, with names still opening doors

Most of this is public somewhere. None of it is cross-referenced with the politician records we already build. A person's page today stops at their term end — revolving-door activity is the most important thing that happens **next**, and we don't show it.

## Who's in scope
- Ex-members of Congress
- Ex-congressional staff (chief-of-staff, committee staff)
- Ex-executive-branch appointees (cabinet, deputy secretaries, agency commissioners, regulatory board members)
- Reverse direction too: industry → government → back to industry (common in Treasury, Defense, FCC, FDA)

Not in scope initially:
- Career civil service moves (lower signal, harder to clean)
- State/local revolving door (federal-first rule from the mission)

## Data sources (primary, in priority order)
1. **Senate LDA filings (lobbying disclosure)** — `soprweb.senate.gov` has LDA reports with a "covered officials" field listing ex-federal positions of each lobbyist. This is the canonical primary source for "ex-official now registered lobbyist."
2. **Foreign Agents Registration Act (FARA) filings** — `efile.fara.gov`. Catches people working for foreign governments, which overlaps heavily with ex-official lobbying but isn't in LDA.
3. **OGE Public Financial Disclosures** — `ogepublicaccess.oge.gov`. For executive-branch people: their 278s disclose post-tenure employment agreements.
4. **OpenSecrets Revolving Door database** — `opensecrets.org/revolving` has a curated join of LDA + agency history. Scrape-able, well-structured. Secondary-source caveat: treat it as a pointer to primary filings, not a primary source itself.
5. **ProPublica Represent / archived congressional staff lists** — for ex-staff. Less clean; deprioritize.

Every record must ultimately cite a primary source (LDA, FARA, OGE). OpenSecrets is a navigation aid, not a citation.

## What the agent produces
For each tracked person, a record like:

```json
{
  "personId": "schumer-charles",
  "roles": [
    { "type": "government", "title": "Senator (NY)", "start": "1999-01-06", "end": null, "source": "congress.gov" },
    ...
  ],
  "postGovernmentEmployment": [
    { "employer": "Foo Partners LLP", "role": "Senior Counsel", "industry": "financial-services",
      "registeredLobbyist": true, "clientsDisclosed": ["Bank A", "PAC B"],
      "start": "2026-02-01", "source": "senate.gov/LDA", "sourceUrl": "..." }
  ]
}
```

Plus a `connections` output feeding the Connection Mapper:
- "X served on Senate Banking Committee (2011–2024), now lobbies for Bank A (2025–)"
- Optional temporal flag: "gap between leaving office and registering: 94 days" (cooling-off period compliance check — federal rules require 1–2 years depending on role)

## Pipeline integration
- New agent slots into the Researcher phase in parallel with Donors/Votes/Bills (post-(1) parallelization) — or as its own pipeline stage if we want it run independently of researcher runs.
- Connection Mapper gains a new join type: "policy-area to post-employment industry."
- Final Reviewer gets a new check: "if person has post-government employment, is it surfaced on their page?"

## Scope caveats
- **Data currency.** LDA filings are quarterly; post-tenure jobs only appear once the person registers. Short lag is acceptable ("before, not after" applies to ongoing officials, not to post-tenure tracking).
- **Cooling-off rules are complicated.** Senators: 2-year bar on lobbying. Representatives: 1-year. Staff: 1-year from parent committee. Cabinet: 1-year-by-role. Get the rules right before flagging "violations" — a wrong flag in this area is a mission-breaking error.
- **Name matching is hard.** LDA uses "First Middle Last" inconsistently. Likely needs the same alias/canonical-name treatment the bioguide lookup already has.

## Pre-government direction (previous jobs)
The "revolving door" is usually described as government → industry, but the reverse half matters just as much and is currently invisible for rank-and-file members. A representative who was a pharma lobbyist before running, or a senator who spent 15 years at a commercial-litigation firm, carries that history into every vote they cast. The post-government plan above covers the "out" direction. This section covers the "in" direction for legislators who were *not* executive-branch appointees (executive appointees are already covered via OGE 278 pre-appointment filings).

### Data sources (primary)
1. **Member's official .gov bio page** — e.g., `schumer.senate.gov/about`, `khanna.house.gov/about`. Self-written but factually constrained: it's on a .gov domain, and false employment claims invite press scrutiny. Structure is inconsistent across members — scraping needs per-member adaptation or a general heuristic.
2. **FEC candidate registration (Form 2 / Statement of Candidacy)** — `docquery.fec.gov` / OpenFEC `/candidate/{id}`. The `occupation` field is filled in by the candidate at registration and is a primary record. Often terse ("Attorney", "Business Owner") but it's a filing under federal law, which is a stronger provenance than a bio page.
3. **State election-board filings** — where available, candidates disclose profession and employment history on their state filing for a federal seat. Coverage varies by state.
4. **Legislators-current YAML (unitedstates/congress-legislators)** — the `bio` / `other_names` / sometimes `terms[0].party` gives hints but is not a reliable employment source. Navigation only.

Secondary aids (never a citation): LinkedIn (ToS-restricted, also self-written), Ballotpedia, Wikipedia.

### What this adds to the record
For each tracked person, append to the same output:

```json
{
  "preGovernmentEmployment": [
    { "employer": "Kirkland & Ellis LLP", "role": "Associate", "industry": "legal-services",
      "start": "2001-06", "end": "2007-11", "source": "house.gov-bio",
      "sourceUrl": "https://khanna.house.gov/about" },
    { "employer": "Yale Law School", "role": "Student (JD)", "industry": "education",
      "start": "1998-09", "end": "2001-05", "source": "fec-form-2",
      "sourceUrl": "https://docquery.fec.gov/..." }
  ]
}
```

Each entry carries its own source. A member's official bio and their FEC Form 2 may disagree — label both, don't reconcile.

### Why it matters
- Closes the symmetry of the revolving-door picture. "Industry lobbyist → confirmed to FCC → lobbies back" is already in scope; "industry lawyer → elected to Congress → votes on industry regulation" currently isn't.
- Enables the **pre-political career × current committee jurisdiction** join: a former pharma executive on the HELP committee is a structurally different entity from a former nurse on the same committee. Both are facts worth surfacing.
- Complements the court-cases agent (separate plan): a former prosecutor's judicial committee votes read differently with their conviction record visible.

### Scope caveats
- **Self-written sources.** Official bios are drafted by staff. Treat them as provenance-adjacent — they're on a .gov domain, but they aren't primary filings.
- **Industry labels are fuzzy.** "Business owner" on a Form 2 could be anything. Don't over-categorize; preserve the raw string alongside any industry tag.
- **Pre-career and pre-adulthood.** We're interested in professional employment, not summer jobs. Set a minimum-tenure threshold (e.g., 12 months) for what gets surfaced.
- **Updates are rare.** Candidates file Form 2 at registration; it doesn't get updated with each new campaign. Use `filedAt` as the snapshot date.

## Rough order of work
1. LDA ingestion — downloadable quarterly XML dumps from Senate LDA.
2. Match LDA records to our politician records via canonical name + disambiguator (state, chamber, years served).
3. OGE 278 ingestion for executive-branch.
4. FARA ingestion.
5. **Pre-government lobe:** FEC Form 2 occupation field (easiest — structured, one field per candidate). Then official .gov bio scraping (per-member heuristic). State election-board filings last.
6. Integrate into Connection Mapper — both directions, same join shapes.
