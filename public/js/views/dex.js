import { $, esc, num, pct, spark, time, ago } from '../ui.js';

let root;

const money = (n) => (n >= 1e6 ? `$${num(n / 1e6, 2)}M` : n >= 1e3 ? `$${num(n / 1e3, 1)}k` : `$${num(n, 0)}`);
const price = (p) => (p == null ? '—' : p >= 1 ? `$${num(p, 4)}` : `$${p.toPrecision(4)}`);
const chg = (x) => (x == null ? '—' : `<span class="${x >= 0 ? 'green' : 'red'}">${x >= 0 ? '+' : ''}${num(x, 1)}%</span>`);
const age = (h) => (h == null ? '—' : h < 48 ? `${num(h, 0)} h` : `${num(h / 24, 0)} d`);

function body(s) {
  const d = s.dex;
  if (!d) return '<div class="panel"><div class="pb">The DEX desk is off (<code>DEX_CHAIN=off</code>, or demo mode). Set <code>DEX_CHAIN=robinhood</code> to scan Robinhood Chain on DexScreener.</div></div>';
  const st = d.stats;
  return `
  <div class="grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:12px">
    <div class="panel"><div class="pb"><div class="lbl">Coins tracked</div><div class="mono" style="font-size:22px">${d.pairs.length}</div><div class="dim" style="font-size:11px">${d.pairs.filter((p) => p.safe).length} pass the safety filter</div></div></div>
    <div class="panel"><div class="pb"><div class="lbl">Paper net</div><div class="mono ${st.net >= 0 ? 'green' : 'red'}" style="font-size:22px">${st.net >= 0 ? '+' : '-'}$${num(Math.abs(st.net), 2)}</div><div class="dim" style="font-size:11px">${st.trades} trades · ${st.trades ? pct(st.winrate, 0) : '—'} won</div></div></div>
    <div class="panel"><div class="pb"><div class="lbl">Open paper trades</div><div class="mono" style="font-size:22px">${d.positions.length} / ${d.trade.maxOpen}</div><div class="dim" style="font-size:11px">$${d.trade.usd} each · stop -${d.trade.stopPct * 100}% · target +${d.trade.targetPct * 100}%</div></div></div>
    <div class="panel"><div class="pb"><div class="lbl">DexScreener</div><div class="mono ${d.error ? 'red' : 'green'}" style="font-size:14px;margin-top:6px">${d.error ? esc(d.error) : d.lastRefresh ? `live · ${ago(d.lastRefresh)}` : 'connecting…'}</div><div class="dim" style="font-size:11px">chain: ${esc(d.chain)}</div></div></div>
  </div>
  ${d.positions.length ? `<div class="panel" style="margin-bottom:12px"><div class="ph"><span class="t">Open paper trades</span></div><table>
    <tr><th>Coin</th><th class="num">Bought</th><th class="num">Now</th><th class="num">Stop / target</th><th class="num">P&amp;L</th><th></th></tr>
    ${d.positions.map((p) => `<tr><td><b>${esc(p.symbol)}</b> <span class="dim">${esc(p.name)}</span></td><td class="num">${price(p.entry)}</td><td class="num">${price(p.price)}</td><td class="num">${price(p.stop)} / ${price(p.target)}</td><td class="num ${p.pnl >= 0 ? 'green' : 'red'}">${p.pnl >= 0 ? '+' : '-'}$${num(Math.abs(p.pnl), 2)}</td><td><a href="${esc(p.url)}" target="_blank" rel="noopener">chart ↗</a></td></tr>`).join('')}</table></div>` : ''}
  <div class="panel" style="margin-bottom:12px"><div class="ph"><span class="t">Robinhood Chain coins · DexScreener</span><span class="s">sorted safe first, then by 24h volume · prices every minute</span></div>
    ${d.pairs.length ? `<table><tr><th>Coin</th><th>DEX</th><th class="num">Price</th><th class="num">1h</th><th class="num">24h</th><th class="num">Liquidity</th><th class="num">Volume 24h</th><th class="num">Age</th><th>Last 4 h</th><th>Safety</th></tr>
    ${d.pairs.map((p) => `<tr><td><a href="${esc(p.url)}" target="_blank" rel="noopener"><b>${esc(p.symbol)}</b></a> <span class="dim">${esc((p.name || '').slice(0, 18))}</span></td><td class="dim">${esc(p.dex)}</td><td class="num">${price(p.price)}</td><td class="num">${chg(p.change1h)}</td><td class="num">${chg(p.change24h)}</td><td class="num">${money(p.liquidity)}</td><td class="num">${money(p.volume24h)}</td><td class="num">${age(p.ageH)}</td><td>${p.spark.length > 1 ? spark(p.spark, { w: 90, h: 22, color: p.spark.at(-1) >= p.spark[0] ? '#4ade80' : '#f05252' }) : '<span class="dim">collecting</span>'}</td><td>${p.safe ? '<span class="green">passes</span>' : `<span class="amber" title="${esc(p.why.join(' · '))}">${esc(p.why[0])}${p.why.length > 1 ? ` +${p.why.length - 1}` : ''}</span>`}</td></tr>`).join('')}</table>` : '<div class="empty">Looking for coins on DexScreener…</div>'}</div>
  <div class="grid" style="grid-template-columns:1fr 1fr">
    <div class="panel"><div class="ph"><span class="t">Closed paper trades</span></div>
      ${d.trades.length ? `<table><tr><th>Time</th><th>Coin</th><th class="num">In → out</th><th>Why</th><th class="num">P&amp;L</th></tr>${d.trades.slice(0, 15).map((t) => `<tr><td class="dim">${time(t.t)}</td><td>${esc(t.symbol)}</td><td class="num">${price(t.entry)} → ${price(t.exit)}</td><td>${t.why}</td><td class="num ${t.pnl >= 0 ? 'green' : 'red'}">${t.pnl >= 0 ? '+' : '-'}$${num(Math.abs(t.pnl), 2)}</td></tr>`).join('')}</table>` : '<div class="empty">No closed trades yet. The desk needs about 2 hours of prices per coin before it trades.</div>'}</div>
    <div class="panel"><div class="ph"><span class="t">How the desk works</span></div><div class="pb dim" style="line-height:1.7;font-size:12px">
      Every 10 minutes it looks for coins on ${esc(d.chain)}; every minute it reads their prices and builds 5-minute candles.
      A coin is skipped unless it has at least ${money(d.rules.minLiquidityUsd)} liquidity and ${money(d.rules.minVolume24hUsd)} daily volume, is ${d.rules.minAgeHours}+ hours old,
      has ${d.rules.minSells24h}+ sells a day (so it can be sold), a valuation under ${d.rules.maxFdvToLiquidity}× its liquidity, and moved under ${d.rules.maxMove1hPct}% in the last hour.
      It paper-buys a coin that closes above its last hour's high with more buyers than sellers, and sells at the stop, the target or after 4 hours, charging 1% for fees and slippage.
      <b>These checks cannot catch every scam.</b> Paper only: no real swaps are made.</div></div>
  </div>`;
}

export default {
  mount(el, s) { root = el; this.update(s); },
  update(s) { if (root) root.innerHTML = body(s); },
  unmount() { root = null; },
};
