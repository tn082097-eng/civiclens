/**
 * Zod validation schemas for pipeline data.
 * Used by the Data Checker agent.
 */

import { z } from 'zod';

export const BillSchema = z.object({
  title:        z.string().min(3),
  summary:      z.string().min(20),
  status:       z.enum(['introduced', 'passed', 'failed', 'signed', 'vetoed']),
  introducedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source:       z.string().url().or(z.string().min(3)),
  sourceUrl:    z.string().url().optional(),
  confidence:   z.number().min(0).max(1),
});

export const VoteSchema = z.object({
  billTitle:  z.string().min(3),
  vote:       z.enum(['yea', 'nay', 'abstain', 'absent']),
  date:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source:     z.string().min(3),
  sourceUrl:  z.string().url().optional(),
  confidence: z.number().min(0).max(1),
});

export const DonorSchema = z.object({
  name:       z.string().min(2),
  type:       z.enum(['individual', 'pac', 'corporation']),
  amount:     z.number().positive(),
  date:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source:     z.string().min(3),
  sourceUrl:  z.string().url().optional(),
  confidence: z.number().min(0).max(1),
});

export const ControversySchema = z.object({
  title:       z.string().min(5),
  description: z.string().min(30),
  date:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source:      z.string().min(3),
  confidence:  z.number().min(0).max(1),
  flagged:     z.boolean(),
});

export const ConnectionSchema = z.object({
  targetId:         z.string().min(1),
  targetName:       z.string().min(1),
  targetType:       z.enum(['politician', 'donor', 'organization', 'pac']),
  relationshipType: z.string().min(2),
  strength:         z.number().min(0).max(1),
});

export const CommitteeSchema = z.object({
  name:           z.string().min(3),
  code:           z.string().min(3),
  chamber:        z.enum(['senate', 'house', 'joint']),
  role:           z.enum(['Chair', 'Ranking Member', 'Member']),
  isSubcommittee: z.boolean(),
  parentCode:     z.string().nullable(),
  sourceUrl:      z.string().min(3),
});

export const UpcomingMeetingSchema = z.object({
  eventId:    z.string().min(1),
  date:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal('')),
  title:      z.string().min(3),
  type:       z.enum(['Hearing', 'Markup', 'Meeting', 'Other']),
  status:     z.string(),
  committees: z.array(z.object({
    name: z.string(),
    code: z.string(),
  })),
  sourceUrl:  z.string().min(3),
});

export const PoliticianDataSchema = z.object({
  id:            z.string().min(1),
  name:          z.string().min(2),
  party:         z.enum(['Democrat', 'Republican', 'Independent']),
  state:         z.string().min(2).max(2),
  chamber:       z.enum(['senate', 'house', 'executive', 'cabinet', 'governor', 'state']),
  role:          z.string().min(2),
  bio:           z.string().min(50),
  inOffice:      z.boolean(),
  bills:         z.array(BillSchema),
  votes:         z.array(VoteSchema),
  donors:        z.array(DonorSchema),
  controversies:    z.array(ControversySchema),
  connections:      z.array(ConnectionSchema),
  committees:       z.array(CommitteeSchema).optional().default([]),
  upcomingMeetings: z.array(UpcomingMeetingSchema).optional().default([]),
});

export const ResearcherOutputSchema = z.object({
  source:     z.enum(['stub', 'congress.gov', 'fec.gov', 'govtrack', 'ballotpedia']),
  fetchedAt:  z.string().datetime(),
  target:     z.object({ name: z.string(), type: z.string() }),
  data:       PoliticianDataSchema,
  // No top-level confidence: it was a hardcoded constant, not a measurement.
  // Tolerated on old artifacts for back-compat.
  confidence: z.number().min(0).max(1).optional(),
  warnings:   z.array(z.string()),
});

// ─── Loose researcher read schema (PR 2 scope decision 7) ───────────────────
// ResearcherOutputSchema above is the Data Checker's QUALITY GATE and must
// not be loosened. But 14/184 historical researcher.json artifacts (104 bill
// items) violate its bills[].summary min-20 constraint — they predate the
// Data Checker's summary auto-correction (the corpus probe found no other
// violation). The DB loader reads those historical artifacts, so its
// read-validation uses this variant: identical except that one constraint.
export const ResearcherArtifactSchema = ResearcherOutputSchema.extend({
  data: PoliticianDataSchema.extend({
    bills: z.array(BillSchema.extend({
      summary: z.string(), // no .min(20) — observed in corpus 2026-06-12
    })),
  }),
});

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
  // 1/124 historical artifact predates fact-grounding — observed in corpus
  unverifiedFacts:      z.array(z.string()).optional(),
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
  // 62/65 historical artifacts predate the narrativeSource field — observed in corpus
  narrativeSource:          z.enum(['deterministic', 'llm', 'none']).optional(),
  topFindings:              z.array(TradeFindingSchema),
  totalSuspiciousTrades:    z.number(),
  // 1/65 historical artifact predates the discretionary-trade fields — observed in corpus
  allDiscretionaryTrades:   z.array(TradeTickerSummarySchema).optional(),
  totalDiscretionaryTrades: z.number().optional(),
});

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

export const ReceiptBandSchema = z.enum(['insufficient-data', 'low-power', 'ranked']);

export const ThemeGapReceiptSchema = z.object({
  theme:          z.string(),
  tradeFilingId:  z.string(),
  ticker:         z.string(),
  txType:         z.string(),
  txDate:         z.string(),
  voteId:         z.string(),
  voteDate:       z.string(),
  billId:         z.string(),
  billTitle:      z.string(),
  daysBeforeVote: z.number().int().nonnegative(),
  pPair:          z.number().min(0).max(1).nullable(), // null in insufficient-data band
  tradeSourceUrl: z.string(),
  voteSourceUrl:  z.string(),
  billSourceUrl:  z.string(),
});

export const ThemeGapReceiptsSchema = z.object({
  memberId:            z.string(),
  tradeCount:          z.number().int().nonnegative(),          // theme-mappable trades = band denominator + null population
  disclosedTradeCount: z.number().int().nonnegative(),          // raw PTR rows, for the coverage strip's "N disclosed"
  band:                ReceiptBandSchema,
  nPerm:               z.number().int().positive(),
  windowDays:          z.number().int().positive(),
  coverage:            z.object({
    votesTotal:      z.number().int().nonnegative(),
    votesBillLinked: z.number().int().nonnegative(),
  }),
  receipts: z.array(ThemeGapReceiptSchema), // ranked band: sorted by pPair asc; others: chronological
});
export type ThemeGapReceipts = z.infer<typeof ThemeGapReceiptsSchema>;

// CLI: validate a JSON file
// Usage: npx tsx ~/Developer/civiclens/lib/schemas.ts <path-to-json>
const _isMain = !!process.argv[1]?.match(/schemas\.[jt]s$/);
if (_isMain && process.argv[2]) {
  const { readFileSync } = await import('fs');
  const raw = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
  const result = ResearcherOutputSchema.safeParse(raw);
  if (result.success) {
    console.log('✓ Validation passed');
  } else {
    console.error('✗ Validation failed:');
    for (const issue of result.error.issues) {
      console.error(`  [${issue.code}] ${issue.path.join('.')} — ${issue.message}`);
    }
    process.exit(1);
  }
}
