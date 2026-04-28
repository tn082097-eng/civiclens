// Shared types across all CivicLens pipeline agents

export type AgentName =
  | 'brain'
  | 'researcher'
  | 'data-checker'
  | 'predictor'
  | 'connection-mapper'
  | 'trade-analyst'
  | 'summarizer'
  | 'coder'
  | 'code-checker'
  | 'visualizer'
  | 'final-reviewer'
  | 'publisher';

export type AgentStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped';

export type PipelineStatus =
  | 'initializing'
  | 'researching'
  | 'validating'
  | 'predicting'
  | 'connecting'
  | 'analyzing-trades'
  | 'summarizing'
  | 'coding'
  | 'reviewing-code'
  | 'visualizing'
  | 'final-review'
  | 'publishing'
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
  brainLog: BrainLogEntry[];
}

export interface BrainLogEntry {
  timestamp: string;
  decision: string;
  reasoning: string;
  nextStep?: AgentName;
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
