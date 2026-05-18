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
  confidence: z.number().min(0).max(1),
  warnings:   z.array(z.string()),
});

// CLI: validate a JSON file
// Usage: npx tsx ~/.hermes/civiclens/lib/schemas.ts <path-to-json>
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
