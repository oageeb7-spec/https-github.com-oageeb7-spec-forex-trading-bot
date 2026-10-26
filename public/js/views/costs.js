import { $, esc, usd, spark, post } from '../ui.js';

let root;

export default {
  mount(el, s) {
    root = el;
    el.innerHTML = `<div class="kpis" style="grid-template-columns:repeat(4,1fr)" id="cs-k"></div>
      <div class="grid" style="grid-template-columns:1fr 1fr;margin-top:12px;align-items:start">
        <div class="panel"><div class="ph"><span class="t">Spend by agent</span></div><div class="pb" id="cs-a"></div></div>
        <div class="panel"><div class="ph"><span class="t">Cumulative spend</span></div><div class="pb" id="cs-h"></div>
          <div class="pb" style="border-top:1px solid var(--line)"><div class="lbl" style="margin-bottom:6px">Budget limit (USD)</div>
          <div class="row"><input type="number" id="cs-lim" min="1" step="1" value="${s.budget.limit}" style="width:120px"/><button class="btn" id="cs-set">Set</button></div>
          <p class="dim" style="font-size:11px">When the budget is used up, research pauses. Paper trading keeps running.</p></div></div>
      </div>`;
    $('#cs-set', el).addEventListener('click', async () => {
      await post('/api/budget', { limit: Number($('#cs-lim', el).value) });
      window.dispatchEvent(new Event('brain:refresh'));
    });
    this.update(s);
  },
  update(s) {
    if (!root) return;
    const b = s.budget;
    const k = (l, v, n) => `<div class="kpi"><div class="lbl">${l}</div><div class="v">${v}</div><div class="n">${n}</div></div>`;
    $('#cs-k', root).innerHTML = k('Spent', usd(b.spent, 2), `of $${b.limit}`) + k('Per hour', usd(b.perHour, 2), 'at the current pace')
      + k('Per recipe', usd(b.spent / Math.max(1, s.counts.recipes), 4), 'all agents included') + k('Per validated', usd(b.spent / Math.max(1, s.counts.validated), 3), 'what one survivor costs');
    const agents = Object.entries(b.byAgent).sort((a, c) => c[1] - a[1]);
    const mx = Math.max(1e-9, ...agents.map((a) => a[1]));
    const name = Object.fromEntries(s.agents.map((a) => [a.id, a]));
    $('#cs-a', root).innerHTML = agents.map(([id, v]) => `<div style="display:grid;grid-template-columns:120px 1fr 70px;gap:10px;align-items:center;padding:4px 0">
      <span>${esc(name[id].name)}</span><span style="height:6px;background:var(--line-2)"><i style="display:block;height:100%;width:${(v / mx) * 100}%;background:${name[id].color}"></i></span><span class="mono num">${usd(v, 3)}</span></div>`).join('');
    $('#cs-h', root).innerHTML = spark(b.history.map((h) => h.spent), { w: 600, h: 140, color: '#4ade80', fill: true }).replace('width="600"', 'width="100%"');
  },
  unmount() { root = null; },
};
