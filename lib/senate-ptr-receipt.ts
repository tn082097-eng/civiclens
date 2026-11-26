import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

export const SENATE_PTR_SEARCH_SOURCE =
  'https://efdsearch.senate.gov/search/report/data/';

/**
 * EFDS search is a first/last-name query. A query that misses the filer's
 * recorded name (legal name vs nickname, a middle initial) returns zero rows
 * exactly like a senator with no PTRs, so a zero-result search is not
 * identity-matched evidence and can never certify verified-empty. Receipts
 * therefore record only nonempty filing inventories, and an empty receipt on
 * disk (written before this rule) is rejected rather than read as evidence.
 */
export const EMPTY_SEARCH_NOT_EVIDENCE =
  'a zero-result EFDS name search cannot certify zero Senate PTR filings';

export interface SenateSearchReceipt {
  schemaVersion: 1;
  kind: 'senate-ptr-search';
  status: 'success';
  bioguideId: string;
  canonicalName: string;
  fromYear: number;
  toYear: number;
  filingIds: string[];
  filingCount: number;
  sourceUrl: typeof SENATE_PTR_SEARCH_SOURCE;
  fetchedAt: string;
}

export interface SenateSearchReceiptInput {
  bioguideId: string;
  canonicalName: string;
  fromYear: number;
  toYear: number;
  filingIds: string[];
  fetchedAt: string;
}

export interface CompleteSenateSearchReceiptInput extends SenateSearchReceiptInput {
  completedFilingIds: string[];
}

function receiptPath(cacheRoot: string, bioguideId: string): string {
  return resolve(cacheRoot, '_search-receipts', `${bioguideId}.json`);
}

function validateReceipt(value: unknown, expectedBioguide?: string): SenateSearchReceipt {
  const receipt = value as Partial<SenateSearchReceipt> | null;
  if (!receipt || receipt.schemaVersion !== 1 || receipt.kind !== 'senate-ptr-search' ||
      receipt.status !== 'success') {
    throw new Error('malformed Senate PTR search receipt');
  }
  if (!receipt.bioguideId || !receipt.canonicalName) {
    throw new Error('malformed Senate PTR search receipt identity');
  }
  if (expectedBioguide && receipt.bioguideId !== expectedBioguide) {
    throw new Error(
      `Senate PTR search receipt does not match target bioguide ${expectedBioguide}`,
    );
  }
  if (!Number.isInteger(receipt.fromYear) || !Number.isInteger(receipt.toYear) ||
      receipt.fromYear! > receipt.toYear!) {
    throw new Error('invalid Senate PTR search year range');
  }
  if (!Array.isArray(receipt.filingIds) ||
      receipt.filingIds.some(id => typeof id !== 'string' || !id.trim()) ||
      new Set(receipt.filingIds).size !== receipt.filingIds.length ||
      receipt.filingCount !== receipt.filingIds.length) {
    throw new Error('malformed Senate PTR search filing inventory');
  }
  if (receipt.filingCount === 0) {
    throw new Error(`Senate PTR search receipt for ${receipt.bioguideId} records zero filings; ` +
      `${EMPTY_SEARCH_NOT_EVIDENCE}`);
  }
  if (receipt.sourceUrl !== SENATE_PTR_SEARCH_SOURCE ||
      typeof receipt.fetchedAt !== 'string' || Number.isNaN(Date.parse(receipt.fetchedAt))) {
    throw new Error('malformed Senate PTR search provenance');
  }
  return receipt as SenateSearchReceipt;
}

export function writeSenateSearchReceipt(
  cacheRoot: string,
  input: SenateSearchReceiptInput,
): SenateSearchReceipt {
  const receipt = validateReceipt({
    schemaVersion: 1,
    kind: 'senate-ptr-search',
    status: 'success',
    bioguideId: input.bioguideId,
    canonicalName: input.canonicalName,
    fromYear: input.fromYear,
    toYear: input.toYear,
    filingIds: [...input.filingIds].sort(),
    filingCount: input.filingIds.length,
    sourceUrl: SENATE_PTR_SEARCH_SOURCE,
    fetchedAt: input.fetchedAt,
  });
  const dir = resolve(cacheRoot, '_search-receipts');
  mkdirSync(dir, { recursive: true });
  const target = receiptPath(cacheRoot, input.bioguideId);
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(temporary, target);
  return receipt;
}

export function writeCompleteSenateSearchReceipt(
  cacheRoot: string,
  input: CompleteSenateSearchReceiptInput,
): SenateSearchReceipt | null {
  const expected = [...input.filingIds].sort();
  const completed = [...new Set(input.completedFilingIds)].sort();
  if (expected.length !== completed.length ||
      expected.some((filingId, index) => filingId !== completed[index])) {
    return null;
  }
  return writeSenateSearchReceipt(cacheRoot, input);
}

export function readSenateSearchReceipt(
  cacheRoot: string,
  bioguideId: string,
): SenateSearchReceipt | null {
  const path = receiptPath(cacheRoot, bioguideId);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('malformed Senate PTR search receipt JSON');
  }
  return validateReceipt(parsed, bioguideId);
}
