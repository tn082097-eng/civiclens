import * as fs from 'fs';
import { SEED_PATH, ok, warn, info, dim, bold, red, stripTerminalCodes, readPipe, writePipe } from './shared.js';

export function applySeedBlock(taskId: string) {
  const finalReview = readPipe<any>(taskId, 'final-review');
  if (!finalReview.readyToApply) {
    console.log(red('\nTask is not approved for applying.'));
    process.exit(1);
  }

  const researcher = readPipe<any>(taskId, 'researcher');
  const summarizer = readPipe<any>(taskId, 'summarizer');
  const coder      = readPipe<any>(taskId, 'coder');
  const d = researcher.data;

  if (!fs.existsSync(SEED_PATH)) {
    console.log(red(`\nSeed file not found: ${SEED_PATH}`));
    process.exit(1);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${SEED_PATH}.bak.${ts}`;
  fs.copyFileSync(SEED_PATH, backupPath);

  const esc = (s: string) => String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g,  '\\"')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  function insertBeforeArrayEnd(
    src: string, arrayName: string, newLine: string,
  ): { src: string; line: number | null } {
    const startRe = new RegExp(`^const ${arrayName} = \\[`, 'm');
    const startMatch = startRe.exec(src);
    if (!startMatch) {
      warn(arrayName, `array not found in seed.ts — skipping`);
      return { src, line: null };
    }
    const after = src.slice(startMatch.index);
    const endMatch = after.match(/^\];/m);
    if (!endMatch) {
      warn(arrayName, `closing ]; not found — skipping`);
      return { src, line: null };
    }
    const endAbs = startMatch.index + endMatch.index!;
    const before = src.slice(0, endAbs);
    const insertedLine = before.split('\n').length;
    return { src: before + newLine + '\n' + src.slice(endAbs), line: insertedLine };
  }

  let content = fs.readFileSync(SEED_PATH, 'utf-8');
  const bio = esc(stripTerminalCodes(summarizer.bio ?? d.bio));

  const slugLit = [`slug: "${d.id}"`, `slug: '${d.id}'`];
  const lines   = content.split('\n');
  const existingLineIdx = lines.findIndex((l: string) => slugLit.some(p => l.includes(p)));

  let appliedAtLine: number | null = null;

  if (existingLineIdx >= 0) {
    const original = lines[existingLineIdx];
    let updated = original.replace(/bio:\s*"[^"]*"/, `bio: "${bio}"`);
    if (updated === original) updated = original.replace(/bio:\s*'[^']*'/, `bio: "${bio}"`);
    lines[existingLineIdx] = updated;
    content = lines.join('\n');
    fs.writeFileSync(SEED_PATH, content);
    appliedAtLine = existingLineIdx + 1;
    ok('Apply', `updated bio for ${bold(d.name)}`);
    console.log(dim(`  → ${SEED_PATH}:${appliedAtLine}`));
  } else {
    const idNums = [...content.matchAll(/\{ id:\s*"p(\d+)"/g)].map(m => parseInt(m[1]));
    const nextNum = idNums.length ? Math.max(...idNums) + 1 : 21;
    const newId   = `p${nextNum}`;

    const politicianLine = `  { id: "${newId}", slug: "${d.id}", name: "${esc(d.name)}", party: "${d.party}", state: "${d.state}", chamber: "${d.chamber}", role: "${esc(d.role)}", inOffice: ${d.inOffice}, bio: "${bio}" },`;
    ({ src: content, line: appliedAtLine } =
      insertBeforeArrayEnd(content, 'politicians', politicianLine));
    ok('Apply', `inserted ${bold(d.name)} as ${newId}`);

    for (let i = 0; i < (d.bills ?? []).length; i++) {
      const b = d.bills[i];
      const id = `b${nextNum}${String.fromCharCode(97 + i)}`;
      ({ src: content } = insertBeforeArrayEnd(content, 'bills',
        `  { id: "${id}", politicianId: "${newId}", title: "${esc(b.title)}", summary: "${esc(b.summary)}", status: "${b.status}", introducedAt: "${b.introducedAt}", source: "${b.source}", confidence: ${b.confidence} },`
      ));
    }

    for (let i = 0; i < (d.votes ?? []).length; i++) {
      const v = d.votes[i];
      const id = `v${nextNum}${String.fromCharCode(97 + i)}`;
      ({ src: content } = insertBeforeArrayEnd(content, 'votes',
        `  { id: "${id}", politicianId: "${newId}", billTitle: "${esc(v.billTitle)}", vote: "${v.vote}", date: "${v.date}", source: "${v.source}", confidence: ${v.confidence} },`
      ));
    }

    for (let i = 0; i < (d.donors ?? []).length; i++) {
      const don = d.donors[i];
      const id = `d${nextNum}${String.fromCharCode(97 + i)}`;
      ({ src: content } = insertBeforeArrayEnd(content, 'donors',
        `  { id: "${id}", politicianId: "${newId}", name: "${esc(don.name)}", type: "${don.type}", amount: ${don.amount}, date: "${don.date}", source: "${don.source}", confidence: ${don.confidence} },`
      ));
    }

    fs.writeFileSync(SEED_PATH, content);
    info('Apply', `bills: ${(d.bills??[]).length}  votes: ${(d.votes??[]).length}  donors: ${(d.donors??[]).length}`);
    console.log(dim(`  → ${SEED_PATH}:${appliedAtLine}`));
  }

  const publisherOutput = {
    taskId,
    appliedAt:     new Date().toISOString(),
    action:        coder.action,
    politicianId:  coder.politicianId,
    section:       coder.section,
    appliedAtLine,
    backupPath,
  };
  writePipe(taskId, 'publisher', publisherOutput);
}
