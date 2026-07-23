/**
 * Behavioural skill pressure tests (Phase 1 closure, area 2).
 *
 * These assert what the two operational skills actually INSTRUCT for concrete
 * onboarding requests — not just that certain words appear. The skill files live
 * OUTSIDE the repo (~/.claude/skills), so this test resolves them from $HOME and
 * skips (does not fail) if they are absent, so CI in a bare checkout stays green.
 * When present, every scenario below must hold.
 *
 * Scenarios: one House member, one senator, one-member OpenSecrets harvest, no
 * member specified, multiple members, parked-timing execution, onboarding +
 * publishing. Criteria: require exactly one explicit member; Senate PTR (not
 * House PFD) for senators; reject ambiguous/batch; prohibit parked-timing work;
 * keep publishing separate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ONBOARD = join(homedir(), '.claude', 'skills', 'civiclens-onboard-member', 'SKILL.md');
const HARVEST = join(homedir(), '.claude', 'skills', 'civiclens-opensecrets-harvest', 'SKILL.md');

const haveSkills = existsSync(ONBOARD) && existsSync(HARVEST);
const onboard = haveSkills ? readFileSync(ONBOARD, 'utf-8') : '';
const harvest = haveSkills ? readFileSync(HARVEST, 'utf-8') : '';

/** Runnable loader commands (lines with `npx tsx ... --load-*`). */
function loaderCommandLines(md: string): string[] {
  return md.split('\n').filter(l => /npx tsx.*--load-/.test(l));
}
/** A pipeline loader invocation must carry an explicit member selector, unless it
 *  is an already-member-scoped positional loader (sponsored/cosponsored/district). */
function isScoped(line: string): boolean {
  if (/--member|--bioguide/.test(line)) return true;
  if (/--load-(sponsored|cosponsored|district-contracts|district-recipients)/.test(line)) return true;
  return false;
}

test('SCENARIO one House member: PFD path present, scoped, no scope-less pipeline loaders', { skip: !haveSkills }, () => {
  // House uses --load-pfd, and it must be member-scoped.
  assert.match(onboard, /--load-pfd <year> --member <slug>/, 'House PFD command is member-scoped');
  for (const line of loaderCommandLines(onboard)) {
    assert.ok(isScoped(line), `loader command must be member-scoped: ${line.trim()}`);
  }
});

test('SCENARIO one senator: Senate PTR used, House PFD + district loaders forbidden', { skip: !haveSkills }, () => {
  assert.match(onboard, /--load-senate-ptr --member <slug>/, 'senator uses Senate PTR, scoped');
  assert.match(onboard, /Senator[\s\S]*?do \*\*not\*\* run `--load-pfd`/i, 'senator branch forbids House PFD');
  assert.match(onboard, /district loader[\s\S]*?senator|senators[\s\S]*?district/i, 'district loaders are House-only');
  // No WA-statewide (or any statewide) substitute invented.
  assert.match(onboard, /no WA-statewide.*substitute|no .*any-state.* substitute/i);
});

test('SCENARIO one-member OpenSecrets harvest: load is member-scoped, browser rules intact', { skip: !haveSkills }, () => {
  const loadLine = loaderCommandLines(harvest).find(l => /--load-opensecrets/.test(l));
  assert.ok(loadLine, 'harvest skill has a load-opensecrets command');
  assert.ok(isScoped(loadLine!), 'OpenSecrets load is member-scoped');
  // Preserved harvest invariants.
  assert.match(harvest, /Sonnet subagent/i, 'browser step via Sonnet subagent preserved');
  assert.match(harvest, /Always include `&cycle=`|&cycle=/i, 'mandatory &cycle preserved');
  assert.match(harvest, /Freeze raw HTML/i, 'raw HTML freeze preserved');
  assert.match(harvest, /Substrate-only|never be republished/i, 'substrate-only/no-publish preserved');
});

test('SCENARIO no member specified: scope-less loaders fail closed (skill says so, never --all default)', { skip: !haveSkills }, () => {
  assert.match(onboard, /fails closed/i, 'skill states scope-less commands fail closed');
  assert.match(onboard, /never means "all"|never means all/i, 'absence of selector never means all');
});

test('SCENARIO multiple members / batch: rejected — one member at a time', { skip: !haveSkills }, () => {
  assert.match(onboard, /exactly ONE member|one member.*at a time|never a batch/i, 'one member at a time');
  assert.match(onboard, /Do NOT pass `--all` during onboarding|--all.*out of scope|--all is the roster-wide/i,
    '--all/batch explicitly out of scope for onboarding');
});

test('SCENARIO parked-timing execution/scoring: prohibited in onboarding', { skip: !haveSkills }, () => {
  assert.match(onboard, /timing-safe/i, 'run-patterns described as timing-safe');
  assert.match(onboard, /Do \*\*NOT\*\* run `score-anomaly|not run.*score-anomaly|parked-timing computation/i,
    'parked timing scoring explicitly prohibited');
  assert.match(onboard, /guard:confirmatory.*read-only|read-only status check/i,
    'guard is read-only, not authorization to run stats');
});

test('SCENARIO onboarding + publishing: publishing stays separate, onboarding never publishes', { skip: !haveSkills }, () => {
  assert.match(onboard, /Publishing.*separate.*civiclens-publish-gate/i, 'publish is a separate gated procedure');
  assert.match(onboard, /Onboarding never publishes/i, 'onboarding never publishes');
  // Harvest skill must not publish either.
  assert.match(harvest, /never be republished as a site section/i, 'harvest is substrate-only, no publish');
});
