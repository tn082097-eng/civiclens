#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = 'https://efdsearch.senate.gov';
const UA = 'CivicLens/1.0 (public interest research; civiclens.org)';

export interface PtrRef {
  id: string;
  dateReceived: string;
}

export function extractPtrRefs(payload: any): PtrRef[] {
  if (payload?.result !== 'ok' || !Array.isArray(payload?.data)) {
    throw new Error(`unexpected EFDS result: ${JSON.stringify(payload?.result)}`);
  }
  const refs: PtrRef[] = [];
  for (const row of payload.data as unknown[][]) {
    let id = '';
    let dateReceived = '';
    for (const raw of row) {
      const cell = String(raw ?? '');
      id ||= cell.match(/\/search\/view\/ptr\/([a-f0-9-]{36})\//i)?.[1] ?? '';
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(cell.trim())) dateReceived = cell.trim();
    }
    if (id) refs.push({ id, dateReceived });
  }
  return refs;
}

interface Session {
  csrfToken: string;
  cookie: string;
}

async function openSession(): Promise<Session> {
  const home = await fetch(`${BASE}/search/home/`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!home.ok) throw new Error(`EFDS home HTTP ${home.status}`);
  const html = await home.text();
  const csrfForm = html.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/)?.[1];
  if (!csrfForm) throw new Error('EFDS CSRF token not found');
  const csrfCookie = home.headers.get('set-cookie')?.match(/csrftoken=([^;]+)/)?.[1] ?? csrfForm;
  const agreement = await fetch(`${BASE}/search/home/`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${BASE}/search/home/`,
      Cookie: `csrftoken=${csrfCookie}`,
    },
    body: new URLSearchParams({
      csrfmiddlewaretoken: csrfForm,
      prohibition_agreement: '1',
    }).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  const cookies = agreement.headers.get('set-cookie') ?? '';
  const sessionId = cookies.match(/sessionid=([^;]+)/)?.[1] ?? '';
  const csrfToken = cookies.match(/csrftoken=([^;]+)/)?.[1] ?? csrfCookie;
  if (!sessionId) throw new Error('EFDS session cookie not found');
  return { csrfToken, cookie: `csrftoken=${csrfToken}; sessionid=${sessionId}` };
}

export async function fetchSenateIndex(
  firstName: string,
  lastName: string,
  fromYear: number,
  toYear: number,
): Promise<{ pages: any[]; refs: PtrRef[] }> {
  const session = await openSession();
  const pages: any[] = [];
  const refs: PtrRef[] = [];
  let start = 0;
  while (true) {
    const body = new URLSearchParams({
      start: String(start),
      length: '100',
      submitted_start_date: `01/01/${fromYear} 00:00:00`,
      submitted_end_date: `12/31/${toYear} 23:59:59`,
      first_name: firstName,
      last_name: lastName,
      senator_state: '',
      csrfmiddlewaretoken: session.csrfToken,
    });
    body.append('report_types[]', '11');
    body.append('filer_types[]', '1');
    const response = await fetch(`${BASE}/search/report/data/`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${BASE}/search/home/`,
        Cookie: session.cookie,
        'X-CSRFToken': session.csrfToken,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`EFDS search HTTP ${response.status}`);
    const payload = await response.json();
    pages.push(payload);
    const pageRefs = extractPtrRefs(payload);
    refs.push(...pageRefs);
    const rowCount = Array.isArray((payload as any).data) ? (payload as any).data.length : 0;
    if (rowCount < 100) break;
    start += 100;
  }
  return { pages, refs };
}

function parseArgs(argv: string[]) {
  const args = { first: '', last: '', bioguide: '', fromYear: 2023, toYear: 2026, output: '' };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    const value = argv[++index] ?? '';
    if (key === '--first') args.first = value;
    else if (key === '--last') args.last = value;
    else if (key === '--bioguide') args.bioguide = value;
    else if (key === '--from-year') args.fromYear = Number(value);
    else if (key === '--to-year') args.toYear = Number(value);
    else if (key === '--output') args.output = value;
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!args.first || !args.last || !args.bioguide || !args.output) {
    throw new Error('required: --first, --last, --bioguide, --output');
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await fetchSenateIndex(args.first, args.last, args.fromYear, args.toYear);
  const evidence = {
    source: `${BASE}/search/report/data/`,
    retrievedAt: new Date().toISOString(),
    query: {
      bioguide: args.bioguide,
      firstName: args.first,
      lastName: args.last,
      fromYear: args.fromYear,
      toYear: args.toYear,
      reportType: 11,
      filerType: 1,
    },
    ptrCount: result.refs.length,
    refs: result.refs,
    rawPages: result.pages,
  };
  writeFileSync(resolve(args.output), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`${args.bioguide} ${args.first} ${args.last}: ${result.refs.length} PTR(s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
