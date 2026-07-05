import { sectionShell } from './member-sections.js';

export function revolvingEmptyShell(): string {
  return sectionShell(
    'sec-revolving',
    'Revolving door — former staff now lobbying',
    '<p class="muted">No disclosed revolving-door lobbyist ties in corpus.</p>',
  );
}

export function outsideSpendingEmptyShell(reason: 'no-fec-id' | 'no-ie'): string {
  const body = reason === 'no-fec-id'
    ? '<p class="muted">Outside spending unavailable — no FEC candidate id on file.</p>'
    : '<p class="muted">No independent-expenditure spending found for this cycle.</p>';
  return sectionShell('sec-outside-spending', 'Outside spending', body);
}
