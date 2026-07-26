/**
 * OpenSecrets member-scope tests (Phase 1B.4). Member mode opens ONLY the
 * selected member's cached HTML for the cycle and can never rewrite another
 * cached member-cycle. Temp DuckDB + temp cache dir; pure parser (no network).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDb, insertMember, snapshot } from './__testkit__/temp-db.js';
import { loadOpenSecrets } from './load-opensecrets.js';
import type { IngestScope } from '../lib/ingest-scope.js';

function memberScope(slug: string): IngestScope {
  return { kind: 'member', slug, bioguideId: 'X', memberId: slug, chamber: 'house' };
}

/** A minimal industries table the parser recognizes (one sector, one industry). */
function widgetHtml(industry: string, total: number): string {
  return `<table><tr>
    <td>Health</td><td>$${total}</td><td>$${total}</td><td>$0</td>
    <td>${industry}</td><td>$${total}</td><td>$${total}</td><td>$0</td>
  </tr></table>`;
}

function writeCache(cacheRoot: string, cycle: number, memberId: string, html: string): void {
  const dir = join(cacheRoot, String(cycle));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${memberId}.html`), html);
}

async function seedTwoMembers(conn: any) {
  await insertMember(conn, { memberId: 'jane-doe', name: 'Jane Doe', chamber: 'house' });
  await insertMember(conn, { memberId: 'john-roe', name: 'John Roe', chamber: 'house' });
}

test('member mode loads only the target file; other member-cycle unchanged', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'os-cache-'));
  try {
    await seedTwoMembers(conn);
    writeCache(cacheRoot, 2024, 'jane-doe', widgetHtml('Pharmaceuticals', 5000));
    writeCache(cacheRoot, 2024, 'john-roe', widgetHtml('Hospitals', 7000));

    await loadOpenSecrets([2024], memberScope('john-roe'), { conn, cacheRoot });
    const roeBefore = await snapshot(
      conn, "(SELECT * FROM donor_industry WHERE member_id = 'john-roe')", 'member_id, cycle, industry');
    assert.match(roeBefore, /Hospitals/);

    await loadOpenSecrets([2024], memberScope('jane-doe'), { conn, cacheRoot });
    const all = await snapshot(conn, 'donor_industry', 'member_id, cycle, industry');
    assert.match(all, /Pharmaceuticals/, 'target loaded');
    const roeAfter = await snapshot(
      conn, "(SELECT * FROM donor_industry WHERE member_id = 'john-roe')", 'member_id, cycle, industry');
    assert.equal(roeAfter, roeBefore, 'other member-cycle byte-identical');
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('member mode never rewrites another cached member-cycle (only opens target file)', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'os-cache-'));
  try {
    await seedTwoMembers(conn);
    writeCache(cacheRoot, 2024, 'jane-doe', widgetHtml('Pharmaceuticals', 5000));
    writeCache(cacheRoot, 2024, 'john-roe', widgetHtml('Hospitals', 7000));

    const { results } = await loadOpenSecrets([2024], memberScope('jane-doe'), { conn, cacheRoot });
    assert.equal(results.length, 1, 'exactly one member-cycle processed');
    assert.equal(results[0].memberId, 'jane-doe');
    const all = await snapshot(conn, 'donor_industry', 'member_id, cycle, industry');
    assert.doesNotMatch(all, /Hospitals/, "other member's file never opened/written");
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('member mode with a missing target file is an explicit result, not a roster scan', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'os-cache-'));
  try {
    await seedTwoMembers(conn);
    writeCache(cacheRoot, 2024, 'john-roe', widgetHtml('Hospitals', 7000));
    // No file for jane-doe.
    const { results, errored } = await loadOpenSecrets([2024], memberScope('jane-doe'), { conn, cacheRoot });
    assert.equal(results.length, 1);
    assert.ok(results[0].error, 'missing target file surfaces as an explicit error');
    assert.equal(errored, 1);
    const all = await snapshot(conn, 'donor_industry', 'member_id, cycle, industry');
    assert.doesNotMatch(all, /Hospitals/, 'never fell through to another member');
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('all mode loads every cached file', async () => {
  const { conn, cleanup } = await tempDb();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'os-cache-'));
  try {
    await seedTwoMembers(conn);
    writeCache(cacheRoot, 2024, 'jane-doe', widgetHtml('Pharmaceuticals', 5000));
    writeCache(cacheRoot, 2024, 'john-roe', widgetHtml('Hospitals', 7000));

    await loadOpenSecrets([2024], { kind: 'all' }, { conn, cacheRoot });
    const all = await snapshot(conn, 'donor_industry', 'member_id, cycle, industry');
    assert.match(all, /Pharmaceuticals/);
    assert.match(all, /Hospitals/);
  } finally {
    cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});
