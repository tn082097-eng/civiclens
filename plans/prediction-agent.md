# Plan: Prediction Agent

## Goal
Produce backtestable, base-rate predictions for politician behavior — future votes, bill passage, revolving-door destinations — grounded entirely in the historical records the pipeline already collects. Every prediction gets logged, scored, and calibrated against actual outcomes.

## Why
The rest of the pipeline is strictly retrospective: "here's what happened, sourced to a primary record." A prediction agent lets us do the opposite thing **without breaking the editorial rule** — because a prediction is falsifiable. "This senator votes with party leadership 94% of the time on defense bills" is not an opinion; it's a base rate. "This bill has an 8% passage probability, given its sponsor's past 100 bills" is not editorializing; it's a summary of history.

Also: prediction quality is the most honest accountability mechanism for the pipeline itself. If our 80% calls come true 60% of the time, the reader learns to discount us. That's the correct outcome — and no other transparency project publishes its own calibration.

## What it predicts
1. **Vote outcomes** — per-member probability on an upcoming roll-call vote. Highest data density, shortest resolution cycle, best starting point.
2. **Bill passage** — per-bill probability of advancing out of committee, passing the chamber, becoming law. Longer horizon, well-studied base rates.
3. **Revolving-door destination** — on a retirement announcement, predict industry/firm-type of the next role. Backtested against the LDA/OGE filings the revolving-door agent collects.
4. **Cosponsorship patterns** — for a new bill, which members are most likely to cosponsor within N days. Short horizon, high volume, good calibration signal.

Not in scope initially:
- Election outcomes — 538, Polymarket, Split Ticket already do this well; not our edge.
- Policy outcomes ("will there be a strike on Iran") — too noisy, too politicized.
- Individual trade predictions — the financial-disclosures agent presents trades as facts, not forecasts.

## Data sources
All internal. This agent's distinctive property is that it consumes the pipeline's own outputs — if we can't predict from what we already publish, we're not publishing enough.

1. **VotesAgent output** — historical roll-call records, per-member, cross-indexed by bill topic.
2. **BillsAgent output** — sponsorship, cosponsorship, committee history, passage outcomes.
3. **Connection Mapper output** — donor-to-committee proximity, committee-to-industry alignment.
4. **Revolving-door agent output** (when it exists) — historical move patterns by chamber/committee/era.
5. **Policy Events dataset** (from the financial-disclosures plan) — decision calendar for backtest alignment.

Secondary aids: Polymarket / PredictIt resolution histories for bills with active markets — useful as an external calibration benchmark, never as a training input.

## What the agent produces
For each prediction, a record like:

```json
{
  "predictionId": "2026-04-20_hr1234_vote_schumer",
  "target": { "type": "vote", "billId": "hr-1234", "memberId": "schumer-charles", "chamber": "senate" },
  "createdAt": "2026-04-20T12:00:00Z",
  "resolvesBy": "2026-04-27",
  "prediction": { "yes": 0.94, "no": 0.04, "abstain": 0.02 },
  "basis": {
    "comparableBills": 143,
    "memberAgreementRateInClass": 0.94,
    "partyLeadershipAlignment": 0.97,
    "committeeJurisdiction": "finance",
    "timeWindow": "2015-01-01_to_2026-04-20"
  },
  "resolution": null
}
```

`resolution` is filled in once the vote lands — feeding a public calibration log.

## Pipeline integration
- Runs as its own stage, after the researcher sub-agents produce their outputs but before the Summarizer — so every politician page can carry a "predicted behavior" panel alongside the historical record.
- A separate daily/weekly job scores un-resolved predictions against new primary-source data and updates the calibration table.
- A top-level **Calibration page** publishes running Brier score / log-loss per prediction class. Readers see how well we're doing in public.

## Editorial discipline
The temptation is to write "Schumer will vote yes on HR 1234." The discipline is:

> Based on 143 comparable finance-committee bills since 2015, members of Senator Schumer's caucus voted yes 94% of the time. Actual vote expected by 2026-04-27.

Every prediction must carry:
- The **base-rate math** — N, class, time window.
- The **confidence framing** — probability, not declaration.
- The **resolution date** — so the reader can check us later.

The `noEditorializing` check must treat any unhedged future-tense prediction ("will vote", "will pass", "is going to") as a hard fail. Probabilities and base rates only.

## Scope caveats
- **Backtest before you publish.** No prediction class ships until we've replayed it against at least 2 years of historical data and published the calibration numbers.
- **Small samples are dangerous.** A freshman senator with 12 votes has no meaningful base rate. The agent must refuse to predict below a minimum-N threshold.
- **Regime changes break models.** A party switch, committee reassignment, or major scandal invalidates priors. Flag these as "reset events" and exclude pre-event data from the comparable set.
- **Don't predict the rare things.** Impeachment votes, treaty ratifications, motions to vacate — too few data points, too much narrative weight. Stick to high-volume classes.
- **Publish misses loudly.** If the agent said 90% and it came in 10%, the miss belongs on the politician's page with the same prominence as the prediction did. Under-promoting misses is the same as editorializing.
- **Don't train on resolutions from our own predictions.** Calibration tables are diagnostic, not training inputs — that way lies overfitting to our own publicity.

## Rough order of work
1. Pick one prediction class — **vote outcomes**. Highest density, shortest cycle.
2. Build the calibration harness first: replay 2+ years of votes, score predictions, land a Brier score.
3. Ship a private calibration table. Iterate until the scores are defensible.
4. Only then surface predictions on politician pages.
5. Add bill-passage prediction once votes are calibrated.
6. Revolving-door and cosponsorship predictions later — they depend on the revolving-door agent.

## Unlocks
- **Accountability on us.** A public calibration log is the strongest honesty signal a transparency project can publish.
- **Surprise detection.** When an agent predicts 95% and reality returns 5%, *that* is the story. Biggest misses are features, not bugs — they're tips for human reporters.
- **Revolving-door alarm.** If the agent consistently predicts where retiring members will land, and they land there, the pattern is structural rather than coincidental — and quantifiable.
- **Base-rate framing for readers.** Half the political press is "breaking news" about routine party-line behavior. A site that says "this is the 94%-base-rate vote, not news" is doing something the press doesn't.
