import type { PipelineTask } from '../lib/types.js';
import {
  ok, warn, spin,
  writePipe, markAgent, llm,
} from './shared.js';
import { getDb } from '../db/init.js';

export type RevolvingRiskLevel = 'none' | 'low' | 'medium' | 'high';
export type MatchType = 'direct' | 'committee';

export interface RevolvingDoorConnection {
  lobbyistId:        number;
  lobbyistName:      string;
  formerRole:        string;          // raw covered_position excerpt
  currentEmployer:   string | null;   // registrant_name
  latestClient:      string | null;
  latestFilingYear:  number;
  latestFilingPeriod: string | null;
  generalIssues:     string | null;
  governmentEntities: string | null;
  matchType:         MatchType;
  riskLevel:         RevolvingRiskLevel;
  filingUrl:         string | null;
}

export interface RevolvingDoorOutput {
  taskId:                string;
  analyzedAt:            string;
  hasData:               boolean;
  riskLevel:             RevolvingRiskLevel;
  highRiskCount:         number;
  totalConnections:      number;
  directMatches:         RevolvingDoorConnection[];
  committeeMatches:      RevolvingDoorConnection[];
  revolvingDoorNarrative: string;
}

// Risk model: filing recency is the proxy. The LDA API doesn't expose a
// "left government" date, so we infer "currently active in lobbying" from
// the lobbyist's most recent filing year. This answers a slightly different
// question than the original spec ("recently left gov?") but it's what the
// data can support without fabricating dates.
function computeRiskLevel(latestFilingYear: number): RevolvingRiskLevel {
  const now = new Date().getUTCFullYear();
  const yearsAgo = now - latestFilingYear;
  if (yearsAgo <= 1) return 'high';
  if (yearsAgo <= 3) return 'medium';
  return 'low';
}

// Aggregate per-member risk: any high-risk direct connection makes the
// member high-risk. Committee-only matches are weaker signals; cap them
// at medium even when filed recently.
function aggregateRisk(direct: RevolvingDoorConnection[], committee: RevolvingDoorConnection[]): RevolvingRiskLevel {
  if (direct.length === 0 && committee.length === 0) return 'none';
  if (direct.some(c => c.riskLevel === 'high')) return 'high';
  if (direct.some(c => c.riskLevel === 'medium')) return 'medium';
  if (committee.some(c => c.riskLevel === 'high' || c.riskLevel === 'medium')) return 'medium';
  return 'low';
}

// Extract last name from a "First Middle Last" or "First Last" string.
// LDA covered_position strings reference members by last name + chamber title
// (e.g. "Rep. Pelosi", "Sen. Warren"), so the last token is what we need.
function extractLastName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  // Skip suffixes: "John Smith Jr." → "Smith"
  const last = parts[parts.length - 1].replace(/[.,]/g, '');
  if (/^(JR|SR|II|III|IV|ESQ|PHD|MD)$/i.test(last) && parts.length >= 2) {
    return parts[parts.length - 2].replace(/[.,]/g, '');
  }
  return last;
}

// Build the regex used to match covered_position strings. We require a
// chamber title before the last name — last-name-alone matches generate
// far too many false positives ("Pelosi" hits anyone with that surname).
function buildDirectMatchPattern(memberName: string, chamber: string | null): string {
  const last = extractLastName(memberName);
  if (!last) return '';
  // Match "Rep. Pelosi", "Rep. Nancy Pelosi", "Sen. Warren", "Senator Elizabeth Warren",
  // "Congressman Smith", "Congresswoman Frederica S. Wilson". The middle group
  // `(?:[A-Z][\w\.\-]*\s+){0,3}` allows up to three first/middle/initial tokens
  // between the title and the last name (e.g. "Frederica S. Wilson" has two).
  // Chamber-aware: senate members never appear as "Rep." in honest filings.
  const titles = chamber === 'senate'
    ? ['Sen\\.?', 'Senator']
    : chamber === 'house'
      ? ['Rep\\.?', 'Congressman', 'Congresswoman']
      : ['Sen\\.?', 'Senator', 'Rep\\.?', 'Congressman', 'Congresswoman'];
  // (?i) flag goes inline at start. Note: DuckDB regex is RE2-compatible.
  return `(?i)(${titles.join('|')})\\s+([A-Z][\\w\\.\\-]*\\s+){0,3}${last}\\b`;
}

// Committee matching is a second pass. We look for the member's committee
// names appearing in covered_position. This catches ex-staff who worked
// for the committee directly rather than for the member personally.
async function findCommitteeMatches(
  db: any,
  memberId: string,
): Promise<RevolvingDoorConnection[]> {
  // Pull this member's committees. The LDA strings use abbreviations like
  // "Senate Commerce Cmte" or "House Science Cmte" — we'll do an ILIKE
  // on the most distinctive word in the committee name (skipping generic
  // tokens like "Committee", "Subcommittee").
  const cR = await db.run(
    `SELECT DISTINCT committee_name FROM committees WHERE member_id = ?`,
    [memberId],
  );
  const committees = (await cR.getRowObjects() as any[])
    .map(r => String(r.committee_name ?? ''))
    .filter(Boolean);
  if (committees.length === 0) return [];

  // Extract a distinctive keyword per committee (e.g., "Commerce" from
  // "Senate Committee on Commerce, Science, and Transportation").
  const keywords = new Set<string>();
  const STOP = new Set(['committee', 'subcommittee', 'on', 'and', 'the', 'of', 'house', 'senate', 'select', 'joint']);
  for (const cn of committees) {
    for (const tok of cn.split(/[\s,]+/)) {
      const w = tok.toLowerCase().replace(/[^a-z]/g, '');
      if (w.length >= 5 && !STOP.has(w)) keywords.add(w);
    }
  }
  if (keywords.size === 0) return [];

  // Build an OR of ILIKE clauses. Cap at 8 keywords to keep the query fast.
  const keywordList = [...keywords].slice(0, 8);
  const placeholders = keywordList.map(() => 'l.covered_position ILIKE ?').join(' OR ');
  const params = keywordList.map(k => `%${k}%`);

  const r = await db.run(
    `SELECT
       l.lobbyist_id,
       ANY_VALUE(l.full_name)            AS full_name,
       ANY_VALUE(l.covered_position)     AS covered_position,
       ANY_VALUE(l.general_issues)       AS general_issues,
       ANY_VALUE(l.government_entities)  AS government_entities,
       MAX(f.filing_year)                AS latest_year,
       ANY_VALUE(f.filing_period)        AS latest_period,
       ANY_VALUE(f.registrant_name)      AS registrant_name,
       ANY_VALUE(f.client_name)          AS client_name,
       ANY_VALUE(f.source_url)           AS source_url
     FROM lda_lobbyists l
     JOIN lda_filings f USING (filing_uuid)
     WHERE (${placeholders})
       AND l.covered_position ILIKE '%cmte%'  -- distinguish committee staff from member staff
     GROUP BY l.lobbyist_id
     ORDER BY latest_year DESC
     LIMIT 25`,
    params,
  );
  const rows = await r.getRowObjects() as any[];
  return rows.map((row: any): RevolvingDoorConnection => ({
    lobbyistId:         Number(row.lobbyist_id),
    lobbyistName:       String(row.full_name ?? ''),
    formerRole:         String(row.covered_position ?? ''),
    currentEmployer:    row.registrant_name ? String(row.registrant_name) : null,
    latestClient:       row.client_name ? String(row.client_name) : null,
    latestFilingYear:   Number(row.latest_year),
    latestFilingPeriod: row.latest_period ? String(row.latest_period) : null,
    generalIssues:      row.general_issues ? String(row.general_issues) : null,
    governmentEntities: row.government_entities ? String(row.government_entities) : null,
    matchType:          'committee',
    riskLevel:          computeRiskLevel(Number(row.latest_year)),
    filingUrl:          row.source_url ? String(row.source_url) : null,
  }));
}

function connectionsToText(conns: RevolvingDoorConnection[]): string {
  return conns.map((c, i) => {
    const role = c.formerRole.length > 160 ? c.formerRole.slice(0, 157) + '…' : c.formerRole;
    const client = c.latestClient ? `, currently lobbying for ${c.latestClient}` : '';
    const employer = c.currentEmployer ? ` at ${c.currentEmployer}` : '';
    const issues = c.generalIssues ? ` on ${c.generalIssues}` : '';
    const recency = `last filed ${c.latestFilingYear}${c.latestFilingPeriod ? ` (${c.latestFilingPeriod})` : ''}`;
    return `${i + 1}. ${c.lobbyistName} — former: "${role}"${employer}${client}${issues}; ${recency} [${c.matchType} match, ${c.riskLevel}]`;
  }).join('\n');
}

function writeEmpty(task: PipelineTask, riskLevel: RevolvingRiskLevel = 'none'): void {
  const output: RevolvingDoorOutput = {
    taskId:                 task.taskId,
    analyzedAt:             new Date().toISOString(),
    hasData:                false,
    riskLevel,
    highRiskCount:          0,
    totalConnections:       0,
    directMatches:          [],
    committeeMatches:       [],
    revolvingDoorNarrative: 'N/A',
  };
  writePipe(task.taskId, 'revolving-door', output);
  markAgent(task, 'revolving-door', 'complete', { riskLevel, connections: 0 });
}

export async function runRevolvingDoor(task: PipelineTask): Promise<boolean> {
  markAgent(task, 'revolving-door', 'running');

  // Pin Sonnet by default — narrative requires careful handling of free-text
  // covered_position strings, where weaker models tend to hallucinate dates
  // or invent member→staff relationships. Override with LLM_REVOLVING_MODEL.
  const REVOLVING_MODEL = process.env.LLM_REVOLVING_MODEL ?? 'claude-sonnet-4-6';
  const memberName = task.target.name;

  // ── 1. Resolve member_id + chamber ───────────────────────────────────────
  let memberId: string | null = null;
  let chamber: string | null = null;
  let db: Awaited<ReturnType<typeof getDb>>;
  try {
    db = await getDb();
    const slug = memberName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const r = await db.run(
      `SELECT member_id, chamber FROM members
       WHERE member_id = ? OR LOWER(name) = LOWER(?) LIMIT 1`,
      [slug, memberName],
    );
    const rows = await r.getRowObjects() as any[];
    memberId = rows[0]?.member_id ?? null;
    chamber  = rows[0]?.chamber ? String(rows[0].chamber) : null;
  } catch (e: any) {
    warn('Revolving Door', `DB lookup failed: ${e.message}`);
    writeEmpty(task);
    return true;
  }

  if (!memberId) {
    warn('Revolving Door', `member not in DB yet — skipping`);
    writeEmpty(task);
    return true;
  }

  // ── 2. Check the LDA tables exist (graceful degrade if not yet ingested) ─
  try {
    await db!.run(`SELECT 1 FROM lda_lobbyists LIMIT 1`);
  } catch (e: any) {
    warn('Revolving Door', `LDA tables missing — run db/load-lda.ts first`);
    writeEmpty(task);
    return true;
  }

  // ── 3. Direct matches: covered_position names this specific member ──────
  let directMatches: RevolvingDoorConnection[] = [];
  const pattern = buildDirectMatchPattern(memberName, chamber);
  if (pattern) {
    try {
      const r = await db!.run(
        `SELECT
           l.lobbyist_id,
           ANY_VALUE(l.full_name)            AS full_name,
           ANY_VALUE(l.covered_position)     AS covered_position,
           ANY_VALUE(l.general_issues)       AS general_issues,
           ANY_VALUE(l.government_entities)  AS government_entities,
           MAX(f.filing_year)                AS latest_year,
           ANY_VALUE(f.filing_period)        AS latest_period,
           ANY_VALUE(f.registrant_name)      AS registrant_name,
           ANY_VALUE(f.client_name)          AS client_name,
           ANY_VALUE(f.source_url)           AS source_url
         FROM lda_lobbyists l
         JOIN lda_filings f USING (filing_uuid)
         WHERE regexp_matches(l.covered_position, ?)
         GROUP BY l.lobbyist_id
         ORDER BY latest_year DESC
         LIMIT 50`,
        [pattern],
      );
      const rows = await r.getRowObjects() as any[];
      directMatches = rows.map((row: any): RevolvingDoorConnection => ({
        lobbyistId:         Number(row.lobbyist_id),
        lobbyistName:       String(row.full_name ?? ''),
        formerRole:         String(row.covered_position ?? ''),
        currentEmployer:    row.registrant_name ? String(row.registrant_name) : null,
        latestClient:       row.client_name ? String(row.client_name) : null,
        latestFilingYear:   Number(row.latest_year),
        latestFilingPeriod: row.latest_period ? String(row.latest_period) : null,
        generalIssues:      row.general_issues ? String(row.general_issues) : null,
        governmentEntities: row.government_entities ? String(row.government_entities) : null,
        matchType:          'direct',
        riskLevel:          computeRiskLevel(Number(row.latest_year)),
        filingUrl:          row.source_url ? String(row.source_url) : null,
      }));
    } catch (e: any) {
      warn('Revolving Door', `direct-match query failed: ${e.message}`);
    }
  }

  // ── 4. Committee matches: ex-staff of the member's committees ───────────
  let committeeMatches: RevolvingDoorConnection[] = [];
  try {
    committeeMatches = await findCommitteeMatches(db!, memberId);
    // De-dup against direct matches (direct wins)
    const directIds = new Set(directMatches.map(c => c.lobbyistId));
    committeeMatches = committeeMatches.filter(c => !directIds.has(c.lobbyistId));
  } catch (e: any) {
    warn('Revolving Door', `committee-match query failed: ${e.message}`);
  }

  const totalConnections = directMatches.length + committeeMatches.length;
  if (totalConnections === 0) {
    writeEmpty(task);
    ok('Revolving Door', 'no LDA matches — N/A');
    return true;
  }

  // ── 5. Aggregate risk + counts ──────────────────────────────────────────
  const riskLevel     = aggregateRisk(directMatches, committeeMatches);
  const highRiskCount = [...directMatches, ...committeeMatches].filter(c => c.riskLevel === 'high').length;

  // ── 6. LLM narrative ────────────────────────────────────────────────────
  spin('Revolving Door', `generating ${riskLevel} narrative via ${REVOLVING_MODEL}…`);

  const systemPrompt = `You are a sharp, neutral political-transparency analyst specializing in revolving-door patterns between Congress and the lobbying industry.

You are given:
- A list of registered lobbyists whose disclosed former roles connect them to a specific U.S. member of Congress (either as direct ex-staff or as committee staff)
- For each: the raw covered-position text, current employer, current client, lobbying issues, and most recent filing year

Your job is to write a single, cohesive analytical paragraph (3–5 sentences) that surfaces the most important patterns.

**Core Rules:**
- State facts directly from the data. Never speculate about intent, ethics, or legality.
- Lead with the strongest signals: ex-direct-staff over ex-committee-staff; recent filings over old ones.
- Use precise language: "former Chief of Staff", "ex-Legislative Director", "previously served on Senate Commerce Committee staff".
- When multiple lobbyists trace back to the same member, group them by current employer or issue area.
- Reference specific clients/issues only if they're named in the data.
- Never invent dates. The data has filing years, not departure years — phrase things as "last filed in 2025" or "currently active in 2024 filings", not "left office in 2022".

**Output Format:**
Write exactly one paragraph of 3–5 sentences. No bullet points. No moralizing. No closing summary.`;

  const directText    = directMatches.length    ? `Direct ex-staff matches (${directMatches.length}):\n${connectionsToText(directMatches.slice(0, 10))}` : '';
  const committeeText = committeeMatches.length ? `\n\nCommittee-staff matches (${committeeMatches.length}):\n${connectionsToText(committeeMatches.slice(0, 10))}` : '';

  const userPrompt = `**Member:** ${memberName}${chamber ? ` (${chamber})` : ''}

${directText}${committeeText}

Write the analytical paragraph now.`;

  let revolvingDoorNarrative: string;
  try {
    revolvingDoorNarrative = await llm(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      { maxTokens: 600, timeoutMs: 120_000, model: REVOLVING_MODEL },
    );
    process.stdout.write('\n');
  } catch (e: any) {
    process.stdout.write('\n');
    warn('Revolving Door', `LLM failed: ${e.message} — writing without narrative`);
    revolvingDoorNarrative = 'N/A';
  }

  // ── 7. Write output ─────────────────────────────────────────────────────
  const output: RevolvingDoorOutput = {
    taskId:                 task.taskId,
    analyzedAt:             new Date().toISOString(),
    hasData:                true,
    riskLevel,
    highRiskCount,
    totalConnections,
    directMatches,
    committeeMatches,
    revolvingDoorNarrative,
  };

  writePipe(task.taskId, 'revolving-door', output);
  markAgent(task, 'revolving-door', 'complete', {
    riskLevel,
    connections: totalConnections,
    highRisk: highRiskCount,
  });
  ok('Revolving Door', `${directMatches.length} direct + ${committeeMatches.length} committee → ${riskLevel} risk`);
  return true;
}
