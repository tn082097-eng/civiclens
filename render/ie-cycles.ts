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
