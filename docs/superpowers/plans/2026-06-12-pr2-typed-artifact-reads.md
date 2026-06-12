# PR 2 — Typed Artifact Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every live read of a pipeline artifact (`<agent>.json`) is validated against a Zod schema derived from the actual artifact corpus, with errors that name the task, agent, and offending field — plus two absorbed PR 1 follow-ups (real `tsconfig.json`, client-side URL allowlist in inline scripts).

**Architecture:** Schemas are derived artifact-first: a measurement script reports the observed shape of all 1,000+ artifacts under `pipeline/task-*/`, draft schemas (taken from the writer code) are loosened until a corpus-validation harness reports **100% pass** — the merge gate. `readPipe` gains an optional schema parameter that *validates but returns the raw JSON* (no Zod stripping/defaults — this PR is a no-behavior-change conversion). The DB loader (`db/load-from-tasks.ts`, the real publish path) gets the same validation through a local helper.

**Tech Stack:** TypeScript (tsx runtime), Zod 3, `node --test` via `tsx --test`, DuckDB (unchanged).

**Spec:** `docs/superpowers/specs/2026-06-10-phase2-closeout-design.md` § "PR 2 — Typed artifact reads" + Follow-ups 1 & 2.

---

## Scope decisions (locked — record deviations in the spec at the end)

1. **`agents/data-checker.ts` reads stay raw — deliberate deviation from the spec's convert list.** The Data Checker *is* the validator for `researcher.json`: it reads raw, auto-corrects, writes back, then runs `ResearcherOutputSchema.safeParse` itself and reports failures as critical issues (`data-checker.ts:77-82`). That failure-as-report path feeds the pipeline's retry-researcher-once coupling. A throwing read would turn "checker fails → retry researcher" into "run crashes". Document with a comment, don't convert.
2. **`state.json` reads are out of scope.** It is pipeline state, not an `<agent>.json` artifact (the spec's corpus definition is "every `<agent>.json`"). Its consumers (`findLatestApproved`, `syncTask`, `readTask`) null-guard every field they touch; a schema loose enough to pass 225 historical state files would be vacuous. `db/sync-task.ts` therefore needs **no change** (it only parses `state.json`).
3. **`agents/devils-advocate.ts` untouched** — PR 4 wires it and adds its schema there (spec).
4. **Corpus = `pipeline/task-*/` only.** That is the only root any live reader touches (`PIPE_DIR` in `lib/paths.ts`). `pipeline-grok/` and `pipeline-hybrid/` are experiment archives nothing reads; excluded from the 100% gate.
5. **Exact-name match only.** `final-review.precycle.json`, `final-review.phase2bust.json` etc. are manual experiment snapshots, never read by code; excluded.
6. **`readPipe` validates with `safeParse` and returns the RAW parsed JSON, not `result.data`.** Zod `z.object` strips unknown keys and `.default()` injects values (e.g. `committees: []` in `PoliticianDataSchema`); returning the transformed value would silently change what readers see. Validation, not transformation.
7. **Researcher schema decision tree.** Runtime reads *downstream of the Data Checker gate* (code-checker, summarizer, final-reviewer) use the strict `ResearcherOutputSchema` — the gate already guarantees it. The DB loader reads researcher.json from *historical approved tasks*; whether strict passes those is an empirical question Task 5 answers:
   - If `ResearcherOutputSchema` validates 100% of researcher.json in **approved** task dirs → use it in the loader too.
   - If not → add a loose `ResearcherArtifactSchema` (derived from corpus) used **only by the DB loader**; the strict schema and the Data Checker gate are untouched. **Never loosen `ResearcherOutputSchema` itself — it is a quality gate, not a read schema.**
8. **Schema looseness rules.** `.optional()` / `.nullable()` / unions exactly as observed in the corpus; no tightening beyond observed shape (deferred to a dedicated cleanup PR per spec). No `.min()`/`.max()`/`.regex()` constraints on new schemas — presence and type only.

## File structure

| File | Action | Responsibility |
|---|---|---|
| `tsconfig.json` | create | make `npx tsc --noEmit` real (spec follow-up 2) |
| `render/connections-to-vault.ts` | modify (2 lines) | fix the only 2 tsc errors (`.ts`-extension imports) |
| `scripts/measure-artifact-shapes.ts` | create | shape report over the corpus (presence %, types, samples) |
| `scripts/validate-artifact-corpus.ts` | create | the 100% merge gate; also `npm run validate:corpus` |
| `lib/schemas.ts` | modify | + `IssueSchema`, `DataCheckerReportSchema`, `CodeCheckerReportSchema`, `SummarizerOutputSchema`, `TradeAnalystOutputSchema`, `PredictorOutputSchema`, `FinalReviewReportSchema` |
| `agents/shared.ts` | modify | `readPipe(taskId, name, schema?)` + `ArtifactValidationError` |
| `agents/shared.test.ts` | create | malformed-artifact test (spec verification #2) |
| `agents/final-reviewer.ts` | modify | validated reads ×4 |
| `agents/code-checker.ts` | modify | validated reads ×3 |
| `agents/summarizer.ts` | modify | validated reads ×3 |
| `agents/pipeline.ts` | modify | validated read ×1 (`final-review`, :205) |
| `agents/data-checker.ts` | modify | comment documenting the deliberate raw read |
| `db/load-from-tasks.ts` | modify | `parseArtifact` helper; validated reads ×6 |
| `render/build.ts` | modify | `CLIENT_SAFE_URL_SRC` + embed ×2 + href fix ×5 (spec follow-up 1) |
| `render/_safe.test.ts` | modify | client-side safeUrl hostile-payload tests |
| `package.json` | modify | test glob + `validate:corpus` script |

---

### Task 1: Branch + render baseline

**Files:** none (setup only)

- [ ] **Step 1: Create the branch**

```bash
cd ~/Developer/civiclens && git checkout -b feat/typed-artifact-reads
```

- [ ] **Step 2: Capture the render baseline**

Task 9 changes the emitted inline scripts, so the final diff must be reviewable against a known-good baseline of current `main`:

```bash
npx tsx render/build.ts
rm -rf /tmp/site-baseline-pr2 && cp -r site /tmp/site-baseline-pr2
find site -name '*.html' | sort | while read f; do sed 's/generated [0-9-]* [0-9:]*Z/generated TIMESTAMP/' "$f" | sha256sum | sed "s|-|$f|"; done > /tmp/site-before-pr2.txt
wc -l /tmp/site-before-pr2.txt
```

Expected: build completes; ~52 lines in the hash file. (The `sed` normalizes the footer timestamp — known minute-precision nondeterminism, see PR 1 plan Task 0 amendment.)

- [ ] **Step 3: Capture the DB-loader baseline** (used by Task 8 parity check)

```bash
npx tsx db/load-from-tasks.ts | tee /tmp/db-load-before-pr2.txt
```

Expected: `found N approved task(s)` then per-member counts, ending `loaded: ...`. Save output verbatim.

---

### Task 2: tsconfig.json + fix the two import errors

**Files:**
- Create: `tsconfig.json`
- Modify: `render/connections-to-vault.ts:20-21`

Probe already run (2026-06-12): this exact config surfaces **exactly 2 errors**, both TS5097 in `render/connections-to-vault.ts`. No other file errors.

- [ ] **Step 1: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["agents", "db", "lib", "render", "pipeline", "skills"]
}
```

Note: deliberately **not** `strict` — this PR makes the type gate *real*, not *stricter*. `skipLibCheck` because `@duckdb/node-api` typings are not ours to fix.

- [ ] **Step 2: Run tsc, confirm the known failure**

Run: `npx tsc --noEmit`
Expected: exactly 2 × TS5097 ("An import path can only end with a '.ts' extension…") at `render/connections-to-vault.ts(20)` and `(21)`.

- [ ] **Step 3: Fix the two imports**

In `render/connections-to-vault.ts`, change:

```ts
import { getDb } from '../db/init.ts';
import { findSharedDonors, listMembers, type SharedDonorPeer } from '../db/queries.ts';
```

to:

```ts
import { getDb } from '../db/init.js';
import { findSharedDonors, listMembers, type SharedDonorPeer } from '../db/queries.js';
```

(`.js`-suffix imports of `.ts` files are the repo convention; tsx resolves them.)

- [ ] **Step 4: Verify clean**

Run: `npx tsc --noEmit` → no output, exit 0.
Run: `npm test` → 32/32 pass (unchanged).
Run: `npx tsx render/connections-to-vault.ts --help 2>/dev/null; echo "exit=$?"` — just confirm the module still loads (any exit is fine as long as it's not a module-resolution crash). If the script has side effects on vault files when run bare, do **not** run it bare; loading is sufficiently proven by tsc + tsx import resolution in `npm test`.

- [ ] **Step 5: Commit**

```bash
git add tsconfig.json render/connections-to-vault.ts
git commit -m "chore: add tsconfig.json so the tsc gate is real; fix .ts-extension imports

Until now there was no tsconfig.json, so 'npx tsc --noEmit' printed help and
exited 0 — every prior 'tsc clean' claim was vacuous (spec follow-up 2)."
```

---

### Task 3: Artifact shape measurement script

**Files:**
- Create: `scripts/measure-artifact-shapes.ts`
- Create (generated): `docs/superpowers/plans/2026-06-12-artifact-shape-report.md`

The corpus is the spec. This script reports, per artifact kind, every observed field path with presence %, type histogram, and sample values — the raw material Task 5 uses to loosen the draft schemas.

- [ ] **Step 1: Write the script**

```ts
/**
 * Measure the observed shape of every pipeline artifact on disk.
 *
 * The PR 2 schema-derivation procedure (phase2-closeout spec) is artifact-
 * first: schemas must be generated from observed reality and validate 100%
 * of the existing corpus. This script produces the observation.
 *
 * Usage: npx tsx scripts/measure-artifact-shapes.ts [--out <file.md>]
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PIPE_DIR } from '../lib/paths.js';

const AGENTS = [
  'researcher', 'data-checker', 'code-checker', 'trade-analyst',
  'summarizer', 'predictor', 'final-review',
] as const;

interface FieldStat {
  /** number of artifacts in which this path appears at least once */
  presentIn: number;
  /** observed JS types across all occurrences (null distinct from object) */
  types: Map<string, number>;
  /** small distinct string values (enum candidates), capped */
  samples: Set<string>;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

const MAX_DEPTH = 6;
const MAX_SAMPLES = 12;

/** Collect path→types for ONE artifact (each path counted once for presence). */
function walk(value: unknown, path: string, acc: Map<string, { types: Set<string>; samples: Set<string> }>, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  const t = typeOf(value);
  const entry = acc.get(path) ?? { types: new Set(), samples: new Set() };
  entry.types.add(t);
  if (t === 'string' && (value as string).length <= 32 && entry.samples.size < MAX_SAMPLES) {
    entry.samples.add(value as string);
  }
  if (t === 'string' && /^-?\d+(\.\d+)?$/.test(value as string)) {
    entry.types.add('numeric-string'); // string-vs-number drift detector
  }
  acc.set(path, entry);
  if (t === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walk(v, path ? `${path}.${k}` : k, acc, depth + 1);
    }
  } else if (t === 'array') {
    for (const item of value as unknown[]) {
      walk(item, `${path}[]`, acc, depth + 1);
    }
  }
}

function main(): void {
  const taskDirs = readdirSync(PIPE_DIR).filter(d => d.startsWith('task-'));
  const report: string[] = [
    '# Artifact shape report',
    '',
    `Generated by scripts/measure-artifact-shapes.ts over ${taskDirs.length} task dirs in pipeline/.`,
    'Input to PR 2 schema derivation — see 2026-06-12-pr2-typed-artifact-reads.md.',
    '',
  ];

  for (const agent of AGENTS) {
    const stats = new Map<string, FieldStat>();
    let total = 0;
    let unparseable = 0;
    for (const dir of taskDirs) {
      const file = join(PIPE_DIR, dir, `${agent}.json`);
      if (!existsSync(file)) continue;
      total++;
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(file, 'utf-8')); }
      catch { unparseable++; continue; }
      const local = new Map<string, { types: Set<string>; samples: Set<string> }>();
      walk(parsed, '', local);
      for (const [path, { types, samples }] of local) {
        const s = stats.get(path) ?? { presentIn: 0, types: new Map(), samples: new Set() };
        s.presentIn++;
        for (const t of types) s.types.set(t, (s.types.get(t) ?? 0) + 1);
        for (const v of samples) if (s.samples.size < MAX_SAMPLES) s.samples.add(v);
        stats.set(path, s);
      }
    }

    report.push(`## ${agent}.json — ${total} artifacts (${unparseable} unparseable)`, '');
    if (total === 0) { report.push('_none on disk_', ''); continue; }
    report.push('| path | present | types | samples |', '|---|---|---|---|');
    const paths = [...stats.keys()].sort();
    for (const path of paths) {
      if (path === '') continue; // root
      const s = stats.get(path)!;
      const pct = Math.round((s.presentIn / total) * 100);
      const types = [...s.types.keys()].sort().join(', ');
      const samples = [...s.samples].slice(0, 6).map(v => `\`${v.replace(/\|/g, '\\|')}\``).join(' ');
      report.push(`| \`${path}\` | ${s.presentIn}/${total} (${pct}%) | ${types} | ${samples} |`);
    }
    report.push('');
  }

  const outIdx = process.argv.indexOf('--out');
  const outFile = outIdx > -1 ? process.argv[outIdx + 1] : 'docs/superpowers/plans/2026-06-12-artifact-shape-report.md';
  writeFileSync(outFile, report.join('\n'));
  console.log(`wrote ${outFile}`);
}

main();
```

- [ ] **Step 2: Run it**

Run: `npx tsx scripts/measure-artifact-shapes.ts`
Expected: `wrote docs/superpowers/plans/2026-06-12-artifact-shape-report.md`. Open the report; sanity-check researcher.json shows ~215 artifacts and `data.bills[].title` etc. appear. **Read the whole report carefully before Task 5 — every `<100%` presence is an `.optional()`, every `null` in types is a `.nullable()`, every multi-type row is a union.**

- [ ] **Step 3: Commit**

```bash
git add scripts/measure-artifact-shapes.ts docs/superpowers/plans/2026-06-12-artifact-shape-report.md
git commit -m "feat(scripts): artifact shape measurement over the task corpus

PR 2 schema derivation is artifact-first per the phase2-closeout spec; this
report of observed field presence/types/drift is the input the schemas are
generated from."
```

---

### Task 4: Draft output schemas in `lib/schemas.ts`

**Files:**
- Modify: `lib/schemas.ts` (append after `ResearcherOutputSchema`, before the CLI block at :106)

These drafts are transcribed from the **writer code as of today** (`data-checker.ts:121-130`, `code-checker.ts:68-79`, `summarizer.ts:165-175`, `trade-analyst.ts:8-43`, `skills/predictor/predict.ts:40-68`, `final-reviewer.ts:49-67`). Task 5 reconciles them against the corpus — expect to loosen. Presence/type only, no value constraints (scope decision 8).

- [ ] **Step 1: Append the schemas**

```ts
// ─── Agent output schemas (PR 2 — typed artifact reads) ─────────────────────
// Derived artifact-first: drafted from the writer code, then loosened until
// scripts/validate-artifact-corpus.ts reports 100% pass over pipeline/task-*.
// Deliberately presence/type-only (no .min()/.regex()): these are READ
// schemas guarding against shape drift, not quality gates. Tightening is
// deferred to a dedicated cleanup PR (phase2-closeout spec, PR 2 section).

const IssueSchema = z.object({
  field:    z.string(),
  severity: z.enum(['critical', 'warning', 'info']),
  message:  z.string(),
});

export const DataCheckerReportSchema = z.object({
  taskId:      z.string(),
  validatedAt: z.string(),
  passed:      z.boolean(),
  score:       z.number(),
  issues:      z.array(IssueSchema),
  summary:     z.string(),
});

export const CodeCheckerReportSchema = z.object({
  taskId:          z.string(),
  checkedAt:       z.string(),
  passed:          z.boolean(),
  score:           z.number(),
  issues:          z.array(IssueSchema),
  neutralityCheck: z.string(),
  typeCheck:       z.string(),
  summary:         z.string(),
});

export const SummarizerOutputSchema = z.object({
  taskId:               z.string(),
  summarizedAt:         z.string(),
  headline:             z.string(),
  bio:                  z.string(),
  keyFacts:             z.array(z.string()),
  unverifiedFacts:      z.array(z.string()),
  neutralNarrative:     z.string(),
  dataQualityNote:      z.string(),
  neutralityViolations: z.array(z.string()),
});

const TradeFindingSchema = z.object({
  tx_date:                  z.string(),
  tx_type:                  z.string(),
  asset:                    z.string(),
  ticker:                   z.string().nullable(),
  amount_band:              z.string(),
  days_before_vote:         z.number(),
  bill_title:               z.string().nullable(),
  vote_question:            z.string().nullable(),
  bill_source_url:          z.string().nullable(),
  member_on_bill_committee: z.boolean(),
  member_committee_role:    z.string().nullable(),
});

const TradeTickerSummarySchema = z.object({
  ticker:    z.string(),
  count:     z.number(),
  firstDate: z.string(),
  lastDate:  z.string(),
  txTypes:   z.string(),
});

export const TradeAnalystOutputSchema = z.object({
  taskId:                   z.string(),
  analyzedAt:               z.string(),
  hasData:                  z.boolean(),
  suspicionLevel:           z.enum(['none', 'low', 'medium', 'high']),
  tradeNarrative:           z.string(),
  narrativeSource:          z.enum(['deterministic', 'llm', 'none']),
  topFindings:              z.array(TradeFindingSchema),
  totalSuspiciousTrades:    z.number(),
  allDiscretionaryTrades:   z.array(TradeTickerSummarySchema),
  totalDiscretionaryTrades: z.number(),
});

// Current writer is skills/predictor/predict.ts (PredictorOutput interface).
// The DB loader also tolerates a LEGACY shape (`models`/`results` arrays —
// see load-from-tasks.ts:257) which the corpus likely still contains; the
// measurement report decides whether the legacy union below is needed.
const ModelScoreSchema = z.object({
  model:          z.string(),
  sampleSize:     z.number(),
  trainSize:      z.number(),
  brierScore:     z.number(),
  logLoss:        z.number(),
  accuracy:       z.number(),
  meanPrediction: z.number(),
  actualRate:     z.number(),
  buckets:        z.array(z.unknown()),
});

export const PredictorOutputSchema = z.object({
  source:      z.string(),
  generatedAt: z.string(),
  subject:     z.object({
    id:      z.string(),
    name:    z.string(),
    chamber: z.string(),
    party:   z.string(),
  }),
  sampleSize:  z.object({
    memberVotes:   z.number(),
    binaryVotes:   z.number(),
    corpusMembers: z.number(),
    peerMembers:   z.number(),
  }),
  calibration: z.array(ModelScoreSchema),
  bestModel:   z.string().nullable(),
  warnings:    z.array(z.string()),
});

export const FinalReviewReportSchema = z.object({
  taskId:         z.string(),
  reviewedAt:     z.string(),
  decision:       z.enum(['approved', 'approved_with_warnings', 'rejected']),
  politicianId:   z.string(),
  politicianName: z.string(),
  checklist:      z.record(z.boolean()),
  issues:         z.array(z.object({
    category: z.string(),
    severity: z.string(),
    message:  z.string(),
  })),
  summary:        z.string(),
  readyToApply:   z.boolean(),
});
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit` → clean.

- [ ] **Step 3: Commit** (drafts only — reconciliation is the next task and will amend)

```bash
git add lib/schemas.ts
git commit -m "feat(schemas): draft output schemas for the six live artifact kinds

Transcribed from current writer code; corpus reconciliation (next commit)
loosens them to validate 100% of artifacts on disk."
```

---

### Task 5: Corpus validation harness + reconcile schemas to 100%

**Files:**
- Create: `scripts/validate-artifact-corpus.ts`
- Modify: `lib/schemas.ts` (loosening edits driven by harness failures)
- Modify: `package.json` (add `validate:corpus` script)

- [ ] **Step 1: Write the harness**

```ts
/**
 * The PR 2 merge gate: every artifact under pipeline/task-* must validate
 * against its schema. Exit 0 only on 100% pass.
 *
 * Usage: npx tsx scripts/validate-artifact-corpus.ts
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ZodTypeAny } from 'zod';
import { PIPE_DIR } from '../lib/paths.js';
import {
  ResearcherOutputSchema, DataCheckerReportSchema, CodeCheckerReportSchema,
  TradeAnalystOutputSchema, SummarizerOutputSchema, PredictorOutputSchema,
  FinalReviewReportSchema,
} from '../lib/schemas.js';

const SCHEMAS: Record<string, ZodTypeAny> = {
  'researcher':    ResearcherOutputSchema,
  'data-checker':  DataCheckerReportSchema,
  'code-checker':  CodeCheckerReportSchema,
  'trade-analyst': TradeAnalystOutputSchema,
  'summarizer':    SummarizerOutputSchema,
  'predictor':     PredictorOutputSchema,
  'final-review':  FinalReviewReportSchema,
};

const MAX_SIGNATURES = 8;

function main(): void {
  const taskDirs = readdirSync(PIPE_DIR).filter(d => d.startsWith('task-'));
  let anyFail = false;

  for (const [agent, schema] of Object.entries(SCHEMAS)) {
    let total = 0, pass = 0, unparseable = 0;
    const signatures = new Map<string, { count: number; example: string }>();
    for (const dir of taskDirs) {
      const file = join(PIPE_DIR, dir, `${agent}.json`);
      if (!existsSync(file)) continue;
      total++;
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(file, 'utf-8')); }
      catch { unparseable++; continue; } // unparseable JSON is skipped by every
                                         // live reader today (try/catch); not a
                                         // schema problem. Reported, not failed.
      const r = schema.safeParse(parsed);
      if (r.success) { pass++; continue; }
      const first = r.error.issues[0];
      const sig = `${first.path.join('.')} [${first.code}] ${first.message}`;
      const e = signatures.get(sig) ?? { count: 0, example: dir };
      e.count++;
      signatures.set(sig, e);
    }
    const failed = total - unparseable - pass;
    const status = failed === 0 ? 'PASS' : 'FAIL';
    console.log(`${status}  ${agent.padEnd(14)} ${pass}/${total - unparseable} valid (${unparseable} unparseable skipped)`);
    if (failed > 0) {
      anyFail = true;
      let shown = 0;
      for (const [sig, { count, example }] of signatures) {
        if (shown++ >= MAX_SIGNATURES) { console.log(`       … ${signatures.size - MAX_SIGNATURES} more signatures`); break; }
        console.log(`       ×${String(count).padStart(4)}  ${sig}  (e.g. ${example})`);
      }
    }
  }
  process.exit(anyFail ? 1 : 0);
}

main();
```

- [ ] **Step 2: Add the npm script**

In `package.json` `"scripts"`, add:

```json
"validate:corpus": "tsx scripts/validate-artifact-corpus.ts"
```

- [ ] **Step 3: Run it — expect failures (this is the red step)**

Run: `npm run validate:corpus`
Expected: several `FAIL` lines with grouped failure signatures. (If everything passes first try, great — skip to Step 5.)

- [ ] **Step 4: Reconcile until 100%**

For each failure signature, consult `docs/superpowers/plans/2026-06-12-artifact-shape-report.md` and apply the matching loosening **to the schema in `lib/schemas.ts`**, with a one-line comment naming the observed reality, e.g.:

```ts
  // 41/200 historical artifacts lack checkedAt (pre-2026-05 writer) — observed in corpus
  checkedAt: z.string().optional(),
```

Loosening vocabulary (only these moves are allowed):
- missing field in some artifacts → `.optional()`
- `null` observed → `.nullable()`
- type drift (e.g. `"confidence": "0.83"`) → `z.union([z.number(), z.string()])`
- enum value outside today's set → widen to `z.string()` (do NOT extend the enum speculatively)
- legacy alternative shape (e.g. predictor `models`/`results`) → `z.union([CurrentSchema, LegacySchema])` with the legacy member spelled out from the report

**Hard rules:**
- Re-run `npm run validate:corpus` after each edit; stop when every line is `PASS`.
- **Never edit `ResearcherOutputSchema` or anything it references** (`PoliticianDataSchema` etc.) — it is the Data Checker's quality gate. If `researcher` fails the corpus: add a separate loose `ResearcherArtifactSchema` (same field list, loosened per report), export it, and point the harness's `'researcher'` entry at it. Record which branch was taken — Task 8 needs to know (scope decision 7).
- If a failure signature affects only artifacts in task dirs that can never be read (no `state.json`, or `readyToApply: false` with no other reader) — it STILL must pass; the gate is "100% of existing artifacts", not "100% of reachable artifacts". Loosen anyway.

- [ ] **Step 5: Verify the gate and type-check**

Run: `npm run validate:corpus` → all 7 lines `PASS`, exit 0.
Run: `npx tsc --noEmit` → clean.

- [ ] **Step 6: Commit**

```bash
git add lib/schemas.ts scripts/validate-artifact-corpus.ts package.json
git commit -m "feat(schemas): reconcile artifact schemas to 100% corpus validity

scripts/validate-artifact-corpus.ts is the PR 2 merge gate: every
<agent>.json under pipeline/task-* validates. Each loosening is annotated
with the corpus observation that forced it."
```

---

### Task 6: `readPipe` schema parameter + malformed-artifact test

**Files:**
- Modify: `agents/shared.ts:96-98`
- Create: `agents/shared.test.ts`
- Modify: `package.json` (test glob)

- [ ] **Step 1: Write the failing test**

`agents/shared.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readPipe } from './shared.js';
import { PIPE_DIR } from '../lib/paths.js';

// Deliberately does NOT start with 'task-': the corpus measurement/validation
// scripts filter on that prefix, so this fixture can never pollute the gate.
const FIXTURE_ID = 'tmp-readpipe-test';
const FIXTURE_DIR = join(PIPE_DIR, FIXTURE_ID);

const FixtureSchema = z.object({
  taskId: z.string(),
  passed: z.boolean(),
});

function withFixture(content: unknown, fn: () => void): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(join(FIXTURE_DIR, 'data-checker.json'), JSON.stringify(content));
  try { fn(); } finally { rmSync(FIXTURE_DIR, { recursive: true, force: true }); }
}

test('readPipe without a schema returns raw JSON (back-compat)', () => {
  withFixture({ anything: 'goes' }, () => {
    const out = readPipe<any>(FIXTURE_ID, 'data-checker');
    assert.deepEqual(out, { anything: 'goes' });
  });
});

test('readPipe with a schema accepts a valid artifact and returns the RAW object', () => {
  withFixture({ taskId: 't1', passed: true, extraField: 'kept' }, () => {
    const out = readPipe<any>(FIXTURE_ID, 'data-checker', FixtureSchema as any);
    // Raw, not Zod-transformed: unknown keys must survive (no stripping).
    assert.equal(out.extraField, 'kept');
  });
});

test('readPipe error names the task, agent, and offending field', () => {
  withFixture({ taskId: 't1', passed: 'yes' }, () => {
    assert.throws(
      () => readPipe<any>(FIXTURE_ID, 'data-checker', FixtureSchema as any),
      (e: Error) =>
        e.name === 'ArtifactValidationError' &&
        e.message.includes(FIXTURE_ID) &&
        e.message.includes('data-checker') &&
        e.message.includes('passed'),
    );
  });
});
```

- [ ] **Step 2: Extend the test glob**

In `package.json`:

```json
"test": "tsx --test pipeline/patterns/*.test.ts render/*.test.ts agents/*.test.ts"
```

- [ ] **Step 3: Run — expect the third test to fail**

Run: `npm test`
Expected: first two pass (back-compat + extra-arg-ignored), third FAILS (no error thrown — `readPipe` currently ignores a third argument).

- [ ] **Step 4: Implement**

In `agents/shared.ts`, add to the imports at the top:

```ts
import type { ZodTypeAny } from 'zod';
```

Replace `readPipe` (currently :96-98):

```ts
/**
 * Thrown when an artifact on disk fails its schema (PR 2 typed reads).
 * Optional-sidecar readers catch this and log a warning; required readers
 * let it propagate — a malformed required artifact must kill the run loudly.
 */
export class ArtifactValidationError extends Error {
  constructor(taskId: string, name: string, issues: { path: (string | number)[]; message: string }[]) {
    const first = issues[0];
    const field = first && first.path.length ? first.path.join('.') : '(root)';
    const more = issues.length > 1 ? ` (+${issues.length - 1} more issue${issues.length > 2 ? 's' : ''})` : '';
    super(`artifact validation failed: task=${taskId} agent=${name} field=${field} — ${first?.message ?? 'unknown'}${more}`);
    this.name = 'ArtifactValidationError';
  }
}

export function readPipe<T>(taskId: string, name: string, schema?: ZodTypeAny): T {
  const raw = JSON.parse(fs.readFileSync(pipeFile(taskId, name), 'utf-8'));
  if (schema) {
    const result = schema.safeParse(raw);
    if (!result.success) throw new ArtifactValidationError(taskId, name, result.error.issues);
  }
  // Raw on purpose, never result.data: Zod strips unknown keys and injects
  // .default() values; this is validation, not transformation (PR 2 plan,
  // scope decision 6).
  return raw as T;
}
```

- [ ] **Step 5: Verify green**

Run: `npm test` → all pass (32 + 3 new).
Run: `npx tsc --noEmit` → clean.

- [ ] **Step 6: Commit**

```bash
git add agents/shared.ts agents/shared.test.ts package.json
git commit -m "feat(shared): readPipe(taskId, name, schema?) — validate-on-read

Errors name taskId, agent, and offending field. Returns raw JSON on success
(validation, not transformation). No call sites converted yet."
```

---

### Task 7: Convert the live agent read sites

**Files:**
- Modify: `agents/final-reviewer.ts:1-15`
- Modify: `agents/code-checker.ts:1-18`
- Modify: `agents/summarizer.ts:1-21`
- Modify: `agents/pipeline.ts:205` (+ import)
- Modify: `agents/data-checker.ts:14` (comment only)

Semantics to preserve (spec): required reads throw; optional reads (`try/catch` sites) keep running, but a *schema* failure now logs a warning instead of passing silently. A *missing file* stays silent exactly as today.

- [ ] **Step 1: `agents/final-reviewer.ts`**

Add to imports:

```ts
import {
  ResearcherOutputSchema, DataCheckerReportSchema, CodeCheckerReportSchema,
  SummarizerOutputSchema,
} from '../lib/schemas.js';
import { ArtifactValidationError } from './shared.js';
```

(Merge the `ArtifactValidationError` import into the existing `./shared.js` import list at :2-5.)

Replace lines 10-15:

```ts
  const researcher  = readPipe<any>(task.taskId, 'researcher', ResearcherOutputSchema);
  const dataChecker = readPipe<any>(task.taskId, 'data-checker', DataCheckerReportSchema);
  const codeChecker = readPipe<any>(task.taskId, 'code-checker', CodeCheckerReportSchema);
  // Optional sidecar — absent when skipped (CIVICLENS_SUMMARIZER=0) or failed.
  // Missing file stays silent (today's semantics); a malformed artifact warns.
  let summarizer: any = null;
  try { summarizer = readPipe<any>(task.taskId, 'summarizer', SummarizerOutputSchema); }
  catch (e) { if (e instanceof ArtifactValidationError) warn('Final Reviewer', e.message); }
```

- [ ] **Step 2: `agents/code-checker.ts`**

Add to imports (`./shared.js` list at :2-5 already has `warn`? — check; add if missing) plus:

```ts
import { ResearcherOutputSchema, SummarizerOutputSchema, TradeAnalystOutputSchema } from '../lib/schemas.js';
```

and `ArtifactValidationError` from `./shared.js`. Replace lines 12-18 (the three reads):

```ts
  const researcher = readPipe<any>(task.taskId, 'researcher', ResearcherOutputSchema);
  // Optional sidecars: missing file silent, malformed artifact warns.
  let summarizer: any = null;
  let tradeAnalyst: any = null;
  try { summarizer = readPipe<any>(task.taskId, 'summarizer', SummarizerOutputSchema); }
  catch (e) { if (e instanceof ArtifactValidationError) warn('Code Checker', e.message); }
  try { tradeAnalyst = readPipe<any>(task.taskId, 'trade-analyst', TradeAnalystOutputSchema); }
  catch (e) { if (e instanceof ArtifactValidationError) warn('Code Checker', e.message); }
```

(Keep any code between the original lines — read the file first; only the `readPipe` expressions and their `try/catch` wrappers change.)

- [ ] **Step 3: `agents/summarizer.ts`**

Imports: `ResearcherOutputSchema, DataCheckerReportSchema, TradeAnalystOutputSchema` from `../lib/schemas.js`; `ArtifactValidationError` from `./shared.js`. Replace lines 16-21 reads:

```ts
  const researcher = readPipe<any>(task.taskId, 'researcher', ResearcherOutputSchema);
  const checker    = readPipe<any>(task.taskId, 'data-checker', DataCheckerReportSchema);
  ...
  let tradeAnalyst: any = null;
  try { tradeAnalyst = readPipe<any>(task.taskId, 'trade-analyst', TradeAnalystOutputSchema); }
  catch (e) { if (e instanceof ArtifactValidationError) warn('Summarizer', e.message); }
```

(The `...` marks unchanged lines between the reads — preserve them verbatim; only the three read expressions change.)

- [ ] **Step 4: `agents/pipeline.ts:205`**

Import `FinalReviewReportSchema` from `../lib/schemas.js`, then:

```ts
  const finalReview = readPipe<any>(taskId, 'final-review', FinalReviewReportSchema);
```

- [ ] **Step 5: `agents/data-checker.ts:14` — document the deliberate raw read**

Above `const raw = readPipe<any>(task.taskId, 'researcher');` add:

```ts
  // DELIBERATELY no schema on this read (PR 2 scope decision 1): the Data
  // Checker IS the validator for researcher.json. It reads raw, auto-corrects,
  // then runs ResearcherOutputSchema.safeParse itself (below) and reports
  // failures as critical issues — which feeds the pipeline's retry-researcher
  // coupling. A throwing read here would turn "checker fails → retry" into
  // "run crashes".
```

(Same applies to the second raw read at :71 — it re-reads to write back corrections; add `// raw on purpose — see comment at the first read` there.)

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit` → clean.
Run: `npm test` → all green.
Run: `npm run validate:corpus` → all `PASS` (unchanged — proves the schemas the agents now enforce still match the corpus).

- [ ] **Step 7: Commit**

```bash
git add agents/final-reviewer.ts agents/code-checker.ts agents/summarizer.ts agents/pipeline.ts agents/data-checker.ts
git commit -m "feat(agents): schema-validate all live readPipe sites

Required reads throw ArtifactValidationError; optional sidecar reads warn
and continue (missing file stays silent, as before). Data Checker reads stay
raw by design — it is the validator, and its failure-as-report feeds the
researcher retry coupling."
```

---

### Task 8: Convert the DB loader (the real publish path)

**Files:**
- Modify: `db/load-from-tasks.ts` (helper + 6 read sites)
- No change: `db/sync-task.ts` (reads only `state.json` — scope decision 2)

- [ ] **Step 1: Add imports and the helper**

After the existing imports in `db/load-from-tasks.ts`:

```ts
import type { ZodTypeAny } from 'zod';
import {
  ResearcherOutputSchema, FinalReviewReportSchema, SummarizerOutputSchema,
  TradeAnalystOutputSchema, PredictorOutputSchema,
} from '../lib/schemas.js';
```

**If Task 5 created `ResearcherArtifactSchema`** (loose loader-side variant — check `lib/schemas.ts`), import and use that here instead of `ResearcherOutputSchema` (scope decision 7).

After the `canonicalDonor` function, add:

```ts
/**
 * JSON.parse + schema check for direct artifact reads (PR 2 typed reads).
 * Validates but returns the RAW object — same rationale as readPipe in
 * agents/shared.ts: Zod stripping/defaults would change what loaders see.
 */
function parseArtifact(path: string, schema: ZodTypeAny, label: string): any {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const result = schema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const field = first && first.path.length ? first.path.join('.') : '(root)';
    throw new Error(`artifact validation failed: ${label} at ${path} field=${field} — ${first?.message ?? 'unknown'}`);
  }
  return raw;
}
```

- [ ] **Step 2: `findLatestApproved` (line ~36-40)** — validate `final-review.json`; a failing dir is skipped *with a warning* (the silent `continue` was already the parse-failure behavior; schema failures get a console.warn so a bad artifact can't silently drop a member from the DB):

```ts
    let state: any, final: any;
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      final = parseArtifact(finalFile, FinalReviewReportSchema, 'final-review');
    } catch (e: any) {
      if (String(e?.message).startsWith('artifact validation failed')) {
        console.warn(`skipping ${t}: ${e.message}`);
      }
      continue;
    }
```

- [ ] **Step 3: `loadOne` researcher read (line ~99)** — required, hard-throws (today a JSON.parse failure already crashes the loader; schema failure now does the same, with a better message):

```ts
  const r = parseArtifact(researcherPath, ResearcherOutputSchema, 'researcher');
```

(Or `ResearcherArtifactSchema` per the Task 5 branch.)

- [ ] **Step 4: `loadOne` optional reads** — keep each inside its existing `try/catch`, validate within, warn on schema failure so it is never silent:

Line ~214 (`final` for pipeline_runs):

```ts
  let final: any = null;
  try { final = parseArtifact(resolve(pick.taskDir, 'final-review.json'), FinalReviewReportSchema, 'final-review'); }
  catch (e: any) { if (String(e?.message).startsWith('artifact validation failed')) console.warn(e.message); }
```

Line ~217 (summarizer):

```ts
  try {
    const s = parseArtifact(resolve(pick.taskDir, 'summarizer.json'), SummarizerOutputSchema, 'summarizer');
    // Summarizer writes bio/keyFacts/neutralNarrative — there is no `summary`
    // field, so the old `s.summary ?? s.text` read left this column NULL forever.
    summary = s.neutralNarrative ?? s.bio ?? null;
  } catch (e: any) { if (String(e?.message).startsWith('artifact validation failed')) console.warn(e.message); }
```

Line ~243 (trade-analyst — inside the existing `try` block, replace only the parse):

```ts
      const ta = parseArtifact(taPath, TradeAnalystOutputSchema, 'trade-analyst');
```

and extend the block's `catch { /* non-fatal */ }` to:

```ts
  } catch (e: any) {
    if (String(e?.message).startsWith('artifact validation failed')) console.warn(e.message);
    /* non-fatal */
  }
```

Line ~256 (predictor — same pattern):

```ts
    const p = parseArtifact(resolve(pick.taskDir, 'predictor.json'), PredictorOutputSchema, 'predictor');
```

with the trailing `catch {}` extended to warn on validation failures the same way.

- [ ] **Step 5: Parity check against the Task 1 baseline**

Run: `npx tsx db/load-from-tasks.ts | tee /tmp/db-load-after-pr2.txt`
Run: `diff /tmp/db-load-before-pr2.txt /tmp/db-load-after-pr2.txt`
Expected: **empty diff** — same members, same counts, no validation warnings (the corpus gate guarantees every artifact passes).

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit` → clean. Run: `npm test` → green.

- [ ] **Step 7: Commit**

```bash
git add db/load-from-tasks.ts
git commit -m "feat(db): schema-validate artifact reads in the publish-path loader

Same semantics map as the agent sites: required (researcher) throws, optional
(final-review/summarizer/trade-analyst/predictor) warns and continues, and a
task dir whose final-review.json fails validation is skipped loudly instead of
silently. Verified load-count parity against the pre-change baseline.
sync-task.ts unchanged — it reads only state.json (out of scope, plan
decision 2)."
```

---

### Task 9: Client-side URL allowlist in inline scripts (PR 1 follow-up 1)

**Files:**
- Modify: `render/build.ts` (new export ~:88; embed ×2; href fix ×5)
- Modify: `render/_safe.test.ts`

The 5 slots (`build.ts:900`, `:919`, `:2023`, `:2024`, `:2025`) build hrefs **in the browser** from `source_url`-class data using `escHtml` only — entity-encoding does not neutralize `javascript:`. All five slots only ever carry absolute external source URLs, so the client guard allowlists `http(s)://` only (tighter than the server `safeUrl`, which also passes `#anchors` — those never appear in these slots).

- [ ] **Step 1: Write the failing tests**

Append to `render/_safe.test.ts` (and extend its import line):

```ts
import { esc, safeJson, safeUrl, memberHref, CLIENT_SAFE_URL_SRC } from './build.js';

// Evaluate the EXACT source string that ships inside the inline <script>
// blocks — the test and the page run the same code.
const clientSafeUrl = new Function(`${CLIENT_SAFE_URL_SRC}; return safeUrl;`)() as (u: unknown) => string;

test('client safeUrl passes absolute http/https URLs', () => {
  assert.equal(clientSafeUrl('https://www.govtrack.us/congress/votes/119-2026/h137'), 'https://www.govtrack.us/congress/votes/119-2026/h137');
  assert.equal(clientSafeUrl('http://example.com/x'), 'http://example.com/x');
});

test('client safeUrl collapses hostile and malformed values to #', () => {
  assert.equal(clientSafeUrl('javascript:alert(1)'), '#');
  assert.equal(clientSafeUrl(' jAvAsCrIpT:alert(1)'), '#');
  assert.equal(clientSafeUrl('data:text/html,<script>x</script>'), '#');
  assert.equal(clientSafeUrl('vbscript:msgbox(1)'), '#');
  assert.equal(clientSafeUrl('//protocol-relative.example'), '#');
  assert.equal(clientSafeUrl(''), '#');
  assert.equal(clientSafeUrl(null), '#');
  assert.equal(clientSafeUrl(undefined), '#');
  assert.equal(clientSafeUrl(42), '#');
});

test('emitted member-page scripts route external hrefs through client safeUrl', () => {
  const src = readFileSync(new URL('./build.ts', import.meta.url), 'utf-8');
  for (const slot of ['rep.source_url', 't.source_url', 'd.tu', 'd.vu', 'd.bu']) {
    assert.ok(src.includes(`escHtml(safeUrl(${slot}))`), `${slot} must be wrapped: escHtml(safeUrl(${slot}))`);
  }
});
```

Add `import { readFileSync } from 'node:fs';` to the test file's imports.

- [ ] **Step 2: Run — expect failures**

Run: `npm test`
Expected: the new tests fail (`CLIENT_SAFE_URL_SRC` is not exported → import error or undefined).

- [ ] **Step 3: Implement in `render/build.ts`**

After `memberHref` (:84-87), add:

```ts
/**
 * Client-side counterpart to safeUrl(), embedded verbatim into the inline
 * scripts that build hrefs in the browser (timeline tooltips, nexus showLoop).
 * Those slots only ever carry absolute external source URLs, so this guard
 * allowlists http/https only. Exported as a source string so tests evaluate
 * the exact code that ships in the <script> blocks. ES5-only syntax: it runs
 * in the page, not in tsx.
 */
export const CLIENT_SAFE_URL_SRC = `
  function safeUrl(u) {
    if (typeof u !== 'string') return '#';
    var s = u.trim();
    var lower = s.toLowerCase();
    if (lower.indexOf('http://') === 0 || lower.indexOf('https://') === 0) return s;
    return '#';
  }`;
```

- [ ] **Step 4: Embed it in the two inline scripts**

(a) **Timeline script** — directly after the client `escHtml` definition that follows the comment at :780 (`// safeJson prevents </script> breakout; client-side escHtml() still guards DOM writes.`), i.e. after the closing `}` of `function escHtml(s) {` at ~:801, insert on a new line:

```ts
  ${CLIENT_SAFE_URL_SRC}
```

(The surrounding code is a template literal — interpolation is the mechanism. Confirm the enclosing backtick context before editing; the `escHtml` at :801 sits inside the member-page template.)

(b) **Nexus script** — same insertion after the `escHtml` definition at ~:1890 (inside the nexus page template). Do **not** touch the third `escHtml` at :1651 (cross-member table — its hrefs are internal member slugs, already guarded server-side).

- [ ] **Step 5: Wrap the five href slots**

| line | old | new |
|---|---|---|
| :900 | `escHtml(rep.source_url)` | `escHtml(safeUrl(rep.source_url))` |
| :919 | `escHtml(t.source_url)` | `escHtml(safeUrl(t.source_url))` |
| :2023 | `escHtml(d.tu)` | `escHtml(safeUrl(d.tu))` |
| :2024 | `escHtml(d.vu)` | `escHtml(safeUrl(d.vu))` |
| :2025 | `escHtml(d.bu)` | `escHtml(safeUrl(d.bu))` |

(Line numbers shift after Step 3-4 insertions — match on the quoted expressions, each unique in the file.)

- [ ] **Step 6: Verify green + render diff**

Run: `npm test` → all pass.
Run: `npx tsc --noEmit` → clean.
Render and diff against the Task 1 baseline:

```bash
npx tsx render/build.ts
find site -name '*.html' | sort | while read f; do sed 's/generated [0-9-]* [0-9:]*Z/generated TIMESTAMP/' "$f" | sha256sum | sed "s|-|$f|"; done > /tmp/site-after-pr2.txt
diff /tmp/site-before-pr2.txt /tmp/site-after-pr2.txt | wc -l
# inspect ONE changed member page in full to confirm the diff is only the script change:
M=$(ls site/members/*.html | head -1)
diff <(sed 's/generated [0-9-]* [0-9:]*Z/generated TIMESTAMP/' "/tmp/site-baseline-pr2/${M#site/}") <(sed 's/generated [0-9-]* [0-9:]*Z/generated TIMESTAMP/' "$M")
```

Expected: hash diffs **only** on pages embedding the two scripts; the inspected page diff shows **only** the inserted `safeUrl` function and the five wrapped call sites. Any other change is a regression — stop and investigate.

- [ ] **Step 7: Commit**

```bash
git add render/build.ts render/_safe.test.ts
git commit -m "fix(render): client-side URL allowlist in inline scripts

The timeline tooltip and nexus showLoop build hrefs in the browser with
escHtml only — entity-encoding does not neutralize javascript: URLs in
source_url data (PR 1 follow-up 1). Embed a client safeUrl (http/https
allowlist) in both scripts and wrap all five slots; tests evaluate the exact
shipped source string."
```

---

### Task 10: Full verification gate + spec close-out

**Files:**
- Modify: `docs/superpowers/specs/2026-06-10-phase2-closeout-design.md` (status + deviations)

- [ ] **Step 1: The four spec verifications, in order**

```bash
npx tsc --noEmit          # 1. clean (now a real check — tsconfig exists)
npm test                  # 2. all green, incl. malformed-artifact + client-safeUrl tests
npm run validate:corpus   # 3. 100% — the artifact-first acceptance bar
```

Then the pipeline smoke (spec verification #3) on an **existing** member (feature freeze — do not add members). First check the CLI contract:

```bash
npx tsx agents/pipeline.ts --help
```

then run with the re-run/force flag shown there on a member already in the roster (gold standard: MTG), e.g.:

```bash
npx tsx agents/pipeline.ts "Marjorie Taylor Greene" --force
```

Expected: run completes through Final Reviewer with a Decision line; **no `ArtifactValidationError`** anywhere; the post-run `sync-task` succeeds. This exercises every converted read site on a fresh artifact set.

- [ ] **Step 2: Re-confirm the render diff** (Task 9 Step 6 already did; re-run the hash diff once more after the smoke run rebuilt the site, to catch surprises from the fresh artifacts):

```bash
find site -name '*.html' | sort | while read f; do sed 's/generated [0-9-]* [0-9:]*Z/generated TIMESTAMP/' "$f" | sha256sum | sed "s|-|$f|"; done > /tmp/site-final-pr2.txt
diff /tmp/site-after-pr2.txt /tmp/site-final-pr2.txt
```

Expected: empty, **or** differences only on the smoked member's page (fresh data) — anything else is a regression.

- [ ] **Step 3: Update the spec**

In `docs/superpowers/specs/2026-06-10-phase2-closeout-design.md`:
- Status line (:4): `PRs 1–2 implemented` (adjust wording in place).
- In the PR 2 section, append a short "Implemented — deviations" note recording: (a) data-checker reads left raw by design (it is the validator; failure-as-report feeds the retry coupling); (b) `state.json` reads out of scope (not an `<agent>.json`; consumers null-guard; `sync-task.ts` unchanged); (c) follow-ups 1 (client safeUrl) and 2 (tsconfig) both landed in this PR; (d) which researcher-schema branch Task 5 took.
- In the Follow-ups section, mark items 1 and 2 as resolved in PR 2.

- [ ] **Step 4: Final commit**

```bash
git add docs/superpowers/specs/2026-06-10-phase2-closeout-design.md
git commit -m "docs(spec): mark PR 2 implemented; record scope deviations"
```

- [ ] **Step 5: Hand off** — use superpowers:finishing-a-development-branch (user decided PR 1 by local merge + push; ask again for this branch).

---

## Self-review notes (done at plan-writing time)

- Spec coverage: schemas for the five spec-named producers **plus code-checker** (required because final-reviewer's `readPipe<any>` of `code-checker.json` is a live site the spec says to convert); `readPipe` schema param with taskId/agent/field error ✓; optional-sidecar warn-don't-kill ✓; db loader converted ✓; devils-advocate untouched ✓; tsc/tests/malformed-artifact/smoke verifications ✓; follow-ups 1 & 2 folded in ✓.
- Known deviations are pre-decided and documented (scope decisions 1-2), not discovered mid-execution.
- The tsc surface was probed before planning: exactly 2 errors, both `.ts`-extension imports — Task 2 is bounded.
- U+2028/U+2029 gotcha (see `.remember/`): none of the new code in this plan writes those escape sequences through Write/Edit; `CLIENT_SAFE_URL_SRC` deliberately avoids regex-with-slashes and line-separator escapes. If an executor ever needs them, patch via `python3` heredoc with `chr()` composition and verify with `cat -A`.
- Estimate: ~2–2.5h; the open-ended part is Task 5 reconciliation (the spec's "schema-vs-reality is the slow part").
