import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../lib/paths.js';
import { ThemeGapReceiptsSchema, type ThemeGapReceipts } from '../lib/schemas.js';

export function loadThemeGapsOrSentinel(memberId: string): ThemeGapReceipts {
  const path = resolve(ROOT, 'pipeline', 'artifacts', `${memberId}.theme-gaps.json`);
  try {
    return ThemeGapReceiptsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return {
      memberId,
      tradeCount: 0,
      disclosedTradeCount: 0,
      band: 'insufficient-data',
      nPerm: 10000,
      windowDays: 90,
      coverage: { votesTotal: 0, votesBillLinked: 0 },
      receipts: [],
    };
  }
}
