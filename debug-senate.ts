const UA = 'CivicLens/1.0 (public interest research; civiclens.org)';
const BASE = 'https://efdsearch.senate.gov';

async function getSession() {
  const r1 = await fetch(`${BASE}/search/home/`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
  const html1 = await r1.text();
  const csrf1 = html1.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/)?.[1];
  console.log('CSRF found:', !!csrf1, csrf1?.slice(0,20));
  const setCookie1 = r1.headers.get('set-cookie') ?? '';
  const csrfCookie = setCookie1.match(/csrftoken=([^;]+)/)?.[1] ?? csrf1!;
  const body = new URLSearchParams({ csrfmiddlewaretoken: csrf1!, prohibition_agreement: '1' });
  const r2 = await fetch(`${BASE}/search/home/`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${BASE}/search/home/`, 'Cookie': `csrftoken=${csrfCookie}` },
    body: body.toString(), redirect: 'manual', signal: AbortSignal.timeout(20_000),
  });
  console.log('Disclaimer POST status:', r2.status);
  const setCookie2 = r2.headers.get('set-cookie') ?? '';
  const sessionId = setCookie2.match(/sessionid=([^;]+)/)?.[1] ?? '';
  const csrfFinal = setCookie2.match(/csrftoken=([^;]+)/)?.[1] ?? csrfCookie;
  console.log('Session ID found:', !!sessionId);
  return { csrfToken: csrfFinal, cookie: `csrftoken=${csrfFinal}${sessionId ? `; sessionid=${sessionId}` : ''}` };
}

async function search(session: any, firstName: string, lastName: string) {
  const body = new URLSearchParams({
    start: '0', length: '10',
    submitted_start_date: '01/01/2012 00:00:00',
    submitted_end_date: '',
    first_name: firstName, last_name: lastName, senator_state: '',
    csrfmiddlewaretoken: session.csrfToken,
  });
  body.append('report_types[]', '11');
  body.append('filer_types[]', '1');
  const r = await fetch(`${BASE}/search/report/data/`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${BASE}/search/home/`, 'Cookie': session.cookie, 'X-CSRFToken': session.csrfToken },
    body: body.toString(), signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  try {
    const d = JSON.parse(text);
    return d;
  } catch {
    console.log('Non-JSON response (first 200):', text.slice(0,200));
    return null;
  }
}

async function main() {
  const session = await getSession();
  for (const [fn, ln] of [['Susan', 'Collins'], ['', 'Collins'], ['Ted', 'Cruz'], ['', 'Cruz']] as [string,string][]) {
    await new Promise(r => setTimeout(r, 800));
    const d = await search(session, fn, ln);
    if (d) console.log(`"${fn}" "${ln}": total=${d.recordsTotal ?? '?'}, rows=${d.data?.length ?? 0}, result=${d.result}`);
    if (d?.data?.length > 0) console.log('  first:', JSON.stringify(d.data[0]).slice(0,150));
  }
}
main().catch(console.error);
