/**
 * Independent-expenditure cycle selection for the outside-spending section.
 *
 * The render used to show a single cycle chosen by `MAX(cycle)`. That was wrong:
 * FEC opens each new cycle with minimum-threshold Schedule E rows ($2–$10), so
 * the just-opened cycle structurally outranked the one holding the real money.
 * Frankel rendered "Supporting $10 / Opposing $0, 2026 cycle" while $106,500 of
 * 2024 opposition was hidden; Horsford hid $2.85M. 15 members were affected.
 *
 * Every cycle with data now renders, newest first — nothing is hidden and no
 * ranking heuristic is needed. Ordering is by CYCLE, deliberately not by spend:
 * summed dollars are not a total order (ties are plausible at $10), and a
 * magnitude rank would silently promote an old cycle over the live one.
 */

/** Cycles to render, newest first. Deduped; ordering is total (cycle is unique). */
export function orderIeCycles(rows: Array<{ cycle: number }>): number[] {
  return [...new Set(rows.map(r => Number(r.cycle)))].sort((a, b) => b - a);
}

/**
 * Heading for one cycle's block. The in-progress cycle is marked so a small
 * number there reads as "so far", not as the member's total outside spending.
 */
export function ieCycleLabel(cycle: number, currentCycle: number): string {
  return cycle >= currentCycle ? `${cycle} cycle (in progress)` : `${cycle} cycle`;
}

/**
 * Whether the render covers every cycle the DB said this member has.
 *
 * The dollar figures do not come from `super_pac_ie` — the DB supplies only the
 * cycle *numbers*, and every amount is fetched live per cycle from OpenFEC. A
 * fetch that throws used to be swallowed with a `console.warn`, so the page
 * rendered without that cycle and gave no sign it was ever meant to be there.
 * That reproduces the visible failure of the MAX(cycle) bug this module was
 * written to fix — real money absent from a transparency page — via a different
 * cause, and it is harder to notice: a section showing one cycle reads as
 * complete, whereas an empty section reads as suspicious.
 *
 * `total` is kept distinct from `complete` because the two render identically
 * otherwise: an all-cycles-failed member would fall through to the empty shell
 * and assert "no independent-expenditure spending found", which the DB
 * contradicts. Absence of evidence is not evidence of absence.
 */
export type IeFetchOutcome = {
  kind: 'complete' | 'partial' | 'total';
  failed: number[];
};

export function ieFetchOutcome(requested: number[], rendered: number[]): IeFetchOutcome {
  const got = new Set(rendered);
  const failed = [...new Set(requested)].filter(c => !got.has(c)).sort((a, b) => b - a);
  if (failed.length === 0) return { kind: 'complete', failed };
  return { kind: requested.length > 0 && rendered.length === 0 ? 'total' : 'partial', failed };
}

/**
 * Disclosure line for cycles that could not be retrieved. Deliberately worded as
 * a retrieval failure: saying "no spending" here would state as fact the very
 * thing we failed to determine.
 */
export function ieUnavailableNote(failed: number[]): string {
  if (failed.length === 0) return '';
  const cycles = failed.map(c => `${c}`).join(', ');
  const plural = failed.length > 1 ? 'cycles' : 'cycle';
  return `Independent-expenditure data for the ${cycles} ${plural} could not be retrieved from OpenFEC for this build. Spending on record for ${failed.length > 1 ? 'those cycles' : 'that cycle'} is not shown below.`;
}
