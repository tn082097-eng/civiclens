// Ordered section scaffold for every member page (Issue #7).
// Absence is explicit empty-state copy, never section omission.
import { esc, fmtMoney } from './build.js';

export const MEMBER_SECTION_IDS = [
  'sec-identity', 'sec-glance', 'sec-receipts', 'sec-coherence', 'sec-money-votes',
  'sec-timeline', 'sec-trades', 'sec-donors', 'sec-revolving', 'sec-outside-spending',
  'sec-peers', 'sec-patterns', 'sec-cosponsor',
] as const;

export function sectionShell(id: string, title: string, body: string): string {
  // id lands unescaped in an HTML attribute — restrict to the registry's
  // literal shape so no call site can ever smuggle markup through it.
  if (!/^sec-[a-z][a-z-]*$/.test(id)) throw new Error(`unsafe section id: ${id}`);
  return `<h2 id="${id}">${esc(title)}</h2>\n${body}`;
}

export function reservedStub(id: string, title: string): string {
  return sectionShell(id, title, '<p class="muted">Not computed yet.</p>');
}

// ─── Money & votes ──────────────────────────────────────────────────────────
// Two strictly separated parts: (a) evidence that exists in DuckDB today —
// donor money rolled up to sector themes next to the member's focused
// sponsored bills in the same theme (the exact substrate the donor-sector
// detector reads); (b) an explicit statement that the statistical money→vote
// timing analysis is still in validation and has produced no results.

export interface MoneyVotesTheme {
  theme: string;
  total: number;        // mapped donor dollars in this theme
  share: number;        // 0..1 of the member's mapped industry dollars
  focusedBills: number; // focused bills the member SPONSORED in this theme
  cycles: string;       // e.g. "2024" or "2022–2024"
}

export interface MoneyVotesData {
  mappedTotal: number;
  themes: MoneyVotesTheme[]; // ordered total DESC, theme ASC (total order)
}

const MONEY_VOTES_PENDING =
  '<p class="muted" style="font-style:italic;">Not yet computed: the statistical ' +
  'money–vote timing analysis — whether legislative activity clusters around ' +
  'donations beyond what chance predicts — is still in validation and has ' +
  'produced no results for any member. Shared sector concentration is context, ' +
  'not a timing claim, and implies no causation.</p>';

export function renderMoneyVotesSection(d: MoneyVotesData): string {
  if (d.themes.length === 0) {
    return sectionShell('sec-money-votes', 'Money & votes',
      '<p class="muted">No mapped donor-industry data on record for this member.</p>\n' +
      MONEY_VOTES_PENDING);
  }
  const lede =
    '<p class="lede">Campaign money mapped to tradable-sector themes, next to the ' +
    'focused bills this member sponsored in the same theme. Unmapped money (labor, ' +
    'ideology, lawyers, retired, public-sector) is excluded by construction — shares ' +
    `are of ${esc(fmtMoney(d.mappedTotal))} in mapped industry contributions.</p>`;
  const rows = d.themes.map(t => `
  <tr>
    <td>${esc(t.theme)}</td>
    <td>${esc(fmtMoney(t.total))}</td>
    <td><span class="muted">${Math.round(t.share * 100)}%</span></td>
    <td>${t.focusedBills > 0 ? String(t.focusedBills) : '<span class="muted">0</span>'}</td>
    <td><span class="muted">${esc(t.cycles)}</span></td>
  </tr>`).join('');
  const table = `<table>
<thead><tr><th>Donor theme</th><th>Mapped money</th><th>Share</th><th>Focused sponsored bills</th><th>Cycles</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
  const crossRef =
    '<p class="muted">Where concentration and sponsorship meet the detector\'s ' +
    'thresholds, the flag appears under <a class="row-link" href="#sec-patterns">Patterns</a> ' +
    'with its evidence.</p>';
  return sectionShell('sec-money-votes', 'Money & votes',
    `${lede}\n${table}\n${crossRef}\n${MONEY_VOTES_PENDING}`);
}

export function assembleMemberBody(slots: Record<string, string>): string {
  return MEMBER_SECTION_IDS.map((id) => {
    const slot = slots[id];
    if (slot === undefined) throw new Error(`missing section slot: ${id}`);
    return slot;
  }).join('\n');
}
