/**
 * Corpus-validator completeness tests.
 *
 * The historical gate only asked "does every artifact that EXISTS parse?".
 * A required artifact family that produced nothing scored `0/0` and printed
 * PASS — which is how the stratum-4 (Chris Van Hollen) trial reported a green
 * corpus while the summarizer had failed twice and written no artifact at all.
 *
 * Zero produced artifacts for a required family is an absence of evidence, not
 * evidence of validity. These tests pin the distinction between:
 *   - a required family with zero artifacts  → FAIL (absence)
 *   - a family explicitly recorded as source-backed verified-empty
 *     under the frozen protocol               → PASS (accounted for)
 *   - a family recorded as withheld           → FAIL (accounted hold)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCorpus } from './validate-artifact-corpus.js';

function corpusDir(): string {
  return mkdtempSync(join(tmpdir(), 'civiclens-corpus-'));
}

/** A schema-valid summarizer artifact. */
function summarizerArtifact() {
  return {
    taskId: 'task-1',
    summarizedAt: '2026-09-09T12:00:00.000Z',
    headline: 'Jane Doe — Senator, MD (D)',
    bio: 'x'.repeat(80),
    keyFacts: ['fact one about S. 100', 'fact two about a recorded vote'],
    neutralNarrative: 'y'.repeat(140),
    dataQualityNote: 'complete',
    neutralityViolations: [],
    unverifiedFacts: [],
  };
}

function writeArtifact(root: string, taskId: string, agent: string, data: unknown): void {
  const dir = join(root, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${agent}.json`), JSON.stringify(data));
}

test('a required family with zero produced artifacts fails instead of scoring 0/0 PASS', () => {
  const root = corpusDir();
  try {
    // A task ran, but the summarizer timed out twice and wrote nothing —
    // exactly the stratum-4 shape. The task dir exists and other work happened;
    // only the summarizer artifact is absent, so it is the ONLY thing that can
    // fail this run.
    mkdirSync(join(root, 'task-1'), { recursive: true });
    writeFileSync(join(root, 'task-1', 'state.json'), JSON.stringify({ taskId: 'task-1' }));

    const report = validateCorpus({ corpusDir: root, required: ['summarizer'] });
    const summarizer = report.families.find(f => f.agent === 'summarizer');

    assert.ok(summarizer, 'the summarizer family is reported even with no artifacts');
    assert.equal(summarizer.total, 0, 'precondition: zero artifacts produced');
    assert.equal(summarizer.status, 'FAIL',
      'zero artifacts for a REQUIRED family must not report PASS');
    assert.equal(summarizer.missing, true, 'and it fails specifically as a missing family');
    assert.equal(report.ok, false, 'the corpus gate as a whole fails');
    assert.deepEqual(
      report.families.filter(f => f.status === 'FAIL').map(f => f.agent), ['summarizer'],
      'nothing else contributed to the failure');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a required family that produced a valid artifact passes', () => {
  const root = corpusDir();
  try {
    writeArtifact(root, 'task-1', 'summarizer', summarizerArtifact());

    const report = validateCorpus({ corpusDir: root, required: ['summarizer'] });
    const summarizer = report.families.find(f => f.agent === 'summarizer');

    assert.equal(summarizer?.status, 'PASS');
    assert.equal(summarizer?.pass, 1);
    assert.equal(report.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a NON-required family with zero artifacts still passes (unchanged behavior)', () => {
  const root = corpusDir();
  try {
    writeArtifact(root, 'task-1', 'summarizer', summarizerArtifact());

    // 'predictor' produced nothing and is not required — the historical
    // soft-sidecar semantics are preserved.
    const report = validateCorpus({ corpusDir: root, required: ['summarizer'] });
    const predictor = report.families.find(f => f.agent === 'predictor');

    assert.equal(predictor?.total, 0);
    assert.equal(predictor?.status, 'PASS');
    assert.equal(report.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a required family with zero artifacts passes only when a source-backed verified-empty record accounts for it', () => {
  const root = corpusDir();
  try {
    // A task ran but produced no summarizer artifact at all. (Nothing else is
    // written, so no other family can contaminate `ok`.)
    // Without a record, that absence fails.
    const bare = validateCorpus({ corpusDir: root, required: ['summarizer'] });
    assert.equal(bare.families.find(f => f.agent === 'summarizer')?.status, 'FAIL');

    // The frozen protocol's only escape hatch: a corroborated source-backed
    // record proving the family is legitimately empty (e.g. the Senate
    // zero-PTR path). This is evidence, not an absence.
    const accounted = validateCorpus({
      corpusDir: root,
      required: ['summarizer'],
      accountedEmpty: { summarizer: { state: 'verified-empty', sourceUrl: 'https://example.gov/receipt' } },
    });
    assert.equal(accounted.families.find(f => f.agent === 'summarizer')?.status, 'PASS');
    assert.equal(accounted.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a withheld formatting result is accounted for but cannot pass a required family', () => {
  const root = corpusDir();
  try {
    const report = validateCorpus({
      corpusDir: root,
      required: ['summarizer'],
      accountedEmpty: {
        summarizer: { state: 'withheld', sourceUrl: 'https://example.gov/filing.pdf' },
      },
    });
    const summarizer = report.families.find(f => f.agent === 'summarizer');

    assert.equal(summarizer?.accountedEmpty?.state, 'withheld', 'the hold remains visible');
    assert.equal(summarizer?.status, 'FAIL', 'withheld is not a certification pass');
    assert.equal(report.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an invalid artifact in a required family still fails (unchanged behavior)', () => {
  const root = corpusDir();
  try {
    writeArtifact(root, 'task-1', 'summarizer', { bio: 'too short' });

    const report = validateCorpus({ corpusDir: root, required: ['summarizer'] });
    const summarizer = report.families.find(f => f.agent === 'summarizer');

    assert.equal(summarizer?.status, 'FAIL');
    assert.equal(report.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const kind of ['unparseable', 'missing-in-one-task', 'unbacked-empty'] as const) {
  test(`required artifacts fail closed for ${kind}`, () => {
    const root = corpusDir();
    try {
      let accountedEmpty;
      if (kind === 'unparseable') {
        mkdirSync(join(root, 'task-bad'));
        writeFileSync(join(root, 'task-bad', 'summarizer.json'), '{broken');
      } else if (kind === 'missing-in-one-task') {
        writeArtifact(root, 'task-good', 'summarizer', summarizerArtifact());
        mkdirSync(join(root, 'task-missing'));
      } else {
        accountedEmpty = { summarizer: { state: 'verified-empty' as const } };
      }
      assert.equal(validateCorpus({ corpusDir: root, required: ['summarizer'], accountedEmpty }).ok, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
