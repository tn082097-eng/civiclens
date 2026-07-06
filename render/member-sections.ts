// Ordered section scaffold for every member page (Issue #7).
// Absence is explicit empty-state copy, never section omission.
import { esc } from './build.js';

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

export function assembleMemberBody(slots: Record<string, string>): string {
  return MEMBER_SECTION_IDS.map((id) => {
    const slot = slots[id];
    if (slot === undefined) throw new Error(`missing section slot: ${id}`);
    return slot;
  }).join('\n');
}
