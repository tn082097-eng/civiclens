// Reusable core for the preregistered confirmatory-analysis guard (ADR 0003).
//
// This module is the SINGLE source of the gate logic. It is imported by:
//   - scripts/confirmatory-guard.ts     (the manual `npm run guard:confirmatory` preflight)
//   - the confirmatory CLI runners       (in-path enforcement — assertConfirmatoryAllowed)
//
// The in-path call is what makes the protection mandatory for the supported
// command paths: each confirmatory runner calls assertConfirmatoryAllowed()
// BEFORE it opens the DB or computes anything, so a consumed detector aborts
// before any outcome-bearing computation — not merely when someone remembers to
// chain `guard && command`.
//
// Scope (Phase 1): the registry is a markdown file keyed by detector ID; there
// is no atomic reservation, concurrency control, or protocol-hash validation.
// See docs/adr/0003-preregistered-confirmatory-analysis-policy.md "Phase 2".
//
// No DB, no network — pure filesystem + string parsing.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const REGISTRY_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../docs/confirmatory-runs.md',
);

export interface RegistryRow {
  detector_id: string;
  spec: string;
  status: string;
  run_commit: string;
  outcome: string;
  invalidation: string;
}

const COLS = ['detector_id', 'spec', 'status', 'run_commit', 'outcome', 'invalidation'] as const;
const CONSUMED = new Set(['consumed-pass', 'consumed-fail']);

/** Parse the one markdown table in the registry into typed rows. */
export function parseRegistry(md: string): RegistryRow[] {
  const rows: RegistryRow[] = [];
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.slice(1, t.endsWith('|') ? -1 : undefined).split('|').map(c => c.trim());
    if (cells.length !== COLS.length) continue;
    if (cells[0] === 'detector_id') continue;      // header
    if (/^-+$/.test(cells[0])) continue;           // separator
    const row = {} as RegistryRow;
    COLS.forEach((c, i) => { row[c] = cells[i]; });
    rows.push(row);
  }
  return rows;
}

export type CheckStatus = 'ok-registered' | 'ok-invalidated' | 'stop-consumed' | 'stop-unknown';

export interface CheckResult {
  id: string;
  status: CheckStatus;
  blocked: boolean;
  message: string;
  row?: RegistryRow;
}

/**
 * Decide, for each detector id, whether a confirmatory run may proceed.
 * Pure: takes the parsed registry, returns per-id verdicts. Fails closed —
 * an id absent from the registry is blocked.
 */
export function checkDetectors(ids: string[], registry: RegistryRow[]): CheckResult[] {
  return ids.map(id => {
    const row = registry.find(r => r.detector_id === id);
    if (!row) {
      return {
        id, status: 'stop-unknown', blocked: true,
        message: `STOP: "${id}" is not in the confirmatory-run registry. Add a preregistration row before any confirmatory run (ADR 0003).`,
      };
    }
    const consumed = CONSUMED.has(row.status);
    const claimsInvalidation = row.status === 'invalidated' || consumed;
    // ADR 0003 §4: invalidation must be DOCUMENTED before a replacement run.
    // A nonempty invalidation reference is the evidence; a bare `invalidated`
    // status with no reference is an unevidenced exception and must fail closed.
    const documented = row.invalidation.length > 0;

    // Unevidenced invalidation: status says invalidated but no reference recorded.
    if (row.status === 'invalidated' && !documented) {
      return {
        id, row, status: 'stop-consumed', blocked: true,
        message:
          `STOP: "${id}" is marked status=invalidated but carries NO documented invalidation reference.\n` +
          `      ADR 0003 §4: invalidation must be documented (a dated amendment / superseding ADR) BEFORE any replacement run.\n` +
          `      Record the reference in the registry's invalidation column, then re-run. Failing closed until then.`,
      };
    }

    if (consumed && !documented) {
      return {
        id, row, status: 'stop-consumed', blocked: true,
        message:
          `STOP: "${id}" has already consumed its preregistered confirmatory run (status=${row.status}, commit=${row.run_commit || 'n/a'}).\n` +
          `      Outcome: ${row.outcome || '(see spec)'}\n` +
          `      ADR 0003: a consumed run is FINAL. No second confirmatory computation without a DOCUMENTED invalidation recorded first.\n` +
          `      A materially different hypothesis/features/procedure/data/rule is a NEW registration, not a rerun.`,
      };
    }

    // Cleared via documented invalidation: a replacement run is permitted
    // through the supported workflow. Exactly-one replacement execution remains
    // a POLICY requirement (not mechanically enforced) until Phase 2 adds
    // replacement registration IDs, reservation state, and lineage.
    if (claimsInvalidation && documented) {
      return {
        id, row, status: 'ok-invalidated', blocked: false,
        message:
          `OK: "${id}" has a documented invalidation (${row.invalidation}) — a replacement run is permitted ` +
          `through the supported workflow. Exactly-one replacement execution remains a policy requirement ` +
          `until Phase 2 adds replacement registration IDs, reservation state, and lineage.`,
      };
    }

    return {
      id, row, status: 'ok-registered', blocked: false,
      message: `OK: "${id}" is registered and its confirmatory run is not yet consumed — clear to proceed.`,
    };
  });
}

/** Load + parse the registry from disk. Throws on read/parse failure. */
export function loadRegistry(path: string = REGISTRY_PATH): RegistryRow[] {
  const registry = parseRegistry(readFileSync(path, 'utf8'));
  if (registry.length === 0) {
    throw new Error(`no detector rows parsed from ${path} — registry format changed?`);
  }
  return registry;
}

/**
 * SOFT advisory for the routine recompute paths (run-patterns, score-anomaly).
 * These are NOT confirmatory runners — recomputation after a data refresh is
 * permitted and expected (ADR 0003). But scoring a detector whose confirmatory
 * run is still `registered` (not yet consumed via its baseline runner) can
 * produce a first outcome outside the gated event, so we WARN (never block):
 * the authoritative confirmatory run is the dedicated `*-baseline.ts` runner.
 * Returns the ids that triggered a warning (for tests). Never throws on a
 * missing registry — a recompute path must not be coupled to registry health.
 */
export function warnIfUnconsumed(
  ids: string[],
  opts: { registryPath?: string; log?: (m: string) => void } = {},
): string[] {
  const log = opts.log ?? ((m: string) => console.warn(m));
  let registry: RegistryRow[];
  try {
    registry = loadRegistry(opts.registryPath);
  } catch {
    return []; // recompute must not depend on registry readability
  }
  const warned: string[] = [];
  for (const r of checkDetectors(ids, registry)) {
    if (r.status === 'ok-registered') {
      warned.push(r.id);
      log(
        `  note: "${r.id}" has not yet consumed its preregistered confirmatory run. ` +
        `This recompute path is not the confirmatory event — the authoritative one-shot ` +
        `run is the detector's *-baseline.ts runner (ADR 0003).`,
      );
    }
  }
  return warned;
}

export class ConfirmatoryGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfirmatoryGuardError';
  }
}

/**
 * IN-PATH ENFORCEMENT. Call this at the top of every confirmatory runner's
 * main(), BEFORE opening the DB or computing anything. Throws
 * ConfirmatoryGuardError if any detector is blocked — the runner must let it
 * propagate (its catch exits non-zero), so no outcome-bearing computation runs.
 *
 * `registryPath` is injectable for tests (a fixture registry).
 */
export function assertConfirmatoryAllowed(
  ids: string[],
  opts: { registryPath?: string } = {},
): CheckResult[] {
  const registry = loadRegistry(opts.registryPath);
  const results = checkDetectors(ids, registry);
  const blocked = results.filter(r => r.blocked);
  if (blocked.length > 0) {
    const detail = blocked.map(r => r.message).join('\n');
    throw new ConfirmatoryGuardError(
      `confirmatory guard: BLOCKED — refusing to run outcome-bearing computation.\n${detail}`,
    );
  }
  return results;
}
