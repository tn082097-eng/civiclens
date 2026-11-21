/**
 * The PR 2 merge gate: every artifact under pipeline/task-* must validate
 * against its schema, and every REQUIRED artifact family must actually exist.
 *
 * The original gate only asked "does every artifact that EXISTS parse?". A
 * required family that produced nothing scored `0/0` and printed PASS. That is
 * how the stratum-4 trial (Chris Van Hollen, 2026-09-09) reported a green
 * corpus while the summarizer had timed out twice and written no artifact:
 * `PASS summarizer 0/0 valid`. Zero produced artifacts for a required family is
 * an absence of evidence, not evidence of validity.
 *
 * A required family may report PASS with zero artifacts only when it is
 * explicitly accounted for by a corroborated source-backed verified-empty
 * record. A withheld record remains visible but fails the gate: a formatting
 * hold is not certification. Absence is never inferred; it must be asserted
 * with a source.
 *
 * Usage: npx tsx scripts/validate-artifact-corpus.ts
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ZodTypeAny } from 'zod';
import { PIPE_DIR } from '../lib/paths.js';
import { REQUIRED_AGENTS } from '../agents/required-agents.js';
import {
  ResearcherArtifactSchema, DataCheckerReportSchema, CodeCheckerReportSchema,
  TradeAnalystOutputSchema, SummarizerOutputSchema, PredictorOutputSchema,
  FinalReviewReportSchema,
} from '../lib/schemas.js';

const SCHEMAS: Record<string, ZodTypeAny> = {
  // The loose read variant, NOT the strict ResearcherOutputSchema: the strict
  // schema is the Data Checker's quality gate and 14 historical artifacts
  // predate its bills[].summary auto-correction (PR 2 scope decision 7).
  'researcher':    ResearcherArtifactSchema,
  'data-checker':  DataCheckerReportSchema,
  'code-checker':  CodeCheckerReportSchema,
  'trade-analyst': TradeAnalystOutputSchema,
  'summarizer':    SummarizerOutputSchema,
  'predictor':     PredictorOutputSchema,
  'final-review':  FinalReviewReportSchema,
};

const MAX_SIGNATURES = 8;

/**
 * Artifact families a fresh-member run is expected to produce. Derived from
 * REQUIRED_AGENTS so the corpus gate and the pipeline's fail-closed rule cannot
 * drift apart. `final-reviewer` is the agent key; `final-review.json` is the
 * artifact filename.
 */
export const REQUIRED_FAMILIES: readonly string[] = REQUIRED_AGENTS.map(
  a => (a === 'final-reviewer' ? 'final-review' : a));

/**
 * An explicit, source-backed record explaining a zero-artifact family.
 * `verified-empty` may close it; `withheld` is an accounted failure.
 */
export interface AccountedEmpty {
  state: 'verified-empty' | 'withheld';
  /** The corroborating source (a search receipt, a disclosure record). */
  sourceUrl?: string;
}

export interface FamilyReport {
  agent: string;
  total: number;
  pass: number;
  unparseable: number;
  failed: number;
  required: boolean;
  status: 'PASS' | 'FAIL';
  /** Set when the family failed purely because it produced nothing. */
  missing?: boolean;
  accountedEmpty?: AccountedEmpty;
  signatures: Array<{ sig: string; count: number; example: string }>;
}

export interface CorpusReport {
  families: FamilyReport[];
  ok: boolean;
}

export interface ValidateCorpusOpts {
  /** Root holding task-* directories. Defaults to the repo's pipeline dir. */
  corpusDir?: string;
  /** Exact approved task IDs resolved by the release verifier. */
  taskIds?: readonly string[];
  /** Families that must exist. Defaults to REQUIRED_FAMILIES. */
  required?: readonly string[];
  /** Source-backed records excusing a required family's emptiness. */
  accountedEmpty?: Record<string, AccountedEmpty>;
}

export function validateCorpus(opts: ValidateCorpusOpts = {}): CorpusReport {
  const corpusDir = opts.corpusDir ?? PIPE_DIR;
  const required = new Set(opts.required ?? REQUIRED_FAMILIES);
  const accounted = opts.accountedEmpty ?? {};

  if (opts.taskIds) {
    if (opts.taskIds.length === 0) throw new Error('Release task IDs must be nonempty');
    if (new Set(opts.taskIds).size !== opts.taskIds.length) throw new Error('Release task IDs must be unique');
    if (opts.taskIds.some(id => !/^task-[a-z0-9-]+$/.test(id))) throw new Error('Release scope requires valid task IDs');
  }
  const taskDirs = opts.taskIds ?? (existsSync(corpusDir)
    ? readdirSync(corpusDir).filter(d => d.startsWith('task-'))
    : []);

  const families: FamilyReport[] = [];

  for (const [agent, schema] of Object.entries(SCHEMAS)) {
    let total = 0, pass = 0, unparseable = 0;
    const signatures = new Map<string, { count: number; example: string }>();

    for (const dir of taskDirs) {
      const file = join(corpusDir, dir, `${agent}.json`);
      if (!existsSync(file)) continue;
      total++;
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(file, 'utf-8')); }
      catch { unparseable++; continue; } // Corrupt artifacts fail the gate below.
      const r = schema.safeParse(parsed);
      if (r.success) { pass++; continue; }
      const first = r.error.issues[0];
      const sig = `${first.path.join('.')} [${first.code}] ${first.message}`;
      const e = signatures.get(sig) ?? { count: 0, example: dir };
      e.count++;
      signatures.set(sig, e);
    }

    const failed = total - pass;
    const isRequired = required.has(agent);
    const accountedEmpty = accounted[agent];

    // The completeness rule. Only verified-empty can close a zero-artifact
    // required family. Withheld stays visible but cannot turn the gate green.
    const closesEmpty = accountedEmpty?.state === 'verified-empty'
      && Boolean(accountedEmpty.sourceUrl?.trim());
    const missing = isRequired && (total === 0 ? !closesEmpty : total < taskDirs.length);
    const status: 'PASS' | 'FAIL' = failed > 0 || missing ? 'FAIL' : 'PASS';

    families.push({
      agent, total, pass, unparseable, failed,
      required: isRequired, status,
      ...(missing ? { missing: true } : {}),
      ...(accountedEmpty ? { accountedEmpty } : {}),
      signatures: [...signatures].map(([sig, v]) => ({ sig, ...v })),
    });
  }

  return { families, ok: families.every(f => f.status === 'PASS') };
}

function main(): void {
  const report = validateCorpus();

  // Distinguish "no run to validate" from "a run dropped a required family".
  // Both fail, but only the second is a pipeline defect — see
  // docs/trials/2026-09-06/civiclens-completion-plan.md: artifacts must be
  // present, and the validator must run in the candidate worktree.
  const corpusEmpty = report.families.every(f => f.total === 0);
  if (corpusEmpty) {
    console.log(`no task-* artifacts under ${PIPE_DIR}`);
    console.log('nothing to validate — run the pipeline in THIS worktree first.');
    console.log('(an empty corpus is not a PASS: there is no evidence to check.)\n');
  }

  for (const f of report.families) {
    const req = f.required ? ' [required]' : '';
    if (f.missing) {
      if (f.accountedEmpty?.state === 'withheld') {
        console.log(`${f.status}  ${f.agent.padEnd(14)} 0 artifacts${req} — accounted withheld`);
        console.log('       formatting hold recorded; withheld is not a certification pass.');
        continue;
      }
      console.log(`${f.status}  ${f.agent.padEnd(14)} ${f.total} artifacts${req} — REQUIRED family missing from one or more tasks`);
      console.log(`       a required family with zero artifacts is an absence of evidence, not a pass.`);
      console.log(`       to pass, either produce the artifact or record a corroborated`);
      console.log(`       source-backed verified-empty result under the frozen protocol.`);
      continue;
    }
    if (f.accountedEmpty && f.total === 0) {
      console.log(`${f.status}  ${f.agent.padEnd(14)} 0 artifacts${req} — accounted ${f.accountedEmpty.state}`
        + (f.accountedEmpty.sourceUrl ? ` (${f.accountedEmpty.sourceUrl})` : ''));
      continue;
    }
    console.log(`${f.status}  ${f.agent.padEnd(14)} ${f.pass}/${f.total} valid (${f.unparseable} unparseable)${req}`);
    if (f.failed > 0) {
      let shown = 0;
      for (const { sig, count, example } of f.signatures) {
        if (shown++ >= MAX_SIGNATURES) { console.log(`       … ${f.signatures.length - MAX_SIGNATURES} more signatures`); break; }
        console.log(`       ×${String(count).padStart(4)}  ${sig}  (e.g. ${example})`);
      }
    }
  }

  process.exit(report.ok ? 0 : 1);
}

// Only run the CLI when executed directly, so importing this module for tests
// has no side effects.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
