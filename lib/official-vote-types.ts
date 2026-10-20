/**
 * Frozen shared wire types for the official-vote runtime (2026-10-16).
 *
 * Leader-authored interface between the pinned collector bridge
 * (lib/collector-bridge.ts + tools/congress-collector/bridge.py), the
 * per-member normalizer (skills/researcher/official-member-votes.ts), the
 * runtime glue (skills/researcher/official-vote-runtime.ts) and the consumers
 * (skills/researcher/fetch.ts, db/load-from-tasks.ts,
 * db/load-bill-summaries.ts). Spec:
 * docs/official-vote-runtime-integration-2026-10-16.md. Change only through the
 * leader; workers never redefine these shapes locally.
 */

import type {
  Chamber, NormalizedPosition, NonBillSubtype, ResolutionOutcome,
} from './vote-source.js';

// ─── Typed failure ──────────────────────────────────────────────────────────

export type OfficialVoteStage =
  | 'runtime' | 'discovery' | 'acquisition' | 'collector'
  | 'identity' | 'normalization' | 'coverage';

/**
 * Every official-vote failure is this error. It is thrown, never converted to
 * an empty vote list or a verified-empty result. `outcome` is always 'failed'.
 */
export class OfficialVoteFailure extends Error {
  readonly outcome = 'failed' as const;
  constructor(
    readonly stage: OfficialVoteStage,
    readonly code: string,
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(`official votes ${stage}/${code}: ${message}`);
    this.name = 'OfficialVoteFailure';
  }
}

// ─── Collector bridge wire format (Python bridge.py stdout) ─────────────────

export const BRIDGE_CONTRACT = 'civiclens.congress-collector-bridge';
export const BRIDGE_VERSION = 1;

/** One roll handed to the bridge. Body bytes are read from `path`. */
export interface BridgeRollInput {
  key: string;              // rollKey(); e.g. "119-2025/h2"
  chamber: Chamber;
  congress: number;
  session: 1 | 2;
  year: number;             // sessionYear(congress, session)
  roll: number;
  date: string;             // expected official date YYYY-MM-DD (from index/listing or legacy row)
  source_url: string;       // houseSourceUrl / senateSourceUrl
  path: string;             // absolute path of the retained raw XML body
  sha256: string;           // expected sha256 of that body
}

export type HouseTotals =
  | { kind: 'by_vote'; yea: number; nay: number; present: number; not_voting: number }
  | { kind: 'by_candidate'; candidates: Array<{ name: string; total: number }> };

/** stdlib ElementTree extraction from raw House XML (provenance/classifier input). */
export interface HouseRaw {
  chamber: 'house';
  congress: number;
  session: 1 | 2;
  roll: number;
  date: string;             // ISO from vote-metadata/action-date
  legis_num: string;        // trimmed
  vote_type: string;        // trimmed
  question: string;         // trimmed vote-question
  vote_desc: string;        // trimmed, '' allowed
  result: string;           // trimmed vote-result
  amendment_num: string | null;
  totals: HouseTotals;
  voters: Array<{ id: string; raw_position: string }>; // id = legislator/@name-id (bioguide); raw_position verbatim <vote> text
}

/** stdlib ElementTree extraction from raw Senate XML (provenance/classifier input). */
export interface SenateRaw {
  chamber: 'senate';
  congress: number;
  session: 1 | 2;
  roll: number;
  date: string;             // ISO from vote_date
  question: string;         // trimmed <question>
  vote_title: string;       // trimmed
  result: string;           // trimmed vote_result
  document: {
    document_congress: string;            // verbatim text, '' when empty element
    document_type: string;
    document_number: string;
    document_name: string;
    amendment_number: string;
    amendment_to_document_number: string;
  };
  /** Every document in a multi-nomination bundle; single `document` is its first projection. */
  documents?: SenateRaw['document'][];
  count: { yeas: number; nays: number; present: number; absent: number }; // empty element → 0
  tie_breaker: { by_whom: string; vote: string };
  voters: Array<{ id: string; raw_position: string }>; // id = lis_member_id; raw_position verbatim <vote_cast>
}

export type BridgeFailureOutcome =
  | 'malformed_source' | 'unsupported_record' | 'incomplete_fetch' | 'ambiguity';

export interface BridgeRollOk {
  key: string;
  ok: true;
  raw: HouseRaw | SenateRaw;
  /** Pinned unitedstates/congress vote dict after parse_house_vote/parse_senate_vote, minus updated_at. */
  collector: Record<string, unknown>;
}

export interface BridgeRollFail {
  key: string;
  ok: false;
  outcome: BridgeFailureOutcome;
  reason: string;
}

export interface BridgeRun {
  bridge: typeof BRIDGE_CONTRACT;
  bridge_version: typeof BRIDGE_VERSION;
  collector: { repository: string; commit: string; vendor_manifest_sha256: string };
  runtime: { python: string; lock_sha256: string; packages: Record<string, string> };
  network: { interfaces: string[] };          // from /proc/self/net/dev; must be ['lo'] or []
  inference_disabled: string[];               // utils attributes replaced with raising guards
  results: Array<BridgeRollOk | BridgeRollFail>;
}

// ─── Window acquisition run (Python acquire_window.py output) ───────────────

export const WINDOW_RUN_CONTRACT = 'civiclens.official-vote-window-run';
export const WINDOW_RUN_VERSION = 1;

export interface WindowRun {
  contract: typeof WINDOW_RUN_CONTRACT;
  contract_version: typeof WINDOW_RUN_VERSION;
  chamber: Chamber;
  mode: 'window' | 'rolls';
  as_of: string | null;                 // window mode only
  window: [string, string] | null;      // window mode only
  months: number | null;                // 48 in window mode
  status: 'complete' | 'incomplete' | 'failed';
  reason: string | null;
  started_at: string;
  finished_at: string;
  discovery: {
    inventory_path: string | null;       // relative to run dir
    inventory_sha256: string | null;
    index_pages_verified: number;
  };
  manifest_path: string;                 // relative to run dir; acquisition manifest (§6 shape)
  manifest_sha256: string;
}

// ─── Normalized member votes (researcher artifact vote rows) ────────────────

export interface OfficialVoteResolution {
  outcome: ResolutionOutcome;
  billId: string | null;              // `${congress}-${type}-${number}` iff outcome === 'resolved_bill'
  subtype: NonBillSubtype | null;     // iff outcome === 'authoritative_non_bill'
  amendment: string | null;           // resolved_bill only; else null
  reason: string | null;              // non-null iff outcome is not resolved_bill/authoritative_non_bill
}

/** One persisted researcher vote row from the official path. */
export interface OfficialVoteRecord {
  billTitle: string;
  vote: NormalizedPosition;
  rawPosition: string;
  date: string;
  source: 'clerk.house.gov' | 'senate.gov';
  sourceUrl: string;
  sourceSha256: string;
  confidence: 1;
  rollKey: string;
  chamber: Chamber;
  congress: number;
  session: 1 | 2;
  roll: number;
  question: string;
  resolution: OfficialVoteResolution;
}

export interface VoteCoverage {
  outcome: 'ok';
  source: 'official';
  chamber: Chamber;
  bioguideId: string;
  asOf: string;
  window: { start: string; end: string; months: number };
  requiredRolls: number;
  analyzedRolls: number;
  inServiceRolls: number;
  recorded: number;
  notRecorded: number;
  notRecordedKeys: string[];
  acquisition: { runDir: string; manifestSha256: string; inventorySha256: string | null };
  collector: { commit: string; lockSha256: string; vendorManifestSha256: string };
  identity: { commit: string; snapshotSha256: string; floor: string };
}

export interface OfficialMemberVotes {
  votes: OfficialVoteRecord[];
  coverage: VoteCoverage;
}

// ─── Runtime entry points (implemented in skills/researcher/official-vote-runtime.ts) ──

export type OfficialSourceMode =
  | { mode: 'live'; runsRoot?: string }
  | { mode: 'prepared'; runDir: string };

export interface FetchOfficialMemberVotesOptions {
  bioguideId: string;
  chamber: Chamber;
  asOf: string;                        // YYYY-MM-DD
  source: OfficialSourceMode;
}

export interface LegacyRollRequest {
  key: string;                         // legacy stored roll key, validated with parseRollKey
  date: string;                        // stored vote date; must equal the official date
}

export type LegacyRollResolution =
  | { key: string; ok: true; date: string; sourceUrl: string; resolution: OfficialVoteResolution }
  | { key: string; ok: false; failure: { stage: OfficialVoteStage; code: string; message: string } };

export interface ResolveOfficialRollsOptions {
  source: { mode: 'live'; runsRoot?: string } | { mode: 'prepared'; runDir: string };
}
