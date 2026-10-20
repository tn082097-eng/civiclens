/** Execute the hash-pinned congress parser inside a fresh offline namespace. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_CONTRACT, BRIDGE_VERSION, type BridgeRollInput, type BridgeRun } from './official-vote-types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, 'tools/congress-collector');
const PIN = '8184bcb13160da2389dea4c902de67817db681fc';
const VENDOR = join(TOOLS, 'vendor/unitedstates-congress-8184bcb/VENDOR.json');
const LOCK = join(TOOLS, 'requirements.lock');
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
export type CollectorBridgeErrorCode = 'runtime_missing' | 'runtime_stale' | 'netns_unavailable' | 'bridge_failed' | 'malformed_output';
export class CollectorBridgeError extends Error {
  constructor(readonly code: CollectorBridgeErrorCode, message: string) { super(`collector bridge ${code}: ${message}`); this.name = 'CollectorBridgeError'; }
}
interface RuntimeMetadata { lock_sha256: string; python: string; packages: Record<string, string>; vendor_manifest_sha256: string }
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is Record<string,string> => object(v) && Object.values(v).every(x => typeof x === 'string');

export function resolveCollectorRuntime(opts: { runtimeDir?: string } = {}): { runtimeDir: string; python: string; runtime: RuntimeMetadata } {
  const runtimeDir = resolve(opts.runtimeDir ?? process.env.CIVICLENS_COLLECTOR_RUNTIME ?? join(TOOLS, '.runtime'));
  const python = join(runtimeDir, 'venv/bin/python');
  const metadata = join(runtimeDir, 'runtime.json');
  if (!existsSync(python) || !existsSync(metadata)) throw new CollectorBridgeError('runtime_missing', runtimeDir);
  try {
    const runtime: unknown = JSON.parse(readFileSync(metadata, 'utf8'));
    if (!object(runtime) || runtime.lock_sha256 !== hash(LOCK) || runtime.vendor_manifest_sha256 !== hash(VENDOR)
      || typeof runtime.python !== 'string' || !strings(runtime.packages)) throw new Error('lock, vendor or runtime metadata mismatch');
    return { runtimeDir, python, runtime: runtime as RuntimeMetadata };
  } catch (error) { throw new CollectorBridgeError('runtime_stale', String(error)); }
}

/** Exported for deterministic wire-format rejection tests. No malformed result is usable. */
export function validateBridgeRun(value: unknown, rolls: BridgeRollInput[]): BridgeRun {
  const fail = (reason: string): never => { throw new CollectorBridgeError('malformed_output', reason); };
  const num = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  const voter = (v: unknown) => object(v) && typeof v.id === 'string' && v.id.trim() !== '' && typeof v.raw_position === 'string';
  if (!rolls.length || !object(value)) return fail('missing request or output');
  if (value.bridge !== BRIDGE_CONTRACT || value.bridge_version !== BRIDGE_VERSION) return fail('contract/version mismatch');
  if (!object(value.collector) || value.collector.commit !== PIN || value.collector.repository !== 'https://github.com/unitedstates/congress'
      || value.collector.vendor_manifest_sha256 !== hash(VENDOR)) return fail('collector identity mismatch');
  if (!object(value.runtime) || value.runtime.lock_sha256 !== hash(LOCK) || typeof value.runtime.python !== 'string' || !strings(value.runtime.packages)) return fail('runtime identity mismatch');
  if (!object(value.network) || !Array.isArray(value.network.interfaces) || value.network.interfaces.some((x: unknown) => x !== 'lo') || value.network.interfaces.length > 1) return fail('network namespace mismatch');
  if (!Array.isArray(value.inference_disabled) || [...value.inference_disabled].sort().join(',') !== 'download,lookup_legislator,require_congress_legislators_repo') return fail('inference guards missing');
  if (!Array.isArray(value.results) || value.results.length !== rolls.length) return fail('result count mismatch');
  for (let i = 0; i < rolls.length; i++) {
    const result: unknown = value.results[i]; const input = rolls[i];
    if (!object(result) || result.key !== input.key) return fail(`result ${i} key/order mismatch`);
    if (result.ok === false) {
      if (!['malformed_source', 'unsupported_record', 'incomplete_fetch', 'ambiguity'].includes(result.outcome) || typeof result.reason !== 'string' || !result.reason) return fail(`result ${i} invalid failure`);
      continue;
    }
    if (result.ok !== true || !object(result.raw) || !object(result.collector)) return fail(`result ${i} invalid success`);
    const raw = result.raw;
    for (const key of ['chamber','congress','session','roll','date'] as const) if (raw[key] !== input[key]) return fail(`result ${i} raw ${key} mismatch`);
    if (!Array.isArray(raw.voters) || !raw.voters.length || !raw.voters.every(voter) || new Set(raw.voters.map((v: any) => v.id)).size !== raw.voters.length) return fail(`result ${i} invalid voters`);
    if (typeof raw.question !== 'string' || typeof raw.result !== 'string') return fail(`result ${i} invalid raw text`);
    if (raw.chamber === 'house') {
      if (!['legis_num','vote_type','vote_desc'].every(k => typeof raw[k] === 'string') || !(raw.amendment_num === null || typeof raw.amendment_num === 'string') || !object(raw.totals)) return fail(`result ${i} invalid House raw`);
      if (raw.totals.kind === 'by_vote') { if (!['yea','nay','present','not_voting'].every(k => num(raw.totals[k]))) return fail(`result ${i} invalid House counts`); }
      else if (raw.totals.kind === 'by_candidate') { if (!Array.isArray(raw.totals.candidates) || !raw.totals.candidates.length || !raw.totals.candidates.every((c: any) => object(c) && typeof c.name === 'string' && c.name && num(c.total))) return fail(`result ${i} invalid candidate counts`); }
      else return fail(`result ${i} invalid totals kind`);
    } else {
      if (typeof raw.vote_title !== 'string' || !object(raw.document) || !['document_congress','document_type','document_number','document_name','amendment_number','amendment_to_document_number'].every(k => typeof raw.document[k] === 'string') || !object(raw.count) || !['yeas','nays','present','absent'].every(k => num(raw.count[k])) || !object(raw.tie_breaker) || typeof raw.tie_breaker.by_whom !== 'string' || typeof raw.tie_breaker.vote !== 'string') return fail(`result ${i} invalid Senate raw`);
    }
    if ('updated_at' in result.collector || !object(result.collector.votes) || !Object.values(result.collector.votes).every(v => Array.isArray(v) && v.every(x => x === 'VP' || (object(x) && typeof x.id === 'string')))) return fail(`result ${i} invalid collector output`);
  }
  return value as unknown as BridgeRun;
}

export async function runCollectorBridge(rolls: BridgeRollInput[], opts: { runtimeDir?: string; timeoutMs?: number } = {}): Promise<BridgeRun> {
  if (!Array.isArray(rolls) || !rolls.length) throw new CollectorBridgeError('malformed_output', 'rolls must be non-empty');
  const runtime = resolveCollectorRuntime(opts);
  const temp = mkdtempSync(join(tmpdir(), 'civiclens-collector-'));
  try {
    const output = await new Promise<string>((fulfill, reject) => {
      const child = spawn('unshare', ['-rn', runtime.python, '-I', '-B', join(TOOLS, 'bridge.py')], { cwd: temp, env: { PATH: '/usr/bin:/bin', HOME: temp, TMPDIR: temp, LANG: 'C.UTF-8' }, stdio: ['pipe','pipe','pipe'] });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      let stdout = ''; let stderr = ''; let size = 0; let settled = false;
      const finish = (error?: CollectorBridgeError) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else fulfill(stdout); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new CollectorBridgeError('bridge_failed', 'timeout')); }, opts.timeoutMs ?? 120000);
      child.stdout.on('data', chunk => { size += chunk.length; if (size > 256 * 1024 * 1024) { child.kill('SIGKILL'); finish(new CollectorBridgeError('malformed_output', 'output exceeds 256 MiB')); } else stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { if (stderr.length < 65536) stderr += chunk.toString(); });
      child.on('error', error => finish(new CollectorBridgeError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'netns_unavailable' : 'bridge_failed', error.message)));
      child.on('close', code => { if (code !== 0) finish(new CollectorBridgeError(/unshare:.*(?:not permitted|not supported|unavailable)/i.test(stderr) ? 'netns_unavailable' : 'bridge_failed', stderr.trim() || `exit ${code}`)); else finish(); });
      child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') finish(new CollectorBridgeError('bridge_failed', error.message)); });
      child.stdin.end(JSON.stringify({ rolls }));
    });
    let decoded: unknown;
    try { decoded = JSON.parse(output); } catch { throw new CollectorBridgeError('malformed_output', 'stdout is not one JSON document'); }
    return validateBridgeRun(decoded, rolls);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
