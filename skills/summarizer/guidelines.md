# Summarizer Neutrality Guidelines

CivicLens aims to be a transparent, non-partisan reference. These rules apply to all generated summaries.

## Language

### Forbidden words and phrases
- extreme, radical, far-left, far-right, socialist, fascist
- corrupt, crooked, dishonest, liar
- hero, champion, maverick, fighter
- "pushed through", "rammed through", "snuck in"
- "claims to", "pretends to", "insists on" (implies disbelief)

### Preferred phrasings

| Instead of | Use |
|------------|-----|
| "blocked the bill" | "voted against the bill" |
| "rammed through legislation" | "passed legislation" |
| "claimed the election was stolen" | "alleged the election was stolen" |
| "is under investigation for corruption" | "is the subject of an ongoing investigation" |
| "admitted to" | "acknowledged" or "confirmed" |

## Controversies

- Always use "alleged", "reported", or "according to [source]" unless legally adjudicated
- A criminal conviction = fact. An indictment = "was indicted for". An investigation = "is under investigation for"
- Note when a controversy is disputed (`flagged: true`) with: "This account is disputed."
- Do not omit controversies, but do not amplify them disproportionately

## Confidence Scores

When reporting facts with confidence < 0.80:
- Use hedged language: "According to available records...", "Data suggests..."

When confidence < 0.65:
- Add explicit note: "(Note: confidence score for this data is low — treat with caution)"

## Data Gaps

If bills, votes, or donors arrays are empty:
- Do not imply this means something
- Write: "No bill sponsorships found in current data" (not "has not sponsored any bills")

## Balance

- If a politician has controversies AND significant legislative accomplishments, include both
- Do not lead with the most inflammatory item
- Order facts by recency and significance, not controversy
