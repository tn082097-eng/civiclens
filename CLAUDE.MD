# CivicLens — Project Context for Claude Code

## What CivicLens Is

CivicLens is a fully autonomous, fully local political dossier website that displays detailed profiles on federal politicians. It pulls real data from non-partisan sources, validates it for accuracy, and presents it with relationship graphs, voting records, donor histories, and neutral plain-English summaries.

Core principles:
- 100% local — no cloud dependencies, no runtime API calls
- Self-validating — agents cross-check data and flag conflicts
- Fully autonomous — runs nightly with zero human input
- Non-partisan — neutral framing, multi-source verification, confidence scores on every data point

## Hardware

- GPU: NVIDIA RTX 4080 Super (16GB VRAM)
- Motherboard: MSI Pro B650-S (AM5)
- OS: Linux (Mint/Ubuntu-based, Cinnamon desktop)
- User: captainanime
- Working dir: /home/captainanime/

## Tech Stack

| Layer | Tool |
|---|---|
| Website framework | Next.js 15 (static export) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 + shadcn/ui |
| Graph viz | Sigma.js + Graphology |
| Search | Orama |
| Data store | SQLite + Drizzle ORM |
| Validation | Zod |
| Local LLMs | Ollama |
| Pipeline orchestration | Custom OpenClaw (built locally, not the public framework) |
| Chat/skill interface | Hermes Agent |
| Pipeline scheduling | systemd timer (nightly) |
| Testing | Vitest + Playwright |

## Project Locations

- Pipeline code: ~/.hermes/civiclens/
- Hermes config: ~/.hermes/
- Hermes env vars: ~/.hermes/.env
- Voteview data: ~/code/CivicLens/
- Backup of pipeline: ~/.hermes/civiclens-backup-2026-04-18/

## Pipeline Structure (~/.hermes/civiclens/)

~/.hermes/civiclens/
├── agents/
│   ├── pipeline.ts        # Main pipeline runner (63KB)
│   ├── run-batch.ts       # Batch processing
│   ├── telegram.ts        # Telegram messaging integration
│   └── whatsapp.ts        # WhatsApp messaging integration
├── lib/
│   ├── schemas.ts         # Zod schemas
│   ├── state.ts           # State management
│   └── types.ts           # TypeScript types
├── skills/                # Each agent has a SKILL.md
│   ├── brain/
│   ├── coder/
│   ├── connection-mapper/
│   ├── data-checker/
│   ├── final-reviewer/
│   ├── publisher/
│   ├── researcher/
│   └── summarizer/
├── pipeline/              # Task output history (one folder per run)
├── crewai_config.py       # Model assignments for each agent
└── package.json           # NPM dependencies

## The 9 Agents (Target State)

| Agent | Model | Role |
|---|---|---|
| Brain | qwen3.6:35b-a3b | Orchestrates pipeline, makes retry/abort decisions |
| Researcher | qwen3.6:35b-a3b | Fetches data from Congress.gov, FEC, GovTrack, Voteview CSVs |
| Data Checker | deepseek-r1:14b | Validates data with Zod schemas, plausibility checks |
| Connection Mapper | deepseek-r1:14b | Finds hidden relationships between politicians, donors, orgs, PACs |
| Summarizer | qwen3.6:35b-a3b | Writes neutral plain-English summaries |
| Coder | qwen2.5-coder:14b | Generates database seed data and UI components |
| Code Reviewer | deepseek-coder-v2:16b | Reviews Coder output for bugs, type safety, neutrality |
| Visualizer | qwen3.6:35b-a3b | Generates Sigma.js graph data and chart configs |
| Final Reviewer | deepseek-r1:14b | QC gate — approves/rejects full pipeline run |

Plus existing Publisher (auto-publishes results — keep as-is).

## Pipeline Execution Order

Brain coordinates all of this:

Researcher → Data Checker → Connection Mapper → Summarizer → Coder → Code Reviewer → Visualizer → Final Reviewer → Publisher

## Models Confirmed Installed (verified via `ollama list`)

- qwen3.6:35b-a3b (23 GB) — note the -a3b suffix is required
- qwen3:14b (9.3 GB) — currently used for Hermes chat
- deepseek-r1:14b (9.0 GB)
- deepseek-coder-v2:16b (8.9 GB)
- qwen2.5-coder:14b (9.0 GB)
- mistral-small:22b (12 GB) — bonus, not in pipeline plan

## Data Sources

| Source | Status | URL |
|---|---|---|
| Voteview CSVs | Local files at ~/code/CivicLens/ | voteview.com/data |
| Congress.gov | Free API key needed | api.congress.gov/sign-up |
| FEC.gov | Free API key needed | api.open.fec.gov/developers |
| GovTrack | No key needed | govtrack.us/api |
| ProPublica Congress | Free, 1-2 day approval | propublica.org/datastore/api |
| OpenSecrets | Free 200 req/day limit | opensecrets.org/api |

API keys go in: ~/.hermes/.env

## Target Politicians (Roster)

A bipartisan mix of federal Congress "needle pushers" — high influence, high media presence:

1. Mitch McConnell (Senate, R)
2. Nancy Pelosi (House, D)
3. Ted Cruz (Senate, R)
4. Bernie Sanders (Senate, I)
5. Marjorie Taylor Greene (House, R)
6. Alexandria Ocasio-Cortez (House, D)
7. Rand Paul (Senate, R)
8. Elizabeth Warren (Senate, D)
9. Matt Gaetz (House, R)
10. Ro Khanna (House, D)
11. Donald Trump (Executive)
12. JD Vance (Executive)

## Anti-Hallucination Rules for Claude Code

These are critical. The user has been burned by hallucinated model names, made-up file structures, and silent unauthorized installations. Follow these strictly:

1. Never invent file paths, model names, or commands. Verify everything by running actual commands.
2. Read files before modifying them. Use cat or the read tool to see actual contents.
3. Verify model names by running `ollama list` and `ollama search` before assigning.
4. Show diffs before writing. For every file change, show: current content → proposed change → diff.
5. Wait for explicit approval before any destructive operation (delete, overwrite, install).
6. Cite sources for every claim. "According to the file content shown above" or "verified via ollama list output."
7. If you can't verify something, say so. Mark it UNVERIFIED. Don't pattern-match from training data.
8. No silent installations. If you need to install a package, ask first.
9. Backup before destructive changes. Always copy files before overwriting them.
10. Don't assume — ask. If the user's intent is unclear, ask one specific question.

## Current Project State

- DONE: Hardware verified, models installed
- DONE: Hermes Agent installed and running
- DONE: OpenClaw pipeline scaffolding exists at ~/.hermes/civiclens/
- DONE: Telegram bot configured for remote access
- DONE: Initial CivicLens website running at http://localhost:3000 (Influence Network graph rendering)
- TODO: Pipeline currently has 6-7 agents, not the planned 9
- TODO: Brain skill currently uses qwen3:32b, needs update to qwen3.6:35b-a3b
- TODO: Missing skills: Code Reviewer, Visualizer
- TODO: Currently using stub data, needs real API integration
- TODO: No nightly systemd timer set up yet
- TODO: Connection graph only shows politicians, not donors/orgs/PACs (needs expansion)

## Immediate Next Steps

1. Update Brain skill model from qwen3:32b → qwen3.6:35b-a3b
2. Update crewai_config.py with all 9 agent model assignments
3. Create SKILL.md for missing agents: code-reviewer, visualizer
4. Update Brain pipeline order to include new agents
5. Get Congress.gov + FEC.gov API keys, add to ~/.hermes/.env
6. Switch Researcher from stub data to real API/Voteview CSV reads
7. Expand graph data model to include donors, orgs, PACs as node types

## Communication Style with User

- Be direct and honest
- No excessive hedging or "maybe we could try"
- If something won't work, say so plainly
- The user values verification over speed
- The user has been burned by AI overconfidence — earn trust by being conservative

## Key User Quotes (Lessons Learned)

- "I don't trust claude code to do it because im afraid it will hallucinate it all again"
- "stop suggesting donald trump" — when offering examples, vary the politician used
- "I never intended on using openclaw" — don't install or set up anything without explicit approval
- "i wanted to give it to hermes" — the user wants to know which tool to use for what

