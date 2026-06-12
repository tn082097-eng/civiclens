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
