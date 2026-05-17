/**
 * Pattern Discovery v2 — detector contract.
 *
 * A detector finds one named pattern in the corpus and returns hits that the
 * reader can verify by clicking through to the underlying rows. Editorial
 * spine (civiclens-core): `finding` is ONE neutral sentence — counts and dates,
 * no moralizing words. `intensity` drives visual weight only, never color affect.
 * Every hit MUST cite real rows; a detector with no substrate returns [].
 */

export type CitedRowKind = 'trade' | 'vote' | 'bill' | 'donor' | 'contract' | 'ie';

export interface CitedRow {
  kind: CitedRowKind;
  id: string; // row id within its source table
  label: string; // short human label for the row
}

export interface PatternHit {
  pattern: string; // detector name, e.g. "trade-vote-alignment"
  member: string; // member slug (member_id), e.g. "marjorie-taylor-greene"
  finding: string; // ONE neutral sentence. No moralizing words.
  intensity: number; // 0..1, visual weight only
  citing: CitedRow[]; // rows the reader can click through
  dates: string[]; // ISO dates relevant to the hit
  detectedAt: string; // ISO timestamp of detection
}

export interface PatternDetector {
  name: string;
  description: string;
  detect(memberSlug: string): Promise<PatternHit[]>;
}
