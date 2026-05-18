# CivicLens — Ideas Backlog

## Deeper data
- Co-sponsorship networks (who introduces bills with whom)
- Committee assignments & participation rates
- Floor speech themes / keyword frequency
- STOCK Act filings (stock trades)
- Personal financial disclosures
- Lobbying disclosures / meeting logs
- Absence & attendance records
- Earmark history
- Foreign travel records
- Post-Congress revolving door tracking
- Full historical vote record (not just recent)
- Family business connections
- Campaign finance flow — where PAC money goes after receipt

## Different ways to run
- Batch mode — 10 politicians parallel
- Incremental — weekly re-runs catch new votes/donors
- Event-driven — new vote triggers pipeline
- Diff mode — show what changed since last run
- Compare mode — 2 politicians side-by-side report
- Topic mode — scoped to one issue ("X's climate record")

## LLMs in tandem
- Cross-check Summarizer on 2 models, flag disagreements
- Devil's-advocate agent — pokes holes in neutral narrative
- Fact-verification agent — re-checks each keyFact independently
- Adversarial pre-publish — simulate partisan attack
- Multi-perspective summaries (left/center/right framings as transparency exercise)

## Features that make it invaluable
- Search: by donor, bill, vote, committee, keyword
- Network view — "who funded this bill's sponsors"
- Similarity match — "politicians like X"
- Alerts — new vote, new donor over $threshold
- Shareable cards (social snapshot)
- Public API — let journalists / other tools query
- Timeline view — politician's record over time
- Comparative views — by state, district, party, committee
- "Show me all X who voted Y on Z"

## Provenance & trust
- Diff tracking — what changed, when, why
- Inline source citations (hover fact → see primary)
- Confidence scores visible in UI
- Public correction mechanism (submit w/ evidence)
- Bot disclosure — show which agents touched each fact

## Interesting / ambitious
- Voting fingerprint — find similar politicians statistically
- Constituent impact — map bills to zip codes affected
- Anomaly detection — flag statistically unusual votes
- Neutrality drift tracking — over time, are bios getting less neutral?
- Browser extension — highlight name on any page → civiclens card
- Journalist export / citation format
- Crowd review — reader corrections with evidence

## Scale
- Full Congress (535) cached
- Daily incremental via cron
- State legislators
- State + local via volunteers
- Historical — former members too

## Quality
- A/B test prompts on same politician, measure which produces more neutral output
- Golden-set regression tests (10 politicians with known-good outputs)
- Neutrality score over time as metric
- Cost-per-politician tracking
