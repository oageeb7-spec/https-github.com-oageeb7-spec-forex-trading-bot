import { $, esc, num, pct, usd, ago } from '../ui.js';
import { drawFan } from '../charts.js';

let root, highlight = null, last;

const REASONS = [['oos', 'Out-of-sample'], ['robust', 'Settings ±20%'], ['transfer', 'Other pair'], ['cost', '3× spread'], ['months', 'Monthly consistency']];

function stats(s) {
  const c = s.counts, v = s.variants;
  const passed = v.filter((x) => x.passed === true).length;
  const med = [...v.map((x) => x.sharpe)].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
  const best = Math.max(0, ...v.map((x) => x.sharpe));
  const k = (l, val, n) => `<div class="kpi"><div class="lbl">${l}</div><div class="v">${val}</div><div class="n">${n}</div></div>`;
  return k('Variants tested', num(c.variants), `${num(c.tested)} recipes × 10`)
    + k('In queue', num(s.queues.toLab), 'recipes waiting')
    + k('Passed lab', num(c.sieved), pct(c.sieved / Math.max(1, c.tested), 0) + ' of recipes')
    + k('Validated', num(c.validated), 'all five checks')
    + k('Median Sharpe', med.toFixed(2), 'last 100 variants, in-sample')
    + k('Best Sharpe', best.toFixed(2), 'last 100 variants')
    + k('Survived (shown)', `${passed}/${v.length}`, 'green lines in the fan')
    + k('Dropped in lab', num(c.labFailed), 'in-sample too weak');
}

function sieve(s) {
  const tot = Math.max(1, s.counts.sieveFailed);
  return REASONS.map(([k, l]) => {
    const n = s.sieveFailReasons[k];
    return `<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between"><span>${l}</span><span class="mono">${n}</span></div>
      <div style="height:4px;background:var(--line-2);margin-top:4px"><i style="display:block;height:100%;width:${(n / tot) * 100}%;background:var(--red)"></i></div></div>`;
  }).join('') + `<p class="dim" style="font-size:11px">Order of checks: out-of-sample → settings ±20% → other pair → 3× spread → monthly consistency${s.settings.earlyCostCheck ? ' (cost check moved first by an approved skill)' : ''}.</p>`;
}

function table(s) {
  return `<table><tr><th>Variant</th><th>Pair</th><th>TF</th><th class="num">Sharpe IS</th><th class="num">Trades</th><th class="num">Win %</th><th class="num">Net</th><th>Result</th><th class="num">When</th></tr>
  ${s.variants.slice().reverse().map((v) => `<tr class="click" data-v="${v.id}" onclick="location.hash='#/strategies/${v.strategyId}'">
    <td>${esc(v.name)}</td><td class="dim">${v.symbol}</td><td class="dim">${v.tf}</td><td class="num">${v.sharpe.toFixed(2)}</td><td class="num">${v.trades}</td>
    <td class="num">${pct(v.winrate, 0)}</td><td class="num ${v.net >= 0 ? 'green' : 'red'}">${usd(v.net)}</td>
    <td class="${v.passed ? 'green' : v.passed === false ? 'dim' : 'amber'}">${v.passed ? 'validated' : v.passed === false ? 'dropped' : 'testing'}</td><td class="num dim">${ago(v.t)}</td></tr>`).join('')}</table>`;
}

export default {
  mount(el, s) {
    root = el;
    el.innerHTML = `
      <div class="kpis" id="lab-k"></div>
      <div class="panel" style="margin-top:12px"><div class="ph"><span class="t">Equity fan</span><span class="s">last 100 variants · every curve re-based at the in/out-of-sample split</span>
        <span class="r"><span class="green">━</span> validated &nbsp; <span class="amber">━</span> testing &nbsp; <span class="dim">━</span> dropped</span></div>
        <canvas class="chart" id="lab-fan" style="height:380px"></canvas></div>
      <div class="grid" style="grid-template-columns:2fr 1fr;margin-top:12px">
        <div class="panel"><div class="ph"><span class="t">Variants</span><span class="s">hover to highlight · click to open the strategy</span></div><div id="lab-t" style="max-height:440px;overflow:auto"></div></div>
        <div class="panel"><div class="ph"><span class="t">Why recipes fail the sieve</span></div><div class="pb" id="lab-sieve"></div></div>
      </div>`;
    $('#lab-t', el).addEventListener('mouseover', (e) => {
      const tr = e.target.closest('tr[data-v]');
      highlight = tr?.dataset.v ?? null;
      drawFan($('#lab-fan', el), last.variants, { highlight });
    });
    this.update(s);
  },
  update(s) {
    if (!root) return;
    last = s;
    $('#lab-k', root).innerHTML = stats(s);
    $('#lab-t', root).innerHTML = table(s);
    $('#lab-sieve', root).innerHTML = sieve(s);
    drawFan($('#lab-fan', root), s.variants, { highlight });
  },
  unmount() { root = null; },
};
