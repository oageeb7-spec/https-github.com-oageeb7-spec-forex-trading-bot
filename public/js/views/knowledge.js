import { $, esc, num, pct, post } from '../ui.js';
import { drawCandles } from '../charts.js';

let root, cards = [], idx = 0, listSel = null, filter = '', last;
const STEPS = ['Found', 'Defined', 'Coded', 'Measured on data', 'Waiting on your check', 'Checked by you'];

function ring(step) {
  const r = 34, c = 2 * Math.PI * r, f = step / 6;
  return `<div class="ring"><svg width="84" height="84"><circle cx="42" cy="42" r="${r}" stroke="#1a2029" stroke-width="7" fill="none"/>
    <circle cx="42" cy="42" r="${r}" stroke="${step === 6 ? '#4ade80' : '#f5a524'}" stroke-width="7" fill="none" stroke-dasharray="${c * f} ${c}" transform="rotate(-90 42 42)"/></svg><b>${step}/6</b></div>`;
}

function body(d, withCheck) {
  return `<div class="kcard">
    <div><canvas class="chart kc-chart" style="height:280px"></canvas>
      <div class="mono dim" style="font-size:11px;margin-top:6px"><span style="color:#e5e9ee">${num(d.found)}</span> times found in ${d.symbol} 1h · <span style="color:#e5e9ee">${pct(d.followRate, 0)}</span> ${d.followLabel}</div></div>
    <div>
      <span class="chip">${esc(d.category)}</span><span class="chip">${esc(d.tag)}</span><span class="chip ${d.step === 6 ? 'green' : 'amber'}">${d.step === 6 ? (d.verdict === 'wrong' ? 'marked wrong' : 'checked') : d.step === 5 ? 'waiting on your check' : STEPS[d.step - 1]}</span>
      <h2>${esc(d.name)}</h2><div class="lbl">aka ${esc(d.aka)} · in plain words</div>
      <p style="font-size:14px">${esc(d.plain)}</p>
      <pre class="code">${esc(d.code)}</pre>
      ${withCheck ? `<div class="dim" style="font-size:12px;margin-bottom:6px">Note, if something is off</div>
        <textarea id="kc-note" placeholder="e.g. only count it during the New York session">${esc(d.note || '')}</textarea>
        <div style="margin-top:10px"><button class="btn go" data-v="1">Correct</button> <button class="btn" data-v="0">Wrong</button></div>` : d.note ? `<p class="dim">Your note: “${esc(d.note)}”</p>` : ''}
    </div></div>`;
}

async function loadCard() {
  const el = $('#kc', root);
  if (!cards.length) { el.innerHTML = '<div class="empty">Nothing waiting on your check. New concepts arrive from the terms checker.</div>'; return; }
  idx = (idx + cards.length) % cards.length;
  const d = await (await fetch(`/api/knowledge/${cards[idx]}`)).json();
  if (!root) return;
  el.innerHTML = body(d, true) + `<div style="display:flex;justify-content:center;gap:10px;align-items:center;margin-top:14px">
    <button class="btn sm" data-nav="-1">‹ previous</button>
    <span>${cards.map((_, i) => `<i style="display:inline-block;width:16px;height:2px;margin:0 2px;background:${i === idx ? 'var(--amber)' : 'var(--line-2)'}"></i>`).join('')}</span>
    <button class="btn sm" data-nav="1">next ›</button></div>`;
  $('#kc-count', root).textContent = `card ${idx + 1} of ${cards.length}`;
  drawCandles($('.kc-chart', el), d.example);
}

async function loadDetail(id) {
  listSel = id;
  const d = await (await fetch(`/api/knowledge/${id}`)).json();
  if (!root) return;
  $('#kd', root).innerHTML = `<div class="pb" style="display:flex;gap:16px;align-items:center;border-bottom:1px solid var(--line)">${ring(d.step)}
      <div><div class="lbl">Lifecycle</div><div>${STEPS.map((s, i) => `<span class="${i < d.step ? 'green' : 'dim'}" style="font-size:12px">${s}</span>`).join(' <span class="dim">→</span> ')}</div></div></div>
    <div class="pb">${body(d, false)}</div>`;
  drawCandles($('#kd .kc-chart', root), d.example);
  renderList(last);
}

function renderList(s) {
  const items = s.knowledge.filter((k) => !filter || `${k.name} ${k.aka} ${k.category}`.toLowerCase().includes(filter));
  $('#kl', root).innerHTML = items.map((k) => `<div class="k ${k.id === listSel ? 'sel' : ''}" data-id="${k.id}">
    <span class="${k.step === 6 ? (k.verdict === 'wrong' ? 'red' : 'green') : k.step === 5 ? 'amber' : 'dim'}">●</span>
    <span>${esc(k.name)}<div class="dim" style="font-size:11px">${esc(k.category)} · ${num(k.found)} found</div></span>
    <span class="st">${k.step}/6</span></div>`).join('') + (s.terms.length ? `<div class="lbl" style="margin:14px 10px 6px">Proposed terms</div>${s.terms.map((t) => `<div class="k"><span class="dim">○</span><span>${esc(t.term)}<div class="dim" style="font-size:11px">step 1/6 · found</div></span></div>`).join('')}` : '');
}

export default {
  mount(el, s) {
    root = el;
    last = s;
    el.innerHTML = `
      <div class="panel"><div class="ph"><span class="t">Your check</span><span class="s">card by card: is what the brain thinks right?</span><span class="r" id="kc-count"></span></div><div class="pb" id="kc"></div></div>
      <div class="grid" style="grid-template-columns:320px 1fr;margin-top:12px;align-items:start">
        <div class="panel"><div class="pb" style="border-bottom:1px solid var(--line)"><input type="text" id="kq" placeholder="Search, e.g. gap, order block" /></div><div class="klist" id="kl"></div></div>
        <div class="panel" id="kd"><div class="empty">Pick a concept to see its definition, code and statistics.</div></div>
      </div>`;
    cards = s.knowledge.filter((k) => k.step === 5).map((k) => k.id);
    idx = 0;
    $('#kc', el).addEventListener('click', async (e) => {
      const nav = e.target.closest('[data-nav]');
      if (nav) { idx += Number(nav.dataset.nav); return loadCard(); }
      const v = e.target.closest('[data-v]');
      if (!v) return;
      v.disabled = true;
      await post(`/api/knowledge/${cards[idx]}/verdict`, { ok: v.dataset.v === '1', note: $('#kc-note', root).value });
      cards.splice(idx, 1);
      window.dispatchEvent(new Event('brain:refresh'));
      loadCard();
    });
    $('#kq', el).addEventListener('input', (e) => { filter = e.target.value.toLowerCase(); renderList(last); });
    $('#kl', el).addEventListener('click', (e) => { const k = e.target.closest('.k[data-id]'); if (k) loadDetail(k.dataset.id); });
    renderList(s);
    loadCard();
    loadDetail(s.knowledge[0].id);
  },
  update(s) {
    if (!root) return;
    last = s;
    for (const k of s.knowledge) if (k.step === 5 && !cards.includes(k.id)) cards.push(k.id);
    if ($('#kc .empty', root) && cards.length) loadCard();
    renderList(s);
  },
  unmount() { root = null; },
};
