import { $, esc, num } from '../ui.js';

let root;
const mb = (b) => `${num(b / 1048576, 1)} MB`;
const dur = (s) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;

export default {
  mount(el, s) {
    root = el;
    el.innerHTML = `<div class="grid" style="grid-template-columns:1fr 1fr" id="mc"></div>
      <div class="panel" style="margin-top:12px"><div class="ph"><span class="t">Market data</span><span class="s" id="mc-ds"></span></div><div id="mc-d"></div></div>
      <div class="panel" style="margin-top:12px"><div class="ph"><span class="t">Research</span></div><div id="mc-r"></div></div>
      <div class="panel" style="margin-top:12px"><div class="ph"><span class="t">Agents</span><span class="s">who is doing what right now</span></div><div id="mc-a"></div></div>`;
    this.update(s);
  },
  update(s) {
    if (!root) return;
    $('#mc', root).innerHTML = s.machines.map((m) => `<div class="panel"><div class="ph"><span class="t">${m.name.toUpperCase()}</span><span class="s">${esc(m.role)}</span><span class="r"><i class="dot on"></i> online</span></div>
      <div class="pb kv"><span>Load (1m)</span><span>${m.load.toFixed(2)} / ${m.cpus} cores</span><span>Memory</span><span>${mb(m.rss)}</span><span>Heap</span><span>${mb(m.heap)}</span><span>Uptime</span><span>${dur(m.uptime)}</span></div></div>`).join('');
    const d = s.data, day = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
    $('#mc-ds', root).textContent = d.source === 'oanda' ? `OANDA v20 · ${d.env} · hourly candles, polled for new closes` : 'synthetic generator · set OANDA_API_KEY to use real prices';
    $('#mc-d', root).innerHTML = `<table><tr><th>Pair</th><th class="num">Bars</th><th>History from</th><th>Last bar (UTC)</th><th class="num">Price</th><th class="num">Spread used</th><th>Feed</th></tr>${d.symbols.map((x) => `<tr>
      <td>${x.symbol}</td><td class="num">${num(x.bars)}</td><td class="dim">${day(x.from)}</td><td>${day(x.lastBar)}</td><td class="num">${x.price.toFixed(x.digits)}</td><td class="num">${x.spread.toFixed(x.digits)}</td>
      <td class="${x.error ? 'red' : 'dim'}">${x.error ? esc(x.error) : x.lastPoll ? `polled ${Math.round((Date.now() - x.lastPoll) / 1000)}s ago` : d.source === 'oanda' ? 'waiting for first poll' : 'simulated'}</td></tr>`).join('')}</table>`;
    $('#mc-r', root).innerHTML = s.research.mode === 'live'
      ? `<div class="pb kv"><span>Mode</span><span class="green">live</span><span>Sources</span><span>${s.research.kinds.join(', ')}${s.research.kinds.includes('youtube') ? '' : ' <span class="dim">(set YOUTUBE_API_KEY to add YouTube)</span>'}</span><span>Analyst</span><span>${esc(s.research.analyst)}</span></div>`
      : '<div class="pb kv"><span>Mode</span><span class="amber">simulated</span><span>Sources</span><span>generated titles, no real documents</span></div>';
    $('#mc-a', root).innerHTML = `<table><tr><th>Agent</th><th>Role</th><th>Status</th><th>Task</th><th class="num">Done</th></tr>${s.agents.map((a) => `<tr>
      <td><span style="color:${a.color}">●</span> ${esc(a.name)}</td><td class="dim">${esc(a.role)}</td><td class="${a.status === 'working' ? 'green' : a.status === 'stuck' ? 'red' : 'dim'}">${a.status}</td>
      <td style="max-width:420px;overflow:hidden;text-overflow:ellipsis">${esc(a.task)}</td><td class="num">${num(a.done)}</td></tr>`).join('')}</table>`;
  },
  unmount() { root = null; },
};
