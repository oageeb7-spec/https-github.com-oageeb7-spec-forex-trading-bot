import { $, $$, esc, time, usd } from './ui.js';
import { initVoice, voiceState } from './voice.js';
import overview from './views/overview.js';
import lab from './views/lab.js';
import research from './views/research.js';
import strategies from './views/strategies.js';
import knowledge from './views/knowledge.js';
import room from './views/room.js';
import paper from './views/paper.js';
import decisions from './views/decisions.js';
import costs from './views/costs.js';
import machines from './views/machines.js';

const VIEWS = { overview, lab, research, strategies, knowledge, room, paper, decisions, costs, machines };
let state = null;
let current = null;
let currentName = '';

function route() {
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const next = VIEWS[name] ? name : 'overview';
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === next));
  if (!state) return;
  if (current?.unmount) current.unmount();
  const main = $('#main');
  main.innerHTML = '';
  main.scrollTop = 0;
  currentName = next;
  current = VIEWS[next];
  current.mount(main, state, arg);
}

function chrome(s) {
  const pending = s.decisions.filter((d) => d.status === 'pending').length;
  const pendingK = s.knowledge.filter((k) => k.step === 5).length;
  const pctUsed = Math.min(1, s.budget.spent / s.budget.limit);
  const daysLeft = s.budget.perHour > 0 ? (s.budget.limit - s.budget.spent) / (s.budget.perHour * 24) : Infinity;
  $('#pill-budget').innerHTML = `THINKING BUDGET <b>${usd(s.budget.spent, 2)}</b> <span class="dim">of $${s.budget.limit} · ${isFinite(daysLeft) ? `~${daysLeft < 1 ? `${Math.round(daysLeft * 24)}h` : `${daysLeft.toFixed(1)}d`} left` : ''}</span><span class="bar"><i style="width:${pctUsed * 100}%;background:${pctUsed > 0.85 ? 'var(--red)' : 'var(--green)'}"></i></span>`;
  $('#top-round').textContent = s.round.toLocaleString('en');
  $('#top-pending').textContent = pending;
  $('#foot-round').textContent = s.round.toLocaleString('en');
  $('#foot-state').textContent = s.paused ? 'paused' : 'running';
  $('#badge-decisions').textContent = pending || '';
  $('#badge-knowledge').textContent = pendingK || '';
  const reading = s.agents.some((a) => (a.id === 'reader' || a.id === 'watcher') && a.status === 'working');
  $('#pill-hermes').innerHTML = `<i class="dot ${s.paused ? 'amber' : 'on'}"></i> HERMES <span class="dim">${s.paused ? 'idle' : reading ? 'reading' : 'listening'}</span>`;
  const stale = s.data.symbols.some((x) => x.error);
  $('#pill-data').innerHTML = s.data.source === 'synthetic'
    ? `<i class="dot amber"></i> DATA <span class="dim">demo</span>`
    : `<i class="dot ${stale ? 'red' : 'on'}"></i> OS AI DATA <span class="dim">${stale ? 'feed error' : 'live'}</span>`;
  $('#pill-orion').innerHTML = `<i class="dot ${s.paused ? 'amber' : 'on'}"></i> ORION <span class="dim">${s.paused ? 'paused' : 'running'}</span>`;
  const tick = $('#ticker');
  const items = s.log.slice(-14).reverse();
  const html = items.map((l) => `<span>${time(l.t)}<b class="k-${l.kind}">${l.kind}</b>${esc(l.text)}</span>`).join('');
  if (tick.dataset.first !== String(items[0]?.t)) {
    tick.dataset.first = String(items[0]?.t);
    tick.innerHTML = html;
  }
}

function onState(s) {
  const first = !state;
  state = s;
  chrome(s);
  voiceState(s);
  if (first) route();
  else current?.update?.(s);
}

setInterval(() => ($('#clock').textContent = time(Date.now())), 1000);
window.addEventListener('hashchange', route);
initVoice();
window.addEventListener('brain:refresh', async () => onState(await (await fetch('/api/state')).json()));

function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => onState(JSON.parse(e.data));
  es.onerror = () => {
    es.close();
    $('#foot-state').textContent = 'disconnected';
    setTimeout(connect, 2000);
  };
}
connect();

export const getState = () => state;
export const viewName = () => currentName;
