/**
 * Builds the static site from ingest output.
 *
 * Everything is pre-rendered HTML plus one JSON index for client-side search.
 * No server, no database, no per-request cost — the whole point is that this
 * runs itself on a schedule and costs nothing to operate.
 *
 *   npx tsx ventures/govcon/build-site.ts [--data <dir>] [--out <dir>]
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Opportunity } from './ingest.ts';
import { STATES, PROGRAMS, programSlug, sectorName, slugify, NAICS_SECTORS } from './taxonomy.ts';

export const SITE_NAME = 'SetAside';
export const TAGLINE = 'Open federal contracts set aside for small business';

/**
 * Where the alert signup posts. Null until an email provider is connected, in
 * which case the page says alerts are coming rather than rendering a form that
 * silently drops addresses.
 */
export const ALERTS_ENDPOINT: string | null = null;

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function daysUntil(deadline: string, now: number): number {
  return Math.ceil((Date.parse(deadline) - now) / 864e5);
}

export function formatDeadline(deadline: string, now: number): { text: string; urgency: string } {
  const d = daysUntil(deadline, now);
  if (d <= 1) return { text: 'Closes today or tomorrow', urgency: 'now' };
  if (d <= 7) return { text: `${d} days left`, urgency: 'soon' };
  if (d <= 30) return { text: `${d} days left`, urgency: 'ok' };
  return { text: `${d} days left`, urgency: 'far' };
}

const CSS = `
:root{--bg:#fff;--fg:#14171a;--muted:#5b6670;--line:#e3e7ea;--card:#fff;
--accent:#0b5c46;--accent-fg:#fff;--now:#b0180f;--soon:#9a5b00;--chip:#f2f5f7;}
@media(prefers-color-scheme:dark){:root{--bg:#0f1214;--fg:#e9edf0;--muted:#98a4ae;
--line:#242a2f;--card:#161a1d;--accent:#3ddba4;--accent-fg:#06231a;--now:#ff8178;
--soon:#f0b352;--chip:#1d2226;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%}
.wrap{max-width:960px;margin:0 auto;padding:0 16px}
header{border-bottom:1px solid var(--line);padding:14px 0}
header .wrap{display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
.brand{font-weight:700;font-size:19px;color:var(--fg);text-decoration:none;letter-spacing:-.01em}
.brand span{color:var(--accent)}
nav{margin-left:auto;display:flex;gap:14px;flex-wrap:wrap}
nav a{color:var(--muted);text-decoration:none;font-size:14px}
nav a:hover{color:var(--fg)}
h1{font-size:28px;line-height:1.2;letter-spacing:-.02em;margin:28px 0 8px}
h2{font-size:19px;margin:32px 0 10px;letter-spacing:-.01em}
.lede{color:var(--muted);margin:0 0 20px;max-width:62ch}
.count{font-variant-numeric:tabular-nums;font-weight:600}
.controls{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}
input[type=search],select{font:inherit;padding:9px 11px;border:1px solid var(--line);
border-radius:8px;background:var(--card);color:var(--fg);min-width:0}
input[type=search]{flex:1 1 260px}
.card{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0;background:var(--card)}
.card h3{margin:0 0 6px;font-size:16px;line-height:1.35}
.card h3 a{color:var(--fg);text-decoration:none}
.card h3 a:hover{text-decoration:underline;text-decoration-color:var(--accent)}
.meta{color:var(--muted);font-size:13.5px;margin:0 0 8px}
.desc{color:var(--muted);font-size:14px;margin:8px 0 0}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}
.chip{font-size:12px;padding:3px 8px;border-radius:999px;background:var(--chip);color:var(--muted);text-decoration:none}
a.chip:hover{color:var(--fg)}
.dl{font-weight:600}
.dl.now{color:var(--now)}.dl.soon{color:var(--soon)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px;margin:12px 0}
.grid a{border:1px solid var(--line);border-radius:8px;padding:9px 11px;text-decoration:none;color:var(--fg);font-size:14px;background:var(--card)}
.grid a:hover{border-color:var(--accent)}
.grid a b{font-variant-numeric:tabular-nums;color:var(--muted);font-weight:500;float:right}
.note{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;
padding:12px 14px;margin:24px 0;background:var(--card);font-size:14.5px;color:var(--muted)}
footer{border-top:1px solid var(--line);margin-top:48px;padding:20px 0 40px;color:var(--muted);font-size:13.5px}
footer a{color:var(--muted)}
.empty{color:var(--muted);padding:24px 0}
`;

interface PageOpts { title: string; desc: string; canonical: string; body: string; now: number }

function layout({ title, desc, canonical, body, now }: PageOpts): string {
  const updated = new Date(now).toISOString().slice(0, 16).replace('T', ' ');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="stylesheet" href="/style.css">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
</head><body>
<header><div class="wrap">
<a class="brand" href="/">Set<span>Aside</span></a>
<nav>
<a href="/program/small-business/">Small business</a>
<a href="/program/sdvosb/">SDVOSB</a>
<a href="/program/wosb/">WOSB</a>
<a href="/program/8a/">8(a)</a>
<a href="/program/hubzone/">HUBZone</a>
<a href="/about/">About</a>
</nav></div></header>
<main class="wrap">${body}</main>
<footer><div class="wrap">
<p><strong>${SITE_NAME}</strong> — ${TAGLINE}. Rebuilt daily from the
<a href="https://sam.gov/data-services" rel="noopener">SAM.gov Contract Opportunities public extract</a>.
Last updated ${updated} UTC.</p>
<p>Not affiliated with SAM.gov, the SBA or any federal agency. Always confirm
details against the official notice before bidding — SAM.gov is authoritative,
this is a faster way to find things in it.</p>
</div></footer>
</body></html>`;
}

function card(o: Opportunity, now: number, showDesc: boolean): string {
  const { text, urgency } = formatDeadline(o.deadline, now);
  const sector = sectorName(o.naics);
  const where = o.popState && STATES[o.popState]
    ? `${o.popCity ? `${esc(o.popCity)}, ` : ''}${esc(o.popState)}`
    : 'Location not specified';
  const prog = programSlug(o.setAsideCode, o.setAside);
  const p = PROGRAMS.find((x) => x.slug === prog);
  return `<article class="card">
<h3><a href="${esc(o.link)}" rel="noopener">${esc(o.title)}</a></h3>
<p class="meta">${esc(o.agency)}${o.subTier && o.subTier !== o.agency ? ` · ${esc(o.subTier)}` : ''}
 · ${where} · <span class="dl ${urgency}">${esc(text)}</span></p>
${showDesc && o.description ? `<p class="desc">${esc(o.description.slice(0, 260))}${o.description.length > 260 ? '…' : ''}</p>` : ''}
<div class="chips">
${p ? `<a class="chip" href="/program/${p.slug}/">${esc(p.short)}</a>` : ''}
${o.naics ? `<a class="chip" href="/sector/${o.naics.slice(0, 2)}/">NAICS ${esc(o.naics)}${sector ? ` · ${esc(sector)}` : ''}</a>` : ''}
${o.popState && STATES[o.popState] ? `<a class="chip" href="/state/${slugify(STATES[o.popState])}/">${esc(STATES[o.popState])}</a>` : ''}
<span class="chip">${esc(o.type)}</span>
</div></article>`;
}

function listPage(heading: string, lede: string, items: Opportunity[], now: number, extra = ''): string {
  const body = items.length
    ? items.map((o) => card(o, now, true)).join('\n')
    : '<p class="empty">Nothing open here right now. This page rebuilds every day — check back, or browse another category above.</p>';
  return `<h1>${esc(heading)}</h1><p class="lede">${lede}</p>${extra}
<p class="meta"><span class="count">${items.length}</span> open ${items.length === 1 ? 'opportunity' : 'opportunities'}, soonest deadline first.</p>
${body}`;
}

const ALERTS_NOTE = `<div class="note">
<strong>Want these by email?</strong> Daily alerts for your NAICS codes and state
are coming. The data here is free and always will be.
</div>`;

function write(outDir: string, rel: string, content: string): void {
  const p = join(outDir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export interface BuildResult { pages: number; opportunities: number; urls: string[] }

export function buildSite(data: Opportunity[], outDir: string, now: number, origin: string): BuildResult {
  const urls: string[] = [];
  const page = (rel: string, opts: Omit<PageOpts, 'now'>): void => {
    write(outDir, rel, layout({ ...opts, now }));
    urls.push(opts.canonical);
  };

  // ---- facets -------------------------------------------------------------
  const byProgram = new Map<string, Opportunity[]>();
  const byState = new Map<string, Opportunity[]>();
  const bySector = new Map<string, Opportunity[]>();
  for (const o of data) {
    const p = programSlug(o.setAsideCode, o.setAside);
    if (p) (byProgram.get(p) ?? byProgram.set(p, []).get(p)!).push(o);
    if (o.popState && STATES[o.popState]) (byState.get(o.popState) ?? byState.set(o.popState, []).get(o.popState)!).push(o);
    const s = o.naics.slice(0, 2);
    if (s && NAICS_SECTORS[s]) (bySector.get(s) ?? bySector.set(s, []).get(s)!).push(o);
  }

  // ---- home ---------------------------------------------------------------
  const programGrid = PROGRAMS.map((p) => {
    const n = byProgram.get(p.slug)?.length ?? 0;
    return `<a href="/program/${p.slug}/">${esc(p.short)}<b>${n}</b></a>`;
  }).join('');
  const stateGrid = [...byState.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 24)
    .map(([k, v]) => `<a href="/state/${slugify(STATES[k])}/">${esc(STATES[k])}<b>${v.length}</b></a>`).join('');
  const sectorGrid = [...bySector.entries()].sort((a, b) => b[1].length - a[1].length)
    .map(([k, v]) => `<a href="/sector/${k}/">${esc(NAICS_SECTORS[k])}<b>${v.length}</b></a>`).join('');

  page('index.html', {
    title: `${SITE_NAME} — ${TAGLINE}`,
    desc: `Search ${data.length} open federal contract opportunities set aside for small business. Filter by NAICS, state and set-aside program. Free, updated daily from SAM.gov.`,
    canonical: `${origin}/`,
    body: `<h1>Every open federal contract set aside for small business</h1>
<p class="lede">${data.length} live opportunities, sorted by how soon they close.
Filter by what you do and where you are. Free, rebuilt every day from the official
SAM.gov extract.</p>
<div class="controls">
<input type="search" id="q" placeholder="Search titles, agencies, descriptions…" aria-label="Search opportunities">
<select id="program" aria-label="Set-aside program"><option value="">Any set-aside</option>
${PROGRAMS.map((p) => `<option value="${p.slug}">${esc(p.short)}</option>`).join('')}</select>
<select id="state" aria-label="State"><option value="">Any state</option>
${[...byState.keys()].sort((a, b) => STATES[a].localeCompare(STATES[b])).map((k) => `<option value="${k}">${esc(STATES[k])}</option>`).join('')}</select>
<select id="sector" aria-label="Industry sector"><option value="">Any industry</option>
${[...bySector.keys()].sort().map((k) => `<option value="${k}">${esc(NAICS_SECTORS[k])}</option>`).join('')}</select>
</div>
<p class="meta"><span class="count" id="n">${data.length}</span> matching, soonest deadline first.</p>
<div id="results">${data.slice(0, 40).map((o) => card(o, now, true)).join('\n')}</div>
<p class="empty" id="more">Showing the 40 closest deadlines. Search or filter to narrow, or browse by category below.</p>
${ALERTS_NOTE}
<h2>By set-aside program</h2><div class="grid">${programGrid}</div>
<h2>By industry</h2><div class="grid">${sectorGrid}</div>
<h2>By place of performance</h2><div class="grid">${stateGrid}</div>
<p class="meta"><a href="/state/">All states →</a></p>
<script src="/search.js" defer></script>`,
  });

  // ---- program pages + program × state ------------------------------------
  for (const p of PROGRAMS) {
    const items = byProgram.get(p.slug) ?? [];
    const statesFor = new Map<string, Opportunity[]>();
    for (const o of items) {
      if (o.popState && STATES[o.popState]) (statesFor.get(o.popState) ?? statesFor.set(o.popState, []).get(o.popState)!).push(o);
    }
    // Only link cross-pages with enough substance to be worth a page of their own.
    const worth = [...statesFor.entries()].filter(([, v]) => v.length >= 3)
      .sort((a, b) => b[1].length - a[1].length);
    const grid = worth.length
      ? `<h2>${esc(p.short)} by state</h2><div class="grid">${worth
          .map(([k, v]) => `<a href="/program/${p.slug}/${slugify(STATES[k])}/">${esc(STATES[k])}<b>${v.length}</b></a>`).join('')}</div>`
      : '';

    page(`program/${p.slug}/index.html`, {
      title: `${p.name} contract opportunities — ${SITE_NAME}`,
      desc: `${items.length} open federal contracts set aside under the ${p.name} program. Updated daily from SAM.gov.`,
      canonical: `${origin}/program/${p.slug}/`,
      body: listPage(`${p.name} opportunities`, `${esc(p.blurb)}`, items.slice(0, 120), now, ALERTS_NOTE) + grid,
    });

    for (const [st, v] of worth) {
      page(`program/${p.slug}/${slugify(STATES[st])}/index.html`, {
        title: `${p.short} contracts in ${STATES[st]} — ${SITE_NAME}`,
        desc: `${v.length} open ${p.name} contract opportunities with work performed in ${STATES[st]}. Updated daily from SAM.gov.`,
        canonical: `${origin}/program/${p.slug}/${slugify(STATES[st])}/`,
        body: listPage(`${p.short} contracts in ${STATES[st]}`,
          `Open federal contracts set aside under the ${esc(p.name)} program, with the work performed in ${esc(STATES[st])}.`,
          v.slice(0, 120), now, ALERTS_NOTE),
      });
    }
  }

  // ---- state pages --------------------------------------------------------
  for (const [st, items] of byState) {
    page(`state/${slugify(STATES[st])}/index.html`, {
      title: `Small business federal contracts in ${STATES[st]} — ${SITE_NAME}`,
      desc: `${items.length} open federal contract opportunities set aside for small business, performed in ${STATES[st]}. Updated daily from SAM.gov.`,
      canonical: `${origin}/state/${slugify(STATES[st])}/`,
      body: listPage(`Small business set-aside contracts in ${STATES[st]}`,
        `Open federal contract opportunities reserved for small business, with the place of performance in ${esc(STATES[st])}.`,
        items.slice(0, 120), now, ALERTS_NOTE),
    });
  }

  page('state/index.html', {
    title: `Small business federal contracts by state — ${SITE_NAME}`,
    desc: 'Browse open federal contract opportunities set aside for small business, by place of performance.',
    canonical: `${origin}/state/`,
    body: `<h1>By place of performance</h1><p class="lede">Where the work happens, not where the contracting office sits.</p>
<div class="grid">${[...byState.entries()].sort((a, b) => STATES[a[0]].localeCompare(STATES[b[0]]))
      .map(([k, v]) => `<a href="/state/${slugify(STATES[k])}/">${esc(STATES[k])}<b>${v.length}</b></a>`).join('')}</div>`,
  });

  // ---- sector pages -------------------------------------------------------
  for (const [code, items] of bySector) {
    const name = NAICS_SECTORS[code];
    page(`sector/${code}/index.html`, {
      title: `${name} federal contracts for small business — ${SITE_NAME}`,
      desc: `${items.length} open small business set-aside federal contracts in ${name} (NAICS ${code}). Updated daily from SAM.gov.`,
      canonical: `${origin}/sector/${code}/`,
      body: listPage(`${name} (NAICS ${code})`,
        `Open small business set-aside federal contract opportunities in ${esc(name)}.`,
        items.slice(0, 120), now, ALERTS_NOTE),
    });
  }

  // ---- about --------------------------------------------------------------
  page('about/index.html', {
    title: `About — ${SITE_NAME}`,
    desc: 'How SetAside is built, where the data comes from, and what it does not do.',
    canonical: `${origin}/about/`,
    body: `<h1>About ${SITE_NAME}</h1>
<p class="lede">${TAGLINE}.</p>
<h2>Where the data comes from</h2>
<p>Every notice here comes from the official SAM.gov Contract Opportunities public
data extract, which the General Services Administration publishes for exactly this
purpose. Nothing is scraped and nothing is inferred.</p>
<h2>What gets shown</h2>
<p>A notice appears only if all of the following are true: it is active, its
response deadline has not passed, it is a type a bidder can act on
(solicitation, combined synopsis, presolicitation, sources sought or special
notice), and it carries a real set-aside. That filters the full extract down to
the <strong>${data.length}</strong> notices on this site, sorted by how soon they
close.</p>
<h2>What this is not</h2>
<p>It is not affiliated with SAM.gov, the SBA or any federal agency, and it is not
a substitute for the official notice. Deadlines and terms change; SAM.gov is
authoritative. This exists because finding the right notice in SAM.gov is harder
than it should be, and the tools that fix that start at several hundred dollars a
month.</p>
<h2>Cost</h2>
<p>The search is free and stays free. If email alerts happen later, they will be
the paid part — not a paywall over data the government already publishes.</p>`,
  });

  write(outDir, '404.html', layout({
    title: `Not found — ${SITE_NAME}`, desc: 'Page not found.', canonical: `${origin}/404.html`, now,
    body: '<h1>Not found</h1><p class="lede">That page moved or the opportunity closed. Opportunities come off the site the moment their deadline passes.</p><p><a href="/">Back to search →</a></p>',
  }));

  // ---- assets -------------------------------------------------------------
  write(outDir, 'style.css', CSS);
  write(outDir, 'robots.txt', `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
  write(outDir, 'sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
      urls.map((u) => `<url><loc>${esc(u)}</loc><lastmod>${new Date(now).toISOString().slice(0, 10)}</lastmod></url>`).join('\n')
    }\n</urlset>\n`);

  // Slim index: descriptions are the bulk of the payload and the search page
  // matches on them only when present, so they are dropped from the index.
  const index = data.map((o) => ({
    t: o.title, a: o.agency, s: o.popState, c: o.popCity, n: o.naics,
    p: programSlug(o.setAsideCode, o.setAside) ?? '', d: o.deadline,
    l: o.link, y: o.type,
  }));
  write(outDir, 'search-index.json', JSON.stringify(index));
  write(outDir, 'search.js', SEARCH_JS);

  return { pages: urls.length, opportunities: data.length, urls };
}

const SEARCH_JS = `(function(){
var q=document.getElementById('q'),pr=document.getElementById('program'),
st=document.getElementById('state'),sc=document.getElementById('sector'),
out=document.getElementById('results'),n=document.getElementById('n'),
more=document.getElementById('more'),rows=null,busy=false;
var STATES=${JSON.stringify(STATES)};
function esc(s){return String(s).replace(/[&<>"']/g,function(c){
return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function days(d){return Math.ceil((Date.parse(d)-Date.now())/864e5);}
function render(list){
  var html=list.slice(0,60).map(function(o){
    var dd=days(o.d),u=dd<=1?'now':dd<=7?'soon':dd<=30?'ok':'far';
    var txt=dd<=1?'Closes today or tomorrow':dd+' days left';
    var where=o.s&&STATES[o.s]?((o.c?esc(o.c)+', ':'')+esc(o.s)):'Location not specified';
    return '<article class="card"><h3><a href="'+esc(o.l)+'" rel="noopener">'+esc(o.t)+
      '</a></h3><p class="meta">'+esc(o.a)+' · '+where+' · <span class="dl '+u+'">'+txt+
      '</span></p><div class="chips">'+(o.n?'<span class="chip">NAICS '+esc(o.n)+'</span>':'')+
      '<span class="chip">'+esc(o.y)+'</span></div></article>';
  }).join('');
  out.innerHTML=html||'<p class="empty">Nothing matches. Try fewer filters.</p>';
  n.textContent=list.length;
  more.textContent=list.length>60?'Showing the 60 closest deadlines of '+list.length+'. Narrow further to see the rest.':'';
}
function apply(){
  if(!rows)return;
  var s=q.value.trim().toLowerCase(),p=pr.value,stv=st.value,scv=sc.value;
  var list=rows.filter(function(o){
    if(p&&o.p!==p)return false;
    if(stv&&o.s!==stv)return false;
    if(scv&&o.n.slice(0,2)!==scv)return false;
    if(s&&(o.t+' '+o.a+' '+o.n+' '+(o.c||'')).toLowerCase().indexOf(s)<0)return false;
    return true;
  });
  render(list);
}
function load(){
  if(rows||busy)return;busy=true;
  fetch('/search-index.json').then(function(r){return r.json();})
    .then(function(j){rows=j;busy=false;apply();})
    .catch(function(){busy=false;});
}
[q,pr,st,sc].forEach(function(el){
  if(!el)return;
  el.addEventListener('focus',load,{once:true});
  el.addEventListener('input',function(){load();apply();});
  el.addEventListener('change',function(){load();apply();});
});
})();`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const arg = (f: string, d: string): string => {
    const i = args.indexOf(f);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
  };
  const dataDir = arg('--data', join(process.cwd(), 'ventures/govcon/data'));
  const outDir = arg('--out', join(process.cwd(), 'ventures/govcon/site'));
  const origin = arg('--origin', 'https://example.github.io');

  const data: Opportunity[] = JSON.parse(readFileSync(join(dataDir, 'opportunities.json'), 'utf8'));
  const r = buildSite(data, outDir, Date.now(), origin);
  console.log(`built ${r.pages} pages from ${r.opportunities} opportunities → ${outDir}`);
  if (r.pages < 10) { console.error('suspiciously few pages — refusing to call this a success'); process.exit(1); }
}
