# Solo — things to do when Claude isn't around

## Run pipeline
- `npx tsx agents/pipeline.ts "Name"`
- `npx tsx agents/pipeline.ts --list`
- `npx tsx agents/pipeline.ts --status <task-id>`
- `npx tsx agents/pipeline.ts --apply <task-id>`

## Review outputs
- `cat pipeline/<task-id>/final-review.json`
- `cat pipeline/<task-id>/summarizer.json`

## Website
- `cd ~/civiclens && npm run dev`
- edit `src/` — UI, styling, routing
- edit `src/db/seed.ts` — manual corrections

## Research (Hermes chat)
- grok for exploratory questions
- use to pick next politicians to pipeline

## Backlog
- append to `NEXT.md` — bugs, ideas, questions for next Claude session
