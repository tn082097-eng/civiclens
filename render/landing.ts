// Launch landing page — rendered from render/published-members.json, never
// from the database (ADR 0002 §C: every public artifact is a deterministic
// function of verified, committed inputs). The manifest is regenerated at
// package time by scripts/update-manifest.ts from the same DB snapshot as
// the verified member renders, so the landing always matches what ships.
//
// Editorial rules (binding): inventory numbers only — evidence volume, never
// detector flags, significance language, or corpus-wide claims. Party is
// text, not color. The no-causation line is load-bearing copy.
import { esc } from './build.js';

export interface PublishedMemberStats {
  trades: number;
  votes: number;
  sponsored: number;
  cosponsored: number;
  donors: number;
}

export interface PublishedMember {
  slug: string;
  name: string;
  party: string;
  chamber: string;
  state: string;
  stats: PublishedMemberStats;
  dataThrough: string | null; // YYYY-MM-DD
}

export interface PublishedManifest {
  members: PublishedMember[];
}

const STAT_LABELS: [keyof PublishedMemberStats, string][] = [
  ['trades', 'trades on record'],
  ['votes', 'floor votes'],
  ['sponsored', 'bills sponsored'],
  ['cosponsored', 'bills cosponsored'],
  ['donors', 'donor records'],
];

const LEDE =
  'CivicLens reconstructs what members of Congress did — trades, votes, ' +
  'sponsorships, and donors — from primary sources, and flags where the timing ' +
  'or the money lines up in ways that stand out from chance. Every flag is ' +
  'reproducible and links back to the filing it came from. It reports patterns, ' +
  'not verdicts.';

const BETA =
  'Single-member beta: one member is published end-to-end while every section ' +
  'of the methodology is validated. The roster expands as each member’s data ' +
  'passes the same verification.';

const NO_CAUSATION =
  'Detectors identify reproducible patterns in available data. They do not ' +
  'establish causation or statistical significance.';

function fmtInt(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`bad manifest count: ${n}`);
  return n.toLocaleString('en-US');
}

function chamberLabel(c: string): string {
  return c === 'house' ? 'House' : c === 'senate' ? 'Senate' : c;
}

function memberCard(m: PublishedMember): string {
  // slug lands unescaped in an href — restrict to the slug alphabet so no
  // manifest edit can ever smuggle markup or a foreign URL through it.
  if (!/^[a-z][a-z0-9-]*$/.test(m.slug)) throw new Error(`unsafe member slug: ${m.slug}`);
  if (m.dataThrough !== null && !/^\d{4}-\d{2}-\d{2}$/.test(m.dataThrough)) {
    throw new Error(`bad dataThrough for ${m.slug}: ${m.dataThrough}`);
  }
  const sub = [m.party, m.state, chamberLabel(m.chamber)].filter(Boolean).map(esc).join(' · ');
  const stats = STAT_LABELS.map(([key, label]) => `
      <div class="stat"><dd>${fmtInt(m.stats[key])}</dd><dt>${esc(label)}</dt></div>`).join('');
  const thru = m.dataThrough === null
    ? '<span></span>'
    : `<span>data through <span class="mono">${esc(m.dataThrough)}</span></span>`;
  return `
  <a class="card" href="members/${m.slug}.html">
    <h2>${esc(m.name)}</h2>
    <p class="sub">${sub}</p>
    <dl class="stats">${stats}
    </dl>
    <p class="thru">${thru}<span class="go">read the record &rarr;</span></p>
  </a>`;
}

export function renderLanding(manifest: PublishedManifest): string {
  if (!Array.isArray(manifest.members) || manifest.members.length === 0) {
    throw new Error('published-members manifest is empty — nothing to land on');
  }
  const n = manifest.members.length;
  const count = `${n} member${n === 1 ? '' : 's'}`;
  const cards = manifest.members.map(memberCard).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CivicLens</title>
<meta name="description" content="${esc(LEDE)}">
<style>
:root {
  --bg: #0d0e1a; --fg: #eceef8; --fg-dim: #9aa0bf; --fg-muted: #5d6280;
  --glass: rgba(236,238,248,0.045);
  --glass-line: rgba(236,238,248,0.12);
  --glass-hi: rgba(236,238,248,0.09);
}
* { box-sizing: border-box; }
body {
  margin: 0; color: var(--fg);
  background:
    radial-gradient(900px 600px at 12% -8%, rgba(124,108,255,0.17), transparent 62%),
    radial-gradient(760px 540px at 88% 12%, rgba(64,196,255,0.09), transparent 60%),
    radial-gradient(1000px 700px at 50% 108%, rgba(255,110,199,0.06), transparent 65%),
    var(--bg);
  background-attachment: fixed;
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  font-feature-settings: 'kern' 1;
  min-height: 100vh;
}
h1, h2, .wordmark, .motto {
  font-family: 'Charter', 'Source Serif 4', 'Iowan Old Style', Georgia, serif;
  font-weight: 600;
}
.mono, .stat dd, .count {
  font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums;
}
.frame { max-width: 880px; margin: 0 auto; padding: 0 24px 72px; }
.masthead {
  position: sticky; top: 12px; z-index: 10;
  display: flex; justify-content: space-between; align-items: baseline; gap: 16px;
  margin: 14px 0 0; padding: 14px 22px;
  background: rgba(13,14,26,0.55);
  backdrop-filter: blur(16px) saturate(1.3);
  -webkit-backdrop-filter: blur(16px) saturate(1.3);
  border: 1px solid var(--glass-line); border-radius: 14px;
  box-shadow: inset 0 1px 0 var(--glass-hi), 0 8px 24px rgba(0,0,0,0.3);
}
.wordmark { font-size: 16px; letter-spacing: 0.16em; text-transform: uppercase; }
.motto { color: var(--fg-dim); font-size: 14px; font-style: italic; font-weight: 400; }
.hero { padding: 82px 0 54px; }
.hero h1 {
  margin: 0 0 22px; font-size: clamp(34px, 6vw, 54px); line-height: 1.08;
  letter-spacing: -0.02em; max-width: 700px;
}
.standfirst { margin: 0; color: var(--fg-dim); font-size: 16px; max-width: 640px; }
.rulehead {
  display: flex; justify-content: space-between; align-items: baseline;
  border-top: 1px solid var(--glass-line); padding-top: 12px;
}
.label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--fg-dim); }
.count { font-size: 12px; color: var(--fg-muted); }
.beta { color: var(--fg-muted); font-size: 13px; max-width: 640px; margin: 12px 0 0; }
.card {
  display: block; border: 1px solid var(--glass-line); border-radius: 18px;
  padding: 28px 30px 20px; margin: 28px 0; color: inherit; text-decoration: none;
  background: linear-gradient(160deg, rgba(236,238,248,0.07), var(--glass) 45%, rgba(236,238,248,0.02));
  backdrop-filter: blur(18px) saturate(1.25);
  -webkit-backdrop-filter: blur(18px) saturate(1.25);
  box-shadow: inset 0 1px 0 var(--glass-hi), 0 12px 40px rgba(0,0,0,0.35);
  transition: border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
}
.card:hover {
  border-color: rgba(236,238,248,0.28); transform: translateY(-2px);
  box-shadow: inset 0 1px 0 var(--glass-hi), 0 18px 52px rgba(0,0,0,0.45);
}
.card h2 { margin: 0 0 3px; font-size: 27px; letter-spacing: -0.015em; }
.card .sub { margin: 0 0 24px; color: var(--fg-dim); font-size: 13px; }
.stats {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(122px, 1fr));
  gap: 18px 24px; margin: 0;
}
.stat dd { margin: 0; font-size: 26px; letter-spacing: -0.01em; }
.stat dt { margin: 6px 0 0; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--fg-dim); }
.thru {
  display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap;
  margin: 24px 0 0; padding-top: 14px; border-top: 1px solid var(--glass-line);
  color: var(--fg-muted); font-size: 12px;
}
.go { color: var(--fg-dim); transition: color 0.18s ease; }
.card:hover .go { color: var(--fg); }
.method {
  margin-top: 40px; padding: 18px 22px; font-size: 14px;
  background: var(--glass); border: 1px solid var(--glass-line); border-radius: 14px;
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  box-shadow: inset 0 1px 0 var(--glass-hi);
}
.method a { color: var(--fg); text-decoration: underline; text-decoration-color: var(--fg-muted); text-underline-offset: 3px; }
.method a:hover { text-decoration-color: var(--fg); }
.method .dim { color: var(--fg-muted); }
footer {
  border-top: 1px solid var(--glass-line); margin-top: 44px; padding-top: 18px;
  color: var(--fg-muted); font-size: 13px; max-width: 640px;
}
.hero, .published, .method, footer { animation: rise 0.5s ease both; }
.published { animation-delay: 0.08s; }
.method { animation-delay: 0.16s; }
footer { animation-delay: 0.22s; }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .hero, .published, .method, footer { animation: none; } }
</style>
</head>
<body>
<div class="frame">
  <header class="masthead">
    <span class="wordmark">CivicLens</span>
    <span class="motto">Patterns, not verdicts.</span>
  </header>
  <section class="hero">
    <h1>The congressional paper trail, reconstructed.</h1>
    <p class="standfirst">${esc(LEDE)}</p>
  </section>
  <section class="published">
    <div class="rulehead">
      <span class="label">Published record</span>
      <span class="count">${esc(count)}</span>
    </div>
    <p class="beta">${esc(BETA)}</p>
${cards}
  </section>
  <section class="method">
    <a href="methodology.html">Methodology</a>
    <span class="dim">— how flags are scored, sources, what the numbers don&rsquo;t claim.</span>
  </section>
  <footer>${esc(NO_CAUSATION)}</footer>
</div>
</body>
</html>
`;
}
