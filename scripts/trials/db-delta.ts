#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical };

export interface TableDigest {
  rows: number;
  sha256: string;
}

export interface TableComparison {
  left: TableDigest | null;
  right: TableDigest | null;
  equal: boolean;
}

function canonicalize(value: unknown): Canonical {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const out: { [key: string]: Canonical } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return { $value: String(value) };
}

async function tableNames(conn: DuckDBConnection): Promise<string[]> {
  const result = await conn.run(`
    SELECT table_name
    FROM duckdb_tables()
    WHERE database_name = current_database()
      AND schema_name NOT IN ('information_schema', 'pg_catalog')
    ORDER BY table_name
  `);
  return ((await result.getRowObjects()) as Array<{ table_name: string }>)
    .map(row => String(row.table_name));
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function digestTable(conn: DuckDBConnection, table: string): Promise<TableDigest> {
  const result = await conn.run(`SELECT * FROM ${quoteIdentifier(table)}`);
  const rows = (await result.getRowObjects()) as Record<string, unknown>[];
  const canonicalRows = rows.map(row => JSON.stringify(canonicalize(row))).sort();
  const hash = createHash('sha256');
  for (const row of canonicalRows) hash.update(row).update('\n');
  return { rows: canonicalRows.length, sha256: hash.digest('hex') };
}

async function digestDatabase(path: string): Promise<Map<string, TableDigest>> {
  const instance = await DuckDBInstance.create(path, { access_mode: 'READ_ONLY' });
  const conn = await instance.connect();
  try {
    const result = new Map<string, TableDigest>();
    for (const table of await tableNames(conn)) result.set(table, await digestTable(conn, table));
    return result;
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

export async function compareDatabases(leftPath: string, rightPath: string) {
  const [left, right] = await Promise.all([digestDatabase(leftPath), digestDatabase(rightPath)]);
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  const tables: Record<string, TableComparison> = {};
  const changedTables: string[] = [];
  for (const name of names) {
    const leftDigest = left.get(name) ?? null;
    const rightDigest = right.get(name) ?? null;
    const equal = leftDigest !== null && rightDigest !== null
      && leftDigest.rows === rightDigest.rows
      && leftDigest.sha256 === rightDigest.sha256;
    tables[name] = { left: leftDigest, right: rightDigest, equal };
    if (!equal) changedTables.push(name);
  }
  return {
    left: realpathSync(leftPath),
    right: realpathSync(rightPath),
    changedTables,
    tables,
  };
}

async function main(): Promise<void> {
  const [left, right, ...extra] = process.argv.slice(2);
  if (!left || !right || extra.length > 0) {
    throw new Error('usage: npx tsx scripts/trials/db-delta.ts <left.duckdb> <right.duckdb>');
  }
  if (!existsSync(left) || !existsSync(right)) {
    throw new Error('both DuckDB files must exist');
  }
  const report = await compareDatabases(left, right);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.changedTables.length === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
