import { $, esc, num, pct, usd, spark, gates, STATUS } from '../ui.js';
import { drawEquity } from '../charts.js';

let root, selected, detail;

const GATES = ['Out-of-sample Sharpe > 0.6', 'Settings ±20% still work', 'Carries over to another pair', 'Survives 3× spread', 'At least half the months positive'];

function list(s) {
  if (!s.ranked.length) return '<div class="empty">No recipe has reached the sieve yet.</div>';
  return s.ranked.map((r) => `<div class="item ${r.id === selected ? 'sel' : ''}" data-id="${r.id}">
    <div><div class="nm">${esc(r.name)}</div><div class="meta">${r.symbol} · ${r.tf} · ${STATUS[r.status] || r.status}</div>${gates(r.gates)}</div>
    ${spark(r.spark, { w: 90, h: 26, color: r.status === 'failed-sieve' ? '#5d6773' : '#4ade80' })}
    <div class="mono num" style="font-size:13px">${(r.sharpe ?? 0).toFixed(2)}</div></div>`).join('');
}

function figures(d) {
  const m = d.metrics;
  const box = (l, v, sub, frac, color) => `<div class="bigstat"><div class="lbl">${l}</div><div class="v">${v}</div><div class="bar"><i style="width:${Math.max(0, Math.min(1, frac)) * 100}%;background:${color}"></i></div><div class="dim" style="font-size:11px">${sub}</div></div>`;
  return box('Win rate', pct(m.winrate), 'share of trades with profit', m.winrate, m.winrate > 0.45 ? 'var(--green)' : 'var(--red)')
    + box('Avg R:R', `1 : ${m.rr.toFixed(2)}`, 'avg win / avg loss, in dollars', m.rr / 4, 'var(--green)')
    + box('Expectancy', `${m.expectancy >= 0 ? '+' : ''}${usd(m.expectancy)}`, `per trade, after costs · ${m.expectancyR.toFixed(2)}R`, 0.5 + m.expectancyR, m.expectancy >= 0 ? 'var(--green)' : 'var(--red)')
    + box('Trades', num(m.trades), 'in the full backtest', 1, 'var(--line-2)')
    + box('Max drawdown', usd(m.maxDD), 'in dollars, 1 standard lot', Math.min(1, -m.maxDD / Math.max(1, m.net)), 'var(--red)');
}

function monthly(d) {
  const mx = Math.max(0.5, ...d.monthly.map((m) => Math.abs(m.r)));
  const pos = d.monthly.filter((m) => m.r > 0).length;
  return `<div style="display:flex;align-items:center;height:140px;gap:3px">${d.monthly.map((m) => `<div title="${m.month}: ${m.r}R" style="flex:1;height:100%;display:flex;flex-direction:column;justify-content:center">
      <i style="display:block;height:${(Math.max(0, m.r) / mx) * 50}%;background:var(--green-d)"></i><i style="display:block;height:1px;background:var(--line-2)"></i><i style="display:block;height:${(Math.max(0, -m.r) / mx) * 50}%;background:#7a2626"></i></div>`).join('')}</div>
    <div class="dim mono" style="font-size:11px;margin-top:6px">${pos} of ${d.monthly.length} months positive · ${d.monthly[0]?.month ?? ''} → ${d.monthly[d.monthly.length - 1]?.month ?? ''}</div>`;
}

function detailHtml(d) {
  return `<div class="panel"><div class="pb">
      <div><span class="chip">${d.symbol}</span><span class="chip">${d.tf}</span><span class="chip ${d.status === 'failed-sieve' ? '' : 'green'}">${STATUS[d.status] || d.status}</span></div>
      <h2 style="font-size:24px;font-weight:500;margin:10px 0 4px">${esc(d.name)}</h2>
      <div class="dim">${esc(d.blurb)} From: “${esc(d.source)}”.</div></div></div>
    <div class="panel" style="margin-top:12px"><div class="ph"><span class="t">Key figures</span><span class="s">from the best backtest in the lab, after costs</span></div>
      <div class="pb grid" style="grid-template-columns:repeat(5,1fr)">${figures(d)}</div></div>
    <div class="panel" style="margin-top:12px"><div class="ph"><span class="t">Equity curve</span><span class="s">in dollars, 1 standard lot · the line of the best backtest</span></div>
      <canvas class="chart" id="st-eq" style="height:320px"></canvas></div>
    <div class="grid" style="grid-template-columns:1.3fr 1fr;margin-top:12px">
      <div class="panel"><div class="ph"><span class="t">Monthly robustness</span><span class="s">sum of R per month</span></div><div class="pb">${monthly(d)}</div></div>
      <div class="panel"><div class="ph"><span class="t">The sieve</span><span class="s">five checks to the vault</span></div><div class="pb">
        ${GATES.map((g, i) => `<div style="display:flex;gap:8px;padding:4px 0"><span class="${d.gates[i] ? 'green' : d.gates[i] === false ? 'red' : 'dim'}">${d.gates[i] ? '✓' : d.gates[i] === false ? '✕' : '·'}</span>${g}${i === 2 && d.transfer ? ` <span class="dim">(${d.transfer.symbol}: ${d.transfer.sharpe})</span>` : ''}</div>`).join('')}
        ${d.failReason ? `<p class="red" style="font-size:12px">Stopped: ${esc(d.failReason)}</p>` : ''}
        <div class="lbl" style="margin-top:12px">Settings</div>
        <div class="kv" style="margin-top:6px">${d.paramDefs.map((p) => `<span>${p.name}</span><span>${d.params[p.name]} <span class="dim">(${p.min}–${p.max})</span></span>`).join('')}</div></div></div>
    </div>
    <div class="panel" style="margin-top:12px"><div class="ph"><span class="t">Last trades</span><span class="s">from the backtest</span></div>
      <table><tr><th>Exit</th><th>Side</th><th class="num">Entry</th><th class="num">Exit</th><th class="num">R</th><th class="num">P&amp;L</th></tr>
      ${d.trades.map((t) => `<tr><td class="dim">${new Date(t.exitT).toISOString().slice(0, 16).replace('T', ' ')}</td><td>${t.dir > 0 ? 'long' : 'short'}</td><td class="num">${t.entry.toFixed(d.digits)}</td><td class="num">${t.exit.toFixed(d.digits)}</td><td class="num ${t.r >= 0 ? 'green' : 'red'}">${t.r.toFixed(2)}</td><td class="num ${t.pnl >= 0 ? 'green' : 'red'}">${usd(t.pnl)}</td></tr>`).join('')}</table></div>`;
}

async function select(id) {
  selected = id;
  const res = await fetch(`/api/strategy/${id}`);
  if (!res.ok || !root) return;
  detail = await res.json();
  $('#st-detail', root).innerHTML = detailHtml(detail);
  drawEquity($('#st-eq', root), detail.equity, detail.drawdown, { split: detail.split });
  root.querySelectorAll('.slist .item').forEach((n) => n.classList.toggle('sel', n.dataset.id === id));
}

export default {
  mount(el, s, arg) {
    root = el;
    el.innerHTML = `<div class="grid" style="grid-template-columns:330px 1fr;align-items:start">
      <div class="panel"><div class="ph"><span class="t">Strategies</span><span class="s">ranked · validated first</span></div><div class="slist" id="st-list"></div></div>
      <div id="st-detail"><div class="empty">Pick a strategy.</div></div></div>`;
    $('#st-list', el).addEventListener('click', (e) => {
      const it = e.target.closest('.item');
      if (it) history.replaceState(null, '', `#/strategies/${it.dataset.id}`), select(it.dataset.id);
    });
    this.update(s);
    const first = arg || s.ranked[0]?.id;
    if (first) select(first);
  },
  update(s) {
    if (!root) return;
    $('#st-list', root).innerHTML = list(s);
  },
  unmount() { root = null; selected = null; },
};
