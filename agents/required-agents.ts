/**
 * Which pipeline agents are REQUIRED, and what an unproduced required artifact
 * means for the run's exit status.
 *
 * Background (stratum 4, Chris Van Hollen, 2026-09-09): the summarizer's Claude
 * CLI timed out at 120s, the built-in retry timed out again, and the run
 * continued — the code checker and final reviewer both approved a member with
 * no summary artifact on disk. The orchestrator had downgraded an exhausted
 * required-agent failure to a warning, and `runPipeline` reported success by
 * simply returning.
 *
 * The rule: a required agent that is not `complete` (and was not explicitly
 * `skipped` by operator opt-out) ends the run non-zero. A soft sidecar
 * (predictor, trade-analyst) keeps its warn-and-continue semantics, because its
 * absence degrades the page rather than falsifying it.
 *
 * Note deliberately NOT taken here: raising the summarizer timeout. That would
 * change how often the failure occurs without changing what the pipeline does
 * when it occurs, which is the actual defect.
 */
import type { AgentName, PipelineTask } from '../lib/types.js';

/**
 * Agents whose artifact is required for a run to be considered successful.
 *
 * `predictor` and `trade-analyst` are excluded on purpose: both are optional
 * sidecars the orchestrator has always treated as best-effort.
 *
 * `code-checker` and `final-reviewer` are excluded for a different reason —
 * both mark `failed` to express a negative VERDICT (neutrality violations, a
 * `rejected` decision) while still writing a complete artifact. Those verdicts
 * already flow through the final review decision, and folding them in here
 * would change reviewer semantics rather than fix an absent artifact. This
 * module is scoped to artifact production only.
 */
export const REQUIRED_AGENTS: readonly AgentName[] = [
  'researcher',
  'data-checker',
  'summarizer',
] as const;

/**
 * The required agents that did not produce their artifact.
 *
 * `skipped` is NOT a failure: it is an explicit, recorded operator decision
 * (e.g. CIVICLENS_SUMMARIZER=0) rather than a silent loss. Everything else —
 * `failed`, `running`, or a never-started `pending` — is an absent required
 * artifact, and absence is reported rather than assumed benign.
 */
export function requiredAgentFailures(task: PipelineTask): AgentName[] {
  return REQUIRED_AGENTS.filter(name => {
    const status = task.agents[name]?.status;
    return status !== 'complete' && status !== 'skipped';
  });
}

/** 0 only when every required agent produced its artifact (or was skipped). */
export function pipelineExitCode(task: PipelineTask): number {
  return requiredAgentFailures(task).length > 0 ? 1 : 0;
}
