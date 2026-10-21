/**
 * Official-vote runtime glue (leader-owned). Composes discovery/acquisition
 * (tools/congress-collector/acquire_window.py), the pinned collector bridge
 * (lib/collector-bridge.ts) and the per-member normalizer
 * (skills/researcher/official-member-votes.ts).
 *
 * Acquisition runs in a fresh evidence directory. Parsing runs in the pinned,
 * offline collector process. A prepared run is an explicit caller choice;
 * source/runtime failures never fall back to GovTrack or an empty vote list.
 */

import {
  OfficialVoteFailure,
  type FetchOfficialMemberVotesOptions, type OfficialMemberVotes,
  type LegacyRollRequest, type LegacyRollResolution, type ResolveOfficialRollsOptions,
} from '../../lib/official-vote-types.js';
import { coverageWindow, parseRollKey, type Chamber } from '../../lib/vote-source.js';
import { ROOT } from '../../lib/paths.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
const ACQUIRE_SCRIPT = join(ROOT, 'tools/congress-collector/acquire_window.py');
const ACQUIRE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function fail(stage: ConstructorParameters<typeof OfficialVoteFailure>[0], code: string, message: string): never {
  throw new OfficialVoteFailure(stage, code, message);
}

function validDate(date: string): void {
  try { coverageWindow(date, 0); }
  catch { fail('identity', 'invalid_roll_date', `invalid official roll date: ${String(date)}`); }
}

async function preparedRun(source: FetchOfficialMemberVotesOptions['source']): Promise<string | null> {
  if (!source || (source.mode !== 'live' && source.mode !== 'prepared')) {
    fail('acquisition', 'invalid_source_mode', 'choose live acquisition or an explicit prepared run');
  }
  if (source.mode === 'live') return null;
  if (typeof source.runDir !== 'string' || !source.runDir.trim()) {
    fail('acquisition', 'prepared_run_invalid', 'prepared acquisition directory is missing');
  }
  const dir = resolve(source.runDir);
  try {
    if (!(await stat(dir)).isDirectory() || !(await stat(join(dir, 'window-run.json'))).isFile()) {
      throw new Error('not an acquisition run directory');
    }
  } catch (error) {
    fail('acquisition', 'prepared_run_invalid', `cannot read prepared official acquisition: ${String(error)}`);
  }
  return dir;
}

/** Network step only; the child imports CivicLens stdlib acquisition code. */
async function acquire(
  chamber: Chamber,
  source: Extract<FetchOfficialMemberVotesOptions['source'], { mode: 'live' }>,
  request: { asOf: string } | { rolls: LegacyRollRequest[] },
): Promise<string> {
  const runsRoot = resolve(source.runsRoot ?? join(ROOT, 'artifacts/official-vote-runs'));
  await mkdir(runsRoot, { recursive: true });
  const name = `${chamber}-${'asOf' in request ? request.asOf : 'rolls'}-${Date.now()}-${randomUUID()}`;
  const dir = join(runsRoot, name);
  const scratch = await mkdtemp(join(tmpdir(), 'civiclens-official-acquire-'));
  const args = ['-I', '-B', ACQUIRE_SCRIPT, '--chamber', chamber, '--output', dir];
  const receipt = join(runsRoot, `${name}.execution.json`);
  if ('asOf' in request) args.push('--as-of', request.asOf, '--months', '48');
  else {
    const input = join(runsRoot, `${name}.rolls.json`);
    await writeFile(input, JSON.stringify(request.rolls, null, 2) + '\n', { flag: 'wx' });
    args.push('--rolls-json', input);
  }
  let stdout = '', stderr = '', exit: number | string = 0;
  const startedAt = new Date().toISOString();
  try {
    const result = await execFileAsync('/usr/bin/python3', args, {
      cwd: scratch,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: scratch, HOME: scratch },
      timeout: ACQUIRE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = result.stdout; stderr = result.stderr;
  } catch (error: any) {
    stdout = String(error?.stdout ?? ''); stderr = String(error?.stderr ?? error?.message ?? error);
    exit = typeof error?.code === 'number' ? error.code : String(error?.code ?? 'spawn_failed');
  } finally {
    await writeFile(receipt, JSON.stringify({
      startedAt, finishedAt: new Date().toISOString(), executable: '/usr/bin/python3',
      args, exit, stdout, stderr, runDir: dir,
    }, null, 2) + '\n', { flag: 'wx' });
    await rm(scratch, { recursive: true, force: true });
  }
  if (exit !== 0) {
    throw new OfficialVoteFailure('acquisition', 'acquisition_failed',
      `official ${chamber} acquisition failed; evidence retained`, [dir, receipt]);
  }
  try {
    const printed = JSON.parse(stdout.trim());
    if (printed.status !== 'complete' || resolve(printed.run_dir) !== dir) throw new Error('unexpected acquisition result');
  } catch {
    throw new OfficialVoteFailure('acquisition', 'malformed_acquisition_output',
      'official acquisition did not report its complete run', [dir, receipt]);
  }
  return dir;
}

function typed(error: unknown, stage: ConstructorParameters<typeof OfficialVoteFailure>[0]): OfficialVoteFailure {
  if (error instanceof OfficialVoteFailure) return error;
  const code = typeof (error as any)?.code === 'string' ? (error as any).code : `${stage}_failed`;
  return new OfficialVoteFailure(stage, code, error instanceof Error ? error.message : String(error));
}

export async function fetchOfficialMemberVotes(
  opts: FetchOfficialMemberVotesOptions,
): Promise<OfficialMemberVotes> {
  if (!opts || !/^[A-Z]\d{6}$/.test(opts.bioguideId)) fail('identity', 'invalid_member', 'a canonical bioguide ID is required');
  if (opts.chamber !== 'house' && opts.chamber !== 'senate') fail('identity', 'unsupported_chamber', 'official votes require House or Senate');
  let window: ReturnType<typeof coverageWindow>;
  try { window = coverageWindow(opts.asOf); }
  catch { fail('coverage', 'invalid_window', `invalid official vote as-of date: ${String(opts.asOf)}`); }
  const prepared = await preparedRun(opts.source);
  const [{ loadWindowRun, normalizeMemberVotes }, { runCollectorBridge, resolveCollectorRuntime }, { loadIdentityIndex }] = await Promise.all([
    import('./official-member-votes.js'), import('../../lib/collector-bridge.js'), import('../../lib/official-identity.js'),
  ]);
  const identity = loadIdentityIndex();
  // Check both membership identity and snapshot floor before any network.
  identity.inService(opts.bioguideId, opts.chamber, window.start);
  identity.inService(opts.bioguideId, opts.chamber, window.end);
  try { resolveCollectorRuntime(); } catch (error) { throw typed(error, 'runtime'); }
  const runDir = prepared ?? await acquire(opts.chamber, opts.source as { mode: 'live'; runsRoot?: string }, { asOf: opts.asOf });
  let loaded: ReturnType<typeof loadWindowRun>;
  try { loaded = loadWindowRun(runDir); } catch (error) { throw typed(error, 'acquisition'); }
  const run = loaded.run;
  if (run.mode !== 'window' || run.chamber !== opts.chamber || run.as_of !== opts.asOf || run.months !== 48
      || !run.window || run.window[0] !== window.start || run.window[1] !== window.end) {
    fail('coverage', 'window_mismatch', 'prepared official run does not cover the requested chamber and exact 48-calendar-month window');
  }
  try {
    const bridge = await runCollectorBridge(loaded.bridgeInputs);
    return normalizeMemberVotes({ ...loaded, runDir, bridge, identity,
      bioguideId: opts.bioguideId, chamber: opts.chamber, asOf: opts.asOf });
  } catch (error) { throw typed(error, 'runtime'); }
}

export async function resolveOfficialRolls(
  rolls: LegacyRollRequest[],
  opts: ResolveOfficialRollsOptions,
): Promise<LegacyRollResolution[]> {
  if (!Array.isArray(rolls) || rolls.length === 0) fail('identity', 'empty_rolls', 'at least one canonical roll is required');
  const unique = new Map<string, LegacyRollRequest>();
  const chambers = new Map<Chamber, LegacyRollRequest[]>();
  for (const row of rolls) {
    let parsed: ReturnType<typeof parseRollKey>;
    try { parsed = parseRollKey(row?.key); }
    catch { fail('identity', 'invalid_roll_key', `invalid canonical roll key: ${String(row?.key)}`); }
    validDate(row.date);
    if (!row.date.startsWith(`${parsed.year}-`)) fail('identity', 'invalid_roll_date', `roll date year differs from ${row.key}`);
    const old = unique.get(row.key);
    if (old && old.date !== row.date) fail('identity', 'conflicting_roll_date', `conflicting dates for ${row.key}`);
    if (old) continue;
    unique.set(row.key, row);
    const group = chambers.get(parsed.chamber) ?? [];
    group.push(row); chambers.set(parsed.chamber, group);
  }
  const prepared = await preparedRun(opts?.source);
  const [{ loadWindowRun, classifyRoll }, { runCollectorBridge, resolveCollectorRuntime }] = await Promise.all([
    import('./official-member-votes.js'), import('../../lib/collector-bridge.js'),
  ]);
  try { resolveCollectorRuntime(); } catch (error) { throw typed(error, 'runtime'); }
  const answers = new Map<string, LegacyRollResolution>();
  for (const [chamber, group] of chambers) {
    const runDir = prepared ?? await acquire(chamber, opts.source as { mode: 'live'; runsRoot?: string }, { rolls: group });
    let loaded: ReturnType<typeof loadWindowRun>;
    try { loaded = loadWindowRun(runDir); } catch (error) { throw typed(error, 'acquisition'); }
    if (loaded.run.chamber !== chamber) fail('acquisition', 'chamber_mismatch', 'prepared acquisition has the wrong chamber');
    const byKey = new Map(loaded.bridgeInputs.map(input => [input.key, input]));
    const inputs = group.map(row => {
      const input = byKey.get(row.key);
      if (!input || input.date !== row.date) fail('acquisition', 'missing_requested_roll', `prepared acquisition lacks identity-matched ${row.key}`);
      return input;
    });
    let bridge: Awaited<ReturnType<typeof runCollectorBridge>>;
    try { bridge = await runCollectorBridge(inputs); } catch (error) { throw typed(error, 'runtime'); }
    if (bridge.results.length !== inputs.length) fail('collector', 'result_count_mismatch', 'collector returned the wrong number of requested rolls');
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i], result = bridge.results[i];
      if (result.key !== input.key) fail('collector', 'result_identity_mismatch', 'collector returned an unexpected roll');
      if (result.ok === false) {
        answers.set(input.key, { key: input.key, ok: false,
          failure: { stage: 'collector', code: result.outcome, message: result.reason } });
      } else {
        answers.set(input.key, { key: input.key, ok: true, date: input.date,
          sourceUrl: input.source_url, resolution: classifyRoll(result.raw, result.collector) });
      }
    }
  }
  return rolls.map(row => answers.get(row.key)!);
}
