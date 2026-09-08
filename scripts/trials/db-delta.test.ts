import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DuckDBInstance } from '@duckdb/node-api';

const SCRIPT = resolve('scripts/trials/db-delta.ts');

async function createFixture(path: string, reverse = false, changed = false): Promise<void> {
  const instance = await DuckDBInstance.create(path);
  const conn = await instance.connect();
  try {
    await conn.run('CREATE TABLE alpha (id INTEGER, label VARCHAR)');
    await conn.run('CREATE TABLE beta (id INTEGER, amount BIGINT)');
    const alpha = reverse
      ? [[2, 'two'], [1, 'one']]
      : [[1, 'one'], [2, changed ? 'changed' : 'two']];
    for (const row of alpha) await conn.run('INSERT INTO alpha VALUES (?, ?)', row);
    await conn.run('INSERT INTO beta VALUES (1, 9007199254740993)');
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

test('db-delta reports deterministic table hashes and isolates changed tables', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'civiclens-db-delta-'));
  try {
    const left = join(dir, 'left.duckdb');
    const reordered = join(dir, 'reordered.duckdb');
    const changed = join(dir, 'changed.duckdb');
    await createFixture(left);
    await createFixture(reordered, true);
    await createFixture(changed, false, true);

    const sameRun = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, left, reordered], {
      encoding: 'utf8',
    });
    assert.equal(sameRun.status, 0, sameRun.stderr);
    const same = JSON.parse(sameRun.stdout);
    assert.deepEqual(same.changedTables, []);
    assert.equal(same.tables.alpha.left.sha256, same.tables.alpha.right.sha256);
    assert.equal(same.tables.beta.left.sha256, same.tables.beta.right.sha256);

    const changedRun = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, left, changed], {
      encoding: 'utf8',
    });
    assert.equal(changedRun.status, 1, changedRun.stderr);
    const delta = JSON.parse(changedRun.stdout);
    assert.deepEqual(delta.changedTables, ['alpha']);
    assert.equal(delta.tables.alpha.left.rows, 2);
    assert.equal(delta.tables.alpha.right.rows, 2);
    assert.equal(delta.tables.beta.equal, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
