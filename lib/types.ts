// Shared types across all CivicLens pipeline agents

export type AgentName =
  | 'researcher'
  | 'data-checker'
  | 'predictor'
  | 'connection-mapper'
  | 'trade-analyst'
  | 'summarizer'
  | 'code-checker'
  | 'final-reviewer';

export type AgentStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped';

export type PipelineStatus =
  | 'initializing'
  | 'researching'
  | 'validating'
  | 'predicting'
  | 'connecting'
  | 'analyzing-trades'
  | 'summarizing'
  | 'reviewing-code'
  | 'final-review'
  | 'complete'
  | 'failed';

export interface AgentResult {
  status: AgentStatus;
  startedAt?: string;
  completedAt?: string;
  output?: unknown;
  error?: string;
  retries: number;
}

export interface PipelineTask {
  taskId: string;
  createdAt: string;
  updatedAt: string;
  status: PipelineStatus;
  target: {
    type: 'politician' | 'donor' | 'organization' | 'pac';
    name: string;
    id?: string;
  };
  agents: Record<AgentName, AgentResult>;
}

// Researcher output schema
export interface ResearcherOutput {
  source: 'stub' | 'congress.gov' | 'fec.gov' | 'govtrack' | 'ballotpedia';
  fetchedAt: string;
  target: { name: string; type: string };
  data: PoliticianData;
  confidence: number;
  warnings: string[];
}

export interface PoliticianData {
  id: string;
  name: string;
  party: 'Democrat' | 'Republican' | 'Independent';
  state: string;
  chamber: 'senate' | 'house' | 'executive' | 'cabinet' | 'governor' | 'state';
  role: string;
  bio: string;
  inOffice: boolean;
  bills: BillData[];
  votes: VoteData[];
  donors: DonorData[];
  controversies: ControversyData[];
  connections: ConnectionData[];
}

export interface BillData {
  title: string;
  summary: string;
  status: 'introduced' | 'passed' | 'failed' | 'signed';
  introducedAt: string;
  source: string;
  sourceUrl?: string;
  confidence: number;
}

export interface VoteData {
  billTitle: string;
  vote: 'yea' | 'nay' | 'abstain' | 'absent';
  date: string;
  source: string;
  sourceUrl?: string;
  confidence: number;
}

export interface DonorData {
  name: string;
  type: 'individual' | 'pac' | 'corporation';
  amount: number;
  date: string;
  source: string;
  sourceUrl?: string;
  confidence: number;
}

export interface ControversyData {
  title: string;
  description: string;
  date: string;
  source: string;
  confidence: number;
  flagged: boolean;
}

export interface ConnectionData {
  targetId: string;
  targetName: string;
  targetType: 'politician' | 'donor' | 'organization' | 'pac';
  relationshipType: string;
  strength: number;
}

// Super PAC independent expenditures (FEC Schedule E + A)
export type SupportOppose = 'S' | 'O';

export interface SuperPacIE {
  committeeId: string;
  committeeName: string;
  committeeType: string | null;       // e.g. "PAC - Nonqualified", "Independent Expenditure-Only"
  designation: string | null;         // e.g. "Leadership PAC"
  party: string | null;               // "DEM" | "REP" | "IND" | "NON" | null
  cycle: number;
  supportOppose: SupportOppose;       // 'S' = supporting candidate, 'O' = opposing
  totalAmount: number;
  count: number;                      // number of itemized filings aggregated
}

export interface IEFiling {
  committeeId: string;
  committeeName: string;
  candidateId: string;
  supportOppose: SupportOppose;
  amount: number;
  expenditureDate: string | null;
  disbursementDate: string | null;
  description: string | null;
  payeeName: string | null;
  pdfUrl: string | null;
  reportYear: number | null;
  electionType: string | null;        // e.g. "P2022", "G2024"
  transactionId: string;
}

export interface SuperPacFunder {
  contributorName: string;
  contributorEmployer: string | null;
  contributorOccupation: string | null;
  contributorState: string | null;
  entityType: string | null;
  amount: number;
  date: string | null;
  isPassthrough: boolean;             // true for ActBlue/WinRed conduit aggregates
}

export interface SuperPacIEReport {
  candidateId: string;
  cycle: number;
  fetchedAt: string;
  supporting: SuperPacIE[];           // sorted by totalAmount desc
  opposing: SuperPacIE[];             // sorted by totalAmount desc
  totalSupporting: number;
  totalOpposing: number;
  filings?: IEFiling[];               // populated when itemized=true
  topFunders?: Record<string, SuperPacFunder[]>; // committeeId -> top donors
}

// Data Checker output
export interface ValidationReport {
  passed: boolean;
  score: number; // 0–1
  issues: ValidationIssue[];
  summary: string;
}

export interface ValidationIssue {
  field: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
}

// Summarizer output
export interface SummaryOutput {
  headline: string;
  bio: string;
  keyFacts: string[];
  neutralNarrative: string;
  dataQualityNote: string;
}

// Code Checker output
export interface CodeReviewOutput {
  approved: boolean;
  issues: CodeIssue[];
  suggestions: string[];
}

export interface CodeIssue {
  file: string;
  line?: number;
  severity: 'blocking' | 'warning' | 'suggestion';
  message: string;
}

// Final Reviewer output
export interface FinalReviewOutput {
  approved: boolean;
  committable: boolean;
  notes: string[];
  checklist: Record<string, boolean>;
}
