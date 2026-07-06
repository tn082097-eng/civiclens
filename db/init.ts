/**
 * DuckDB connection and schema bootstrap.
 *
 * Single-file embedded DB at <repo>/data/civiclens.duckdb (see lib/paths.ts).
 * Idempotent: running init.ts multiple times re-applies schema (CREATE
 * TABLE IF NOT EXISTS).
 */

import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH } from '../lib/paths.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export { DB_PATH };
const SCHEMA_PATH   = resolve(__dirname, 'schema.sql');

let _instance: DuckDBInstance | null = null;
let _conn: DuckDBConnection | null = null;

export async function getDb(): Promise<DuckDBConnection> {
  if (_conn) return _conn;
  _instance = await DuckDBInstance.create(DB_PATH);
  _conn     = await _instance.connect();
  // Cap DuckDB below the OOM-killer line and spill to disk instead: the
  // default budget (80% of RAM) lets one heavy query take the process to
  // ~21GB RSS and get SIGKILLed before DuckDB self-limits.
  const memLimit = process.env.CIVICLENS_DUCKDB_MEM ?? '8GB';
  await _conn.run(`SET memory_limit='${memLimit}'`);
  await _conn.run(`SET temp_directory='${DB_PATH}.tmp'`);
  // Parallel operators buffer per-thread and the accounting runs well past
  // memory_limit (observed ~2x RSS on the default thread count). Four threads
  // keeps peak RSS near the configured limit at little wall-clock cost.
  await _conn.run(`SET threads=4`);
  return _conn;
}

/**
 * Release the DuckDB file lock so a separate process can open the DB.
 * DuckDB is single-writer per file: while this process holds an open
 * connection, spawned subprocesses (e.g. the vault regenerator) fail with
 * "Could not set lock on file". Call this before handing the DB to another
 * process, or at the end of a batch. getDb() will lazily reconnect if needed.
 */
export function closeDb(): void {
  _conn?.closeSync();
  _instance?.closeSync();
  _conn = null;
  _instance = null;
}

export async function applySchema(): Promise<void> {
  const conn = await getDb();
  const sql  = readFileSync(SCHEMA_PATH, 'utf-8');
  // DuckDB executes single statements; split on `;` at line ends.
  // Strip line comments so empty statements (pure comment blocks) drop out cleanly.
  const stripped = sql
    .split('\n')
    .map(line => line.replace(/--.*$/, ''))
    .join('\n');
  const stmts = stripped
    .split(/;\s*\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
  for (const s of stmts) {
    await conn.run(s);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  applySchema().then(() => {
    console.log(`schema applied: ${DB_PATH}`);
    process.exit(0);
  }).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
