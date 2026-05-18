/**
 * DuckDB connection and schema bootstrap.
 *
 * Single-file embedded DB at ~/.hermes/civiclens/civiclens.duckdb.
 * Idempotent: running init.ts multiple times re-applies schema (CREATE
 * TABLE IF NOT EXISTS).
 */

import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export const DB_PATH = resolve(process.env.HOME!, '.hermes/civiclens/civiclens.duckdb');
const SCHEMA_PATH   = resolve(__dirname, 'schema.sql');

let _instance: DuckDBInstance | null = null;
let _conn: DuckDBConnection | null = null;

export async function getDb(): Promise<DuckDBConnection> {
  if (_conn) return _conn;
  _instance = await DuckDBInstance.create(DB_PATH);
  _conn     = await _instance.connect();
  return _conn;
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

export async function closeDb(): Promise<void> {
  // node-api closes implicitly on process exit; leaving as no-op for parity.
  _conn = null;
  _instance = null;
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
