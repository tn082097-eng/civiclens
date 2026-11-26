import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import {
  findSurnameCandidates,
  validateSenatePtrIndex,
  type SenatePtrIndex,
} from './senate-ptr-index.js';

export const SENATE_PTR_SEARCH_SOURCE =
  'https://efdsearch.senate.gov/search/report/data/';

/**
 * Senate `verified-empty` rule (gate 4, 2026-11-26). A senator has zero PTRs
 * for a window only when a complete chamber-wide EFDS PTR index for that
 * window (lib/senate-ptr-index.ts: every PTR filed, listed without any name
 * filter, each date window fully accounted for against recordsTotal) contains
 * no filing, electronic or paper, under any of the target's official surname
 * tokens. Any surname match, any incomplete window, or a malformed index
 * blocks the result. The name search never certifies emptiness.
 *
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

export interface SenateEmptyCertificate {
  schemaVersion: 1;
  kind: 'senate-ptr-verified-empty';
  bioguideId: string;
  canonicalName: string;
  surnameTokens: string[];
  fromYear: number;
  toYear: number;
  index: {
    path: string; // relative to the cache root
    sha256: string;
    filingCount: number;
    windowCount: number;
    fetchedAt: string;
  };
  candidateCount: 0;
  sourceUrl: typeof SENATE_PTR_SEARCH_SOURCE;
  certifiedAt: string;
}

export interface SenateEmptyCertificateInput {
  bioguideId: string;
  canonicalName: string;
  surnameTokens: string[];
  index: SenatePtrIndex;
  certifiedAt: string;
}

function emptyCertificatePath(cacheRoot: string, bioguideId: string): string {
  return resolve(cacheRoot, '_search-receipts', `${bioguideId}.empty.json`);
}

function indexRelativePath(index: SenatePtrIndex): string {
  return `_chamber-index/${index.fromYear}-${index.toYear}-${index.sha256.slice(0, 16)}.json`;
}

function atomicWriteJson(target: string, value: unknown): void {
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, target);
}

function sameTokens(a: string[], b: string[]): boolean {
  const x = [...new Set(a)].sort(), y = [...new Set(b)].sort();
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

/**
 * Certify zero PTRs from a complete chamber-wide index. Throws, writing
 * nothing, if any filing in the index shares a surname token with the target.
 */
export function writeSenateEmptyCertificate(
  cacheRoot: string,
  input: SenateEmptyCertificateInput,
): SenateEmptyCertificate {
  const index = validateSenatePtrIndex(input.index);
  if (!input.bioguideId || !input.canonicalName || input.surnameTokens.length === 0) {
    throw new Error('Senate verified-empty certificate needs a bioguide, name and surname tokens');
  }
  const candidates = findSurnameCandidates(index, input.surnameTokens);
  if (candidates.length > 0) {
    throw new Error(`cannot certify zero Senate PTR filings for ${input.bioguideId}: the ` +
      `chamber-wide index lists ${candidates.length} filing(s) under surname ` +
      `${input.surnameTokens.join('/')}: ${candidates.map(c => c.filingId).join(', ')}`);
  }
  const relative = indexRelativePath(index);
  mkdirSync(resolve(cacheRoot, '_chamber-index'), { recursive: true });
  mkdirSync(resolve(cacheRoot, '_search-receipts'), { recursive: true });
  atomicWriteJson(resolve(cacheRoot, relative), index);
  const certificate: SenateEmptyCertificate = {
    schemaVersion: 1,
    kind: 'senate-ptr-verified-empty',
    bioguideId: input.bioguideId,
    canonicalName: input.canonicalName,
    surnameTokens: [...new Set(input.surnameTokens)].sort(),
    fromYear: index.fromYear,
    toYear: index.toYear,
    index: {
      path: relative,
      sha256: index.sha256,
      filingCount: index.filingCount,
      windowCount: index.windows.length,
      fetchedAt: index.fetchedAt,
    },
    candidateCount: 0,
    sourceUrl: SENATE_PTR_SEARCH_SOURCE,
    certifiedAt: input.certifiedAt,
  };
  atomicWriteJson(emptyCertificatePath(cacheRoot, input.bioguideId), certificate);
  return certificate;
}

/**
 * Read and re-verify a verified-empty certificate against its stored index and
 * the current official surname tokens (resolved only if a certificate exists).
 * Returns null when absent.
 */
export function readSenateEmptyCertificate(
  cacheRoot: string,
  bioguideId: string,
  officialSurnameTokens: () => string[],
): { certificate: SenateEmptyCertificate; index: SenatePtrIndex } | null {
  const path = emptyCertificatePath(cacheRoot, bioguideId);
  if (!existsSync(path)) return null;
  const expectedSurnameTokens = officialSurnameTokens();
  let certificate: SenateEmptyCertificate;
  try {
    certificate = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('malformed Senate verified-empty certificate JSON');
  }
  if (!certificate || certificate.schemaVersion !== 1 ||
      certificate.kind !== 'senate-ptr-verified-empty' ||
      certificate.bioguideId !== bioguideId || certificate.candidateCount !== 0 ||
      certificate.sourceUrl !== SENATE_PTR_SEARCH_SOURCE ||
      !Array.isArray(certificate.surnameTokens) ||
      typeof certificate.index?.path !== 'string' ||
      !/^_chamber-index\/[\w.-]+\.json$/.test(certificate.index.path)) {
    throw new Error(`malformed Senate verified-empty certificate for ${bioguideId}`);
  }
  if (!sameTokens(certificate.surnameTokens, expectedSurnameTokens)) {
    throw new Error(`Senate verified-empty certificate for ${bioguideId} was checked against ` +
      `surname ${certificate.surnameTokens.join('/')}, not the official ` +
      `${[...expectedSurnameTokens].sort().join('/')}`);
  }
  const indexPath = resolve(cacheRoot, certificate.index.path);
  if (!existsSync(indexPath)) {
    throw new Error(`Senate verified-empty certificate for ${bioguideId} cites a missing index`);
  }
  const index = validateSenatePtrIndex(JSON.parse(readFileSync(indexPath, 'utf8')));
  if (index.sha256 !== certificate.index.sha256 || index.fromYear !== certificate.fromYear ||
      index.toYear !== certificate.toYear) {
    throw new Error(`Senate verified-empty certificate for ${bioguideId} does not match its index`);
  }
  const candidates = findSurnameCandidates(index, expectedSurnameTokens);
  if (candidates.length > 0) {
    throw new Error(`Senate verified-empty certificate for ${bioguideId} is contradicted by ` +
      `${candidates.length} index filing(s) under its surname`);
  }
  return { certificate, index };
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
