import { $, esc, num, pct, usd, spark } from '../ui.js';

let root;

function card(p) {
  const live = p.status === 'live';
  return `<div class="panel"><div class="ph"><span class="t">${esc(p.name)}</span><span class="r ${live ? 'green' : ''}">${live ? 'LIVE · simulated feed' : `paper · day ${p.day} of ${p.days}`}</span></div>
    <div class="pb">
      ${live ? '' : `<div style="height:3px;background:var(--line-2);margin-bottom:12px"><i style="display:block;height:100%;width:${(p.day / p.days) * 100}%;background:var(--green)"></i></div>`}
      <div class="grid" style="grid-template-columns:repeat(4,1fr)">
        <div><div class="lbl">Net</div><div class="mono ${p.net >= 0 ? 'green' : 'red'}" style="font-size:20px">${usd(p.net)}</div></div>
        <div><div class="lbl">Trades</div><div class="mono" style="font-size:20px">${p.trades}</div></div>
        <div><div class="lbl">Win rate</div><div class="mono" style="font-size:20px">${p.trades ? pct(p.winrate, 0) : '—'}</div></div>
        <div><div class="lbl">Price</div><div class="mono" style="font-size:20px">${p.price.toFixed(p.digits)}</div></div>
      </div>
      <div style="margin:12px 0">${spark(p.equity, { w: 600, h: 60, color: p.net >= 0 ? '#4ade80' : '#f05252', fill: true }).replace('width="600"', 'width="100%"')}</div>
      <div class="dim mono" style="font-size:11px">${p.pos ? `Open ${p.pos.dir > 0 ? 'LONG' : 'SHORT'} at ${p.pos.entry.toFixed(p.digits)} · stop ${p.pos.stop.toFixed(p.digits)} · target ${Number.isFinite(p.pos.target) ? p.pos.target.toFixed(p.digits) : 'time exit'}` : 'Flat · waiting for a signal'}</div>
    </div></div>`;
}

export default {
  mount(el, s) {
    root = el;
    el.innerHTML = `<div class="panel" style="margin-bottom:12px"><div class="pb dim">Approved strategies trade on the forward market feed with 1 standard lot for ${s.paper[0]?.days ?? 21} trading days.
      Profitable ones are proposed for live. Live runs on the same feed until a broker adapter is connected — no real orders are sent.</div></div><div class="grid" id="pp" style="grid-template-columns:repeat(auto-fill,minmax(420px,1fr))"></div>`;
    this.update(s);
  },
  update(s) {
    if (!root) return;
    $('#pp', root).innerHTML = s.paper.length ? s.paper.slice().reverse().map(card).join('') : '<div class="empty">Nothing on paper yet. Approve a validated strategy under Decisions.</div>';
  },
  unmount() { root = null; },
};
