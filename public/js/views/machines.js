import { $, esc, num } from '../ui.js';

let root;
const mb = (b) => `${num(b / 1048576, 1)} MB`;
const dur = (s) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;

export default {
  mount(el, s) {
    root = el;
    el.innerHTML = `<div class="grid" style="grid-template-columns:1fr 1fr" id="mc"></div>
      <div class="panel" style="margin-top:12px"><div class="ph"><span class="t">Agents</span><span class="s">who is doing what right now</span></div><div id="mc-a"></div></div>`;
    this.update(s);
  },
  update(s) {
    if (!root) return;
    $('#mc', root).innerHTML = s.machines.map((m) => `<div class="panel"><div class="ph"><span class="t">${m.name.toUpperCase()}</span><span class="s">${esc(m.role)}</span><span class="r"><i class="dot on"></i> online</span></div>
      <div class="pb kv"><span>Load (1m)</span><span>${m.load.toFixed(2)} / ${m.cpus} cores</span><span>Memory</span><span>${mb(m.rss)}</span><span>Heap</span><span>${mb(m.heap)}</span><span>Uptime</span><span>${dur(m.uptime)}</span></div></div>`).join('');
    $('#mc-a', root).innerHTML = `<table><tr><th>Agent</th><th>Role</th><th>Status</th><th>Task</th><th class="num">Done</th></tr>${s.agents.map((a) => `<tr>
      <td><span style="color:${a.color}">●</span> ${esc(a.name)}</td><td class="dim">${esc(a.role)}</td><td class="${a.status === 'working' ? 'green' : 'dim'}">${a.status}</td>
      <td style="max-width:420px;overflow:hidden;text-overflow:ellipsis">${esc(a.task)}</td><td class="num">${num(a.done)}</td></tr>`).join('')}</table>`;
  },
  unmount() { root = null; },
};
