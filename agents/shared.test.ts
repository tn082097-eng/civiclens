import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readPipe, PIPE_DIR } from './shared.js';

// Deliberately does NOT start with 'task-': the corpus measurement/validation
// scripts filter on that prefix, so this fixture can never pollute the gate.
const FIXTURE_ID = 'tmp-readpipe-test';
const FIXTURE_DIR = join(PIPE_DIR, FIXTURE_ID);

const FixtureSchema = z.object({
  taskId: z.string(),
  passed: z.boolean(),
});

function withFixture(content: unknown, fn: () => void): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(join(FIXTURE_DIR, 'data-checker.json'), JSON.stringify(content));
  try { fn(); } finally { rmSync(FIXTURE_DIR, { recursive: true, force: true }); }
}

test('readPipe without a schema returns raw JSON (back-compat)', () => {
  withFixture({ anything: 'goes' }, () => {
    const out = readPipe<any>(FIXTURE_ID, 'data-checker');
    assert.deepEqual(out, { anything: 'goes' });
  });
});

test('readPipe with a schema accepts a valid artifact and returns the RAW object', () => {
  withFixture({ taskId: 't1', passed: true, extraField: 'kept' }, () => {
    const out = readPipe<any>(FIXTURE_ID, 'data-checker', FixtureSchema);
    // Raw, not Zod-transformed: unknown keys must survive (no stripping).
    assert.equal(out.extraField, 'kept');
  });
});

test('readPipe error names the task, agent, and offending field', () => {
  withFixture({ taskId: 't1', passed: 'yes' }, () => {
    assert.throws(
      () => readPipe<any>(FIXTURE_ID, 'data-checker', FixtureSchema),
      (e: Error) =>
        e.name === 'ArtifactValidationError' &&
        e.message.includes(FIXTURE_ID) &&
        e.message.includes('data-checker') &&
        e.message.includes('passed'),
    );
  });
});
