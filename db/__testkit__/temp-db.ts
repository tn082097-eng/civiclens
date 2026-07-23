/**
 * Shared temp-DuckDB harness for loader tests (Phase 1E).
 *
 * Every member-scope loader test runs against a fresh throwaway DuckDB — never
 * data/civiclens.duckdb. The full db/schema.sql is applied so tables, views, and
 * constraints match production exactly (no hand-copied DDL to drift).
 *
 * Usage:
 *   const { conn, cleanup } = await tempDb();
 *   try { ... } finally { cleanup(); }
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCHEMA_PATH = resolve(HERE, '..', 'schema.sql');

/** Apply db/schema.sql to a connection (mirrors db/init.ts applySchema splitting). */
export async function applySchemaTo(conn: DuckDBConnection): Promise<void> {
  const sql = readFileSync(SCHEMA_PATH, 'utf-8');
  const stripped = sql.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
  const stmts = stripped.split(/;\s*\n/).map(s => s.trim()).filter(s => s.length > 0);
  for (const s of stmts) await conn.run(s);
}

export interface TempDb {
  conn: DuckDBConnection;
  cleanup: () => void;
}

/** Fresh temp DuckDB with the full schema applied. */
export async function tempDb(): Promise<TempDb> {
  const dir = mkdtempSync(join(tmpdir(), 'civiclens-loader-test-'));
  const instance = await DuckDBInstance.create(join(dir, 'test.duckdb'));
  const conn = await instance.connect();
  await applySchemaTo(conn);
  return {
    conn,
    cleanup: () => {
      conn.closeSync();
      instance.closeSync();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Insert a minimal members row (only the columns loaders resolve against). */
export async function insertMember(
  conn: DuckDBConnection,
  m: {
    memberId: string;
    name: string;
    chamber: 'house' | 'senate';
    state?: string;
    district?: string | null;
    bioguideId?: string;
    fecCandidateId?: string;
  },
): Promise<void> {
  await conn.run(
    `INSERT INTO members
       (member_id, name, chamber, state, district, bioguide_id, fec_candidate_id, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      m.memberId, m.name, m.chamber, m.state ?? null, m.district ?? null,
      m.bioguideId ?? null, m.fecCandidateId ?? null, '2026-01-01T00:00:00.000Z',
    ],
  );
}

/**
 * Row-level snapshot of a table (ordered, JSON-stringified) for exact
 * invariance assertions. Counts can stay equal while wrong rows are swapped —
 * this compares actual row content. `orderBy` must make the order deterministic.
 */
export async function snapshot(
  conn: DuckDBConnection,
  table: string,
  orderBy: string,
): Promise<string> {
  const r = await conn.run(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
  const rows = (await r.getRowObjects()) as any[];
  // BigInt-safe stringify (DuckDB returns BIGINT/HUGEINT as bigint).
  return JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}
