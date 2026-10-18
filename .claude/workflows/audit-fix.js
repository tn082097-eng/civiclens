export const meta = {
  name: 'audit-fix',
  description: 'Haiku scans, independent verify, Sonnet patches each confirmed finding in its own worktree, diff review',
  whenToUse: 'Audit one or more directories and get confirmed findings back as reviewed patch branches',
  phases: [
    { title: 'Scan', model: 'claude-haiku-5-5' },
    { title: 'Verify finding', model: 'claude-sonnet-5-5' },
    { title: 'Patch', model: 'claude-sonnet-5-5' },
    { title: 'Verify diff', model: 'claude-sonnet-5-5' },
  ],
}

// args: { paths?: string[], focus?: string, fix?: boolean }
const TARGETS = Array.isArray(args?.paths) && args.paths.length ? args.paths : ['pipeline', 'db', 'render', 'lib', 'agents', 'scripts', 'skills']
const FOCUS = args?.focus || 'correctness bugs: wrong results, crashes, data loss, broken invariants'
const FIX = args?.fix !== false
const MAX_ROUNDS = 4

const FINDINGS = {
  type: 'object', required: ['findings'],
  properties: { findings: { type: 'array', items: {
    type: 'object', required: ['file', 'line', 'summary', 'trigger', 'evidence'],
    properties: { file: { type: 'string' }, line: { type: 'integer' }, summary: { type: 'string' }, trigger: { type: 'string' }, evidence: { type: 'string' } },
  } } },
}
const VERDICT = {
  type: 'object', required: ['verdict', 'reason'],
  properties: { verdict: { type: 'string', enum: ['CONFIRMED', 'REFUTED', 'UNVERIFIED'] }, reason: { type: 'string' } },
}
const PATCH = {
  type: 'object', required: ['branch', 'commit', 'diff', 'checks', 'failing'],
  properties: { branch: { type: 'string' }, commit: { type: 'string' }, diff: { type: 'string' }, checks: { type: 'string' }, failing: { type: 'integer' } },
}
const REVIEW = {
  type: 'object', required: ['verdict', 'problems'],
  properties: { verdict: { type: 'string', enum: ['APPROVE', 'REJECT'] }, problems: { type: 'array', items: { type: 'string' } } },
}

const key = f => `${f.file}:${f.line}`
const seen = new Set()

// Fix loop: stops on an approved, green patch, or after two rounds in a row with no progress.
async function patchUntilClean(f) {
  let best = Infinity, stale = 0, last = null, feedback = ''
  for (let round = 1; round <= MAX_ROUNDS && stale < 2; round++) {
    const patch = await agent(
      `Fix ${key(f)}: ${f.summary}\nTrigger: ${f.trigger}\n` +
      (last ? `Start by applying your previous attempt:\n${last.diff}\nReviewer problems to address:\n${feedback}\n` : '') +
      'Report the branch, commit, full diff, check output, and the number of failing checks.',
      { agentType: 'patcher', isolation: 'worktree', schema: PATCH, label: `patch:${key(f)}#${round}`, phase: 'Patch' })
    if (!patch) break
    const review = await agent(
      `Review this patch for ${key(f)} (${f.summary}). Reject it if it misses the trigger, changes unrelated behaviour, or its checks fail.\nDiff:\n${patch.diff}\nChecks:\n${patch.checks}`,
      { agentType: 'verifier', schema: REVIEW, label: `review:${key(f)}#${round}`, phase: 'Verify diff' })
    if (!review) break
    if (review.verdict === 'APPROVE' && patch.failing === 0) {
      return { ...f, status: 'patched', branch: patch.branch, commit: patch.commit, rounds: round }
    }
    const remaining = patch.failing + review.problems.length
    if (remaining < best) { best = remaining; stale = 0 } else stale++
    last = patch
    feedback = review.problems.join('\n')
  }
  return { ...f, status: 'unpatched', lastBranch: last?.branch ?? null, problems: feedback }
}

log(`Scanning ${TARGETS.join(', ')} for ${FOCUS}${FIX ? '' : ' (report only)'}`)

const results = await pipeline(
  TARGETS,
  dir => agent(
    `Audit every source file under ${dir}/ for ${FOCUS}. Report only findings with a concrete triggering input or state.`,
    { agentType: 'scanner', schema: FINDINGS, label: `scan:${dir}`, phase: 'Scan' }),
  scan => parallel((scan?.findings ?? [])
    .filter(f => !seen.has(key(f)) && seen.add(key(f)))
    .map(f => () => agent(
      `Verify this finding: ${key(f)} — ${f.summary}\nTrigger: ${f.trigger}\nEvidence: ${f.evidence}`,
      { agentType: 'verifier', schema: VERDICT, label: `verify:${key(f)}`, phase: 'Verify finding' })
      .then(v => ({ ...f, verdict: v?.verdict ?? 'UNVERIFIED', reason: v?.reason ?? 'verifier did not return' })))),
  verified => {
    const all = (verified ?? []).filter(Boolean)
    const confirmed = all.filter(f => f.verdict === 'CONFIRMED')
    return parallel(confirmed.map(f => () => (FIX ? patchUntilClean(f) : Promise.resolve({ ...f, status: 'report-only' }))))
      .then(done => ({ done: done.filter(Boolean), unverified: all.filter(f => f.verdict === 'UNVERIFIED') }))
  },
)

const finished = results.filter(Boolean)
const confirmed = finished.flatMap(r => r.done)
const unverified = finished.flatMap(r => r.unverified)
log(`${confirmed.length} confirmed, ${confirmed.filter(f => f.status === 'patched').length} patched, ${unverified.length} unverified`)
return { confirmed, unverified }
