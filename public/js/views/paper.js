import { $, esc, num, pct, usd, spark, time, ago } from '../ui.js';

let root;

function card(p, feed) {
  const live = p.status === 'live';
  return `<div class="panel"><div class="ph"><span class="t">${esc(p.name)}</span><span class="r ${live ? 'green' : ''}">${live ? `LIVE · ${feed}` : `paper · day ${p.day} of ${p.days}`}</span></div>
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

function bridgePanel(s) {
  const b = s.bridge;
  if (!b || !b.configured) {
    return `<div class="pb"><p style="margin:0 0 8px">Real trading on <b>MT4 / MT5</b> is not set up. It needs:</p>
      <ol class="dim" style="margin:0;padding-left:18px;line-height:1.7">
        <li>A <code>DASHBOARD_PASSWORD</code> and a long random <code>BRIDGE_TOKEN</code> in the server's environment variables.</li>
        <li>The OS AI EA (<code>mt/OSAI_Bridge.mq5</code> or <code>.mq4</code>) on one chart in your MetaTrader, with the same token.</li>
        <li>A strategy you approved to <b>Live</b>. Test on a demo account first.</li></ol></div>`;
  }
  const a = b.account;
  const state = b.killed ? '<span class="red">KILL SWITCH ON</span>' : b.armed ? '<span class="green">ARMED · real orders are sent</span>' : '<span class="amber">DISARMED · no real orders</span>';
  const ea = b.connected ? `<span class="green">EA connected</span> <span class="dim">· seen ${ago(b.lastSeen)}</span>` : `<span class="red">EA not connected</span>${b.lastSeen ? ` <span class="dim">· last seen ${ago(b.lastSeen)}</span>` : ''}`;
  return `<div class="pb">
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center">
      <div><div class="lbl">Status</div><div class="mono">${state}</div></div>
      <div><div class="lbl">MetaTrader</div><div class="mono">${ea}</div></div>
      ${a ? `<div><div class="lbl">Account</div><div class="mono">${esc(a.login)} · ${esc(a.server)}</div></div>
      <div><div class="lbl">Balance / equity</div><div class="mono">${num(a.balance, 2)} / ${num(a.equity, 2)} ${esc(a.currency)}</div></div>
      <div><div class="lbl">Today</div><div class="mono ${b.dayPnl >= 0 ? 'green' : 'red'}">${b.dayPnl >= 0 ? '+' : ''}${num(b.dayPnl, 2)} ${esc(a.currency)}</div></div>` : ''}
      <div style="margin-left:auto;display:flex;gap:8px">
        ${b.armed ? '<button class="btn" data-bridge="disarm">Disarm</button>' : `<button class="btn go" data-bridge="arm" ${b.passwordSet ? '' : 'disabled title="Set DASHBOARD_PASSWORD first"'}>Arm live trading</button>`}
        <button class="btn" data-bridge="kill" style="border-color:#7a2626;color:#f05252">Kill switch</button>
      </div>
    </div>
    <div class="dim" style="font-size:11px;margin-top:8px">Limits: ${b.limits.lots} lot per trade (max ${b.limits.maxLots}) · ${b.limits.maxOpen} open trades · stop for the day after ${b.limits.maxDailyLoss} ${a ? esc(a.currency) : ''} loss · a restart always disarms</div>
    <div id="br-msg" class="red" style="font-size:12px;margin-top:6px"></div>
  </div>
  <div class="grid" style="grid-template-columns:1fr 1fr;border-top:1px solid var(--line)">
    <div><div class="ph"><span class="lbl">Open MetaTrader positions</span></div>
      ${b.positions.length ? `<table><tr><th>Strategy</th><th>Symbol</th><th>Side</th><th class="num">Lots</th><th class="num">Open</th><th class="num">P&amp;L</th></tr>${b.positions.map((p) => `<tr><td>${esc(p.strategyId)}</td><td>${esc(p.symbol)}</td><td>${p.dir}</td><td class="num">${p.lots}</td><td class="num">${p.openPrice}</td><td class="num ${p.profit >= 0 ? 'green' : 'red'}">${num(p.profit, 2)}</td></tr>`).join('')}</table>` : '<div class="empty">No open positions.</div>'}</div>
    <div><div class="ph"><span class="lbl">Orders</span></div>
      ${b.orders.length ? `<table><tr><th>#</th><th>Time</th><th>Order</th><th>Status</th></tr>${b.orders.slice(0, 12).map((o) => `<tr><td>${o.seq}</td><td class="dim">${time(o.t)}</td><td>${o.action === 'open' ? `${o.dir} ${o.lots} ${esc(o.symbol)}` : o.action === 'close' ? `close ${esc(o.symbol)}` : 'close all'}</td><td class="${o.status === 'filled' ? 'green' : ['rejected', 'expired'].includes(o.status) ? 'red' : 'amber'}">${o.status}${o.error ? ` · ${esc(o.error)}` : ''}</td></tr>`).join('')}</table>` : '<div class="empty">No orders yet.</div>'}</div>
  </div>`;
}

export default {
  mount(el, s) {
    root = el;
    el.innerHTML = `<div class="panel" style="margin-bottom:12px"><div class="ph"><span class="t">Live trading · MT4 / MT5</span><span class="s">strategies you approved to Live send real orders through the OS AI EA</span></div><div id="br"></div></div>
      <div class="panel" style="margin-bottom:12px"><div class="pb dim">Approved strategies paper-trade on the forward market feed with 1 standard lot for ${s.paper[0]?.days ?? 21} trading days.
      Profitable ones are proposed for live. ${s.data.source === 'synthetic' ? 'Prices are generated (demo mode).' : 'Prices are real (OS AI data).'}</div></div><div class="grid" id="pp" style="grid-template-columns:repeat(auto-fill,minmax(420px,1fr))"></div>`;
    $('#br', el).addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-bridge]');
      if (!btn) return;
      const act = btn.dataset.bridge;
      if (act === 'arm' && !confirm('Arm live trading? Strategies approved to Live will send REAL orders to your MetaTrader account.')) return;
      if (act === 'kill' && !confirm('Kill switch: disarm and close every OS AI position now?')) return;
      const r = await fetch(act === 'kill' ? '/api/bridge/kill' : '/api/bridge/arm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ armed: act === 'arm' }) });
      const msg = $('#br-msg', root);
      if (msg) msg.textContent = r.ok ? '' : (await r.json().catch(() => ({}))).error || 'Request failed';
      window.dispatchEvent(new Event('brain:refresh'));
    });
    this.update(s);
  },
  update(s) {
    if (!root) return;
    const keep = $('#br-msg', root)?.textContent;
    $('#br', root).innerHTML = bridgePanel(s);
    if (keep && $('#br-msg', root)) $('#br-msg', root).textContent = keep;
    $('#pp', root).innerHTML = s.paper.length ? s.paper.slice().reverse().map((p) => card(p, s.data.source === 'synthetic' ? 'generated prices' : 'OS AI data')).join('') : '<div class="empty">Nothing on paper yet. Approve a validated strategy under Decisions.</div>';
  },
  unmount() { root = null; },
};
