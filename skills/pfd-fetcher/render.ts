/**
 * PFD trades dashboard renderer.
 *
 * Reads every `<...>.json` PTR record under a year's pfd-cache, flattens
 * them into one row-per-transaction, and writes a single self-contained
 * HTML page with a sortable + filterable table. No server, no network.
 *
 * Usage:
 *   npx tsx skills/pfd-fetcher/render.ts pfd-cache/2024 pfd-trades-2024.html
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';

interface Tx {
  filerName: string;
  filerStateDistrict: string;
  filingId: string;
  signedAt: string | null;
  holder: string;
  asset: string;
  ticker: string | null;
  assetType: string | null;
  subholding: string | null;
  location: string | null;
  type: string;
  date: string;
  notificationDate: string;
  amountBand: string;
  filingStatus: string;
  description: string;
}

function loadAll(dir: string): Tx[] {
  const out: Tx[] = [];
  for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) {
    const r = JSON.parse(readFileSync(resolve(dir, f), 'utf-8'));
    if (r.source !== 'house-clerk-ptr') continue;
    for (const tx of r.transactions ?? []) {
      out.push({
        filerName: r.filer?.name ?? '',
        filerStateDistrict: r.filer?.stateDistrict ?? '',
        filingId: r.filingId ?? '',
        signedAt: r.signedAt ?? null,
        holder: tx.holder, asset: tx.asset, ticker: tx.ticker,
        assetType: tx.assetType, subholding: tx.subholding ?? null,
        location: tx.location ?? null, type: tx.type,
        date: tx.date, notificationDate: tx.notificationDate,
        amountBand: tx.amountBand, filingStatus: tx.filingStatus,
        description: tx.description,
      });
    }
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}

function renderHtml(rows: Tx[], dir: string): string {
  const filers = [...new Set(rows.map(r => r.filerName))].sort();
  const types  = [...new Set(rows.map(r => r.type))].sort();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>CivicLens — House PFD Trades</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --ink:#1a1a1a; --muted:#6c757d; --bg:#f8f9fa; --card:#fff; --accent:#0d6efd; --rule:#e6e8eb; --self:#fef3c7; --spouse:#dbeafe; }
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--ink); margin: 0; line-height: 1.45; }
  header { background: var(--card); border-bottom: 1px solid var(--rule); padding: 24px 32px; }
  h1 { margin: 0 0 4px 0; font-size: 1.4rem; font-weight: 600; }
  .sub { color: var(--muted); font-size: 0.92rem; }
  .meta { display: flex; gap: 24px; margin-top: 16px; flex-wrap: wrap; font-size: 0.88rem; }
  .meta b { color: var(--ink); }
  main { padding: 24px 32px; }
  .controls { background: var(--card); border: 1px solid var(--rule); border-radius: 8px; padding: 16px; margin-bottom: 16px; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .controls label { font-size: 0.85rem; color: var(--muted); display: flex; flex-direction: column; gap: 4px; }
  .controls input, .controls select { padding: 6px 10px; border: 1px solid var(--rule); border-radius: 6px; font: inherit; min-width: 180px; }
  .controls input[type="search"] { min-width: 280px; }
  .summary { font-size: 0.85rem; color: var(--muted); margin-left: auto; }
  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; font-size: 0.88rem; }
  thead th { background: #fbfbfb; padding: 10px 12px; text-align: left; font-weight: 600; border-bottom: 1px solid var(--rule); cursor: pointer; user-select: none; white-space: nowrap; position: sticky; top: 0; }
  thead th:hover { background: #f0f1f3; }
  thead th .arrow { color: var(--muted); margin-left: 4px; font-size: 0.75rem; }
  tbody td { padding: 8px 12px; border-bottom: 1px solid #f1f2f4; vertical-align: top; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: #fafbfc; }
  .holder-self   { background: var(--self); padding: 1px 6px; border-radius: 4px; font-size: 0.8rem; }
  .holder-spouse { background: var(--spouse); padding: 1px 6px; border-radius: 4px; font-size: 0.8rem; }
  .holder-joint, .holder-dependent-child { background: #e0e7ff; padding: 1px 6px; border-radius: 4px; font-size: 0.8rem; }
  .ticker { font-family: ui-monospace, SFMono-Regular, monospace; font-weight: 600; }
  .type-purchase    { color: #166534; font-weight: 500; }
  .type-sale, .type-sale-partial { color: #991b1b; font-weight: 500; }
  .desc { color: var(--muted); font-size: 0.82rem; max-width: 340px; }
  .amount { font-variant-numeric: tabular-nums; white-space: nowrap; }
  footer { padding: 24px 32px; color: var(--muted); font-size: 0.82rem; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>CivicLens — House PFD Periodic Transaction Reports</h1>
  <div class="sub">Source: <a href="https://disclosures-clerk.house.gov" target="_blank" rel="noopener">disclosures-clerk.house.gov</a> · extracted from <code>${escape(dir)}</code></div>
  <div class="meta">
    <span><b>${rows.length}</b> transactions</span>
    <span><b>${filers.length}</b> filer${filers.length === 1 ? '' : 's'}</span>
    <span>Date range: <b>${escape(rows.at(-1)?.date ?? '—')}</b> → <b>${escape(rows[0]?.date ?? '—')}</b></span>
    <span>Generated <b>${new Date().toISOString().slice(0,10)}</b></span>
  </div>
</header>
<main>
  <div class="controls">
    <label>Search<input type="search" id="q" placeholder="asset, ticker, description, IRA…"></label>
    <label>Filer
      <select id="filer">
        <option value="">All filers</option>
        ${filers.map(f => `<option value="${escape(f)}">${escape(f)}</option>`).join('')}
      </select>
    </label>
    <label>Holder
      <select id="holder">
        <option value="">All holders</option>
        <option value="self">Self</option>
        <option value="spouse">Spouse</option>
        <option value="joint">Joint</option>
        <option value="dependent-child">Dependent child</option>
      </select>
    </label>
    <label>Type
      <select id="type">
        <option value="">All types</option>
        ${types.map(t => `<option value="${escape(t)}">${escape(t)}</option>`).join('')}
      </select>
    </label>
    <span class="summary" id="summary">Showing all ${rows.length}</span>
  </div>
  <table id="t">
    <thead>
      <tr>
        <th data-key="date">Date <span class="arrow"></span></th>
        <th data-key="filerName">Filer <span class="arrow"></span></th>
        <th data-key="holder">Holder <span class="arrow"></span></th>
        <th data-key="ticker">Ticker <span class="arrow"></span></th>
        <th data-key="asset">Asset <span class="arrow"></span></th>
        <th data-key="type">Type <span class="arrow"></span></th>
        <th data-key="amountBand">Amount <span class="arrow"></span></th>
        <th data-key="description">Description / Account</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
</main>
<footer>
  Disclosure data is public. Amount bands are STOCK Act ranges, never exact values. Spouse/dependent-child holdings are disclosed by law and labeled accordingly. Cross-reference with Senate eFD, OGE 278, and judicial AO-10 is not yet implemented.
</footer>
<script>
  const ROWS = ${JSON.stringify(rows)};
  const tbody = document.getElementById('tbody');
  const q = document.getElementById('q');
  const filerSel = document.getElementById('filer');
  const holderSel = document.getElementById('holder');
  const typeSel = document.getElementById('type');
  const summary = document.getElementById('summary');
  let sortKey = 'date', sortDir = -1;

  // Build rows via DOM API + textContent — never innerHTML on row data —
  // so any free-form filer text (asset, description) cannot inject markup.
  function makeRow(r) {
    const tr = document.createElement('tr');

    const tdDate = document.createElement('td');
    tdDate.textContent = r.date;
    tr.appendChild(tdDate);

    const tdFiler = document.createElement('td');
    tdFiler.textContent = r.filerName.replace(/^Hon\\.\\s+/, '');
    if (r.filerStateDistrict) {
      const sd = document.createElement('div');
      sd.style.color = 'var(--muted)';
      sd.style.fontSize = '0.78rem';
      sd.textContent = r.filerStateDistrict;
      tdFiler.appendChild(sd);
    }
    tr.appendChild(tdFiler);

    const tdHolder = document.createElement('td');
    const holderSpan = document.createElement('span');
    holderSpan.className = 'holder-' + r.holder;
    holderSpan.textContent = r.holder;
    tdHolder.appendChild(holderSpan);
    tr.appendChild(tdHolder);

    const tdTicker = document.createElement('td');
    tdTicker.className = 'ticker';
    if (r.ticker) tdTicker.textContent = r.ticker;
    else { const m = document.createElement('span'); m.style.color = 'var(--muted)'; m.textContent = '—'; tdTicker.appendChild(m); }
    tr.appendChild(tdTicker);

    const tdAsset = document.createElement('td');
    tdAsset.textContent = r.asset;
    if (r.assetType) {
      const at = document.createElement('span');
      at.style.color = 'var(--muted)';
      at.style.fontSize = '0.78rem';
      at.textContent = ' [' + r.assetType + ']';
      tdAsset.appendChild(at);
    }
    tr.appendChild(tdAsset);

    const tdType = document.createElement('td');
    tdType.className = 'type-' + r.type;
    tdType.textContent = r.type;
    tr.appendChild(tdType);

    const tdAmount = document.createElement('td');
    tdAmount.className = 'amount';
    tdAmount.textContent = r.amountBand;
    tr.appendChild(tdAmount);

    const tdDesc = document.createElement('td');
    tdDesc.className = 'desc';
    tdDesc.textContent = r.description;
    if (r.subholding) {
      const acct = document.createElement('div');
      acct.style.fontStyle = 'italic';
      acct.textContent = 'account: ' + r.subholding + (r.location ? ' · ' + r.location : '');
      tdDesc.appendChild(acct);
    }
    tr.appendChild(tdDesc);

    return tr;
  }

  function render() {
    const qv = q.value.toLowerCase().trim();
    const filerV = filerSel.value, holderV = holderSel.value, typeV = typeSel.value;
    let view = ROWS.filter(r => {
      if (filerV && r.filerName !== filerV) return false;
      if (holderV && r.holder !== holderV) return false;
      if (typeV && r.type !== typeV) return false;
      if (qv) {
        const hay = [r.asset, r.ticker, r.description, r.subholding, r.assetType].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(qv)) return false;
      }
      return true;
    });
    view.sort((a, b) => {
      const av = a[sortKey] ?? '', bv = b[sortKey] ?? '';
      if (av < bv) return -1 * sortDir;
      if (av > bv) return  1 * sortDir;
      return 0;
    });
    summary.textContent = view.length === ROWS.length
      ? \`Showing all \${ROWS.length}\`
      : \`Showing \${view.length} of \${ROWS.length}\`;
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    const frag = document.createDocumentFragment();
    for (const r of view) frag.appendChild(makeRow(r));
    tbody.appendChild(frag);
    document.querySelectorAll('th .arrow').forEach(el => el.textContent = '');
    const active = document.querySelector(\`th[data-key="\${sortKey}"] .arrow\`);
    if (active) active.textContent = sortDir === 1 ? '▲' : '▼';
  }
  document.querySelectorAll('th[data-key]').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.key;
      if (sortKey === k) sortDir *= -1;
      else { sortKey = k; sortDir = 1; }
      render();
    });
  });
  for (const el of [q, filerSel, holderSel, typeSel]) el.addEventListener('input', render);
  render();
</script>
</body>
</html>
`;
}

function main() {
  const [, , dirArg, outArg] = process.argv;
  if (!dirArg || !outArg) {
    console.error('Usage: render.ts <pfd-cache-year-dir> <output.html>');
    process.exit(1);
  }
  const dir = resolve(process.cwd(), dirArg);
  const out = resolve(process.cwd(), outArg);
  const rows = loadAll(dir);
  if (rows.length === 0) {
    console.error(`no PTR JSON found in ${dir}; run extract.ts first`);
    process.exit(1);
  }
  writeFileSync(out, renderHtml(rows, basename(dir)));
  console.log(`Wrote ${rows.length} transactions → ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
