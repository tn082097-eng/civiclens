/** Usage: tsx tools/congress-collector/crosscheck_identity_roster.ts --snapshot <json> --house <MemberData.xml> --senate <senators_cfm.xml> --date YYYY-MM-DD
 *  Prints the check as JSON; exits 1 unless the snapshot matches both official lists on that date. No HTTP. */
import { readFileSync } from 'node:fs';
import { checkIdentityRoster } from '../../lib/identity-roster-check.js';
const args = process.argv.slice(2);
const arg = (flag: string) => { const n = args.indexOf(flag); if (n < 0 || !args[n + 1]) throw new Error(`missing ${flag}`); return args[n + 1]; };
const result = checkIdentityRoster(JSON.parse(readFileSync(arg('--snapshot'), 'utf8')),
  readFileSync(arg('--house'), 'utf8'), readFileSync(arg('--senate'), 'utf8'), arg('--date'));
console.log(JSON.stringify(result, null, 1));
process.exitCode = result.pass ? 0 : 1;
