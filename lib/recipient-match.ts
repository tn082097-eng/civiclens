/**
 * Recipient-name → SEC-ticker candidate matching. RECALL stage only: output
 * is a candidate, never a shipped edge — the hand-curated recipient_ticker
 * confirm table is the precision stage (see SOURCES.md §USAspending
 * "Trap — aggressive suffix-stripping collides": ULCC↔FRONTIER TECHNOLOGY).
 *
 * norm() is a verbatim port of the frozen probe's normalization
 * (pfd-cache/usaspending-recipient-probe-2026-07-17/probe_recipients.py) so
 * harvest results reconcile with the probe.
 */

const SUFFIX_RE =
  /\b(INCORPORATED|CORPORATION|COMPANY|CORP|INC|LLC|LLP|LP|LTD|CO|PLC|SA|NV|AG|HOLDINGS?|GROUP|INTERNATIONAL|INTL|USA|US|NORTH AMERICA|AMERICAS?|ENTERPRISES?|INDUSTRIES|TECHNOLOGIES|TECHNOLOGY|SYSTEMS?|SERVICES?|SOLUTIONS?)\b/g;

export interface SecRow { ticker: string; title: string }

export function normCorpName(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(SUFFIX_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First title wins per normalized name — same as the probe's setdefault. */
export function buildNameIndex(rows: SecRow[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const r of rows) {
    const k = normCorpName(r.title);
    if (k && !idx.has(k)) idx.set(k, r.ticker.toUpperCase());
  }
  return idx;
}

export function matchTicker(
  name: string,
  parentName: string | null,
  idx: Map<string, string>,
): { ticker: string; basis: 'own-name' | 'parent-name' } | null {
  const own = idx.get(normCorpName(name));
  if (own) return { ticker: own, basis: 'own-name' };
  if (parentName) {
    const par = idx.get(normCorpName(parentName));
    if (par) return { ticker: par, basis: 'parent-name' };
  }
  return null;
}
