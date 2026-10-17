// Event-driven bar backtester: one position at a time, 1 standard lot, spread charged per round trip.
import { INSTRUMENTS } from './market.js';
import { TEMPLATES } from './strategies.js';

const DAY = 86400_000;

export function backtest(bars, template, params, symbol, { costMult = 1, from = 0, to = bars.length } = {}) {
  const inst = INSTRUMENTS[symbol];
  const signals = TEMPLATES[template].signals(bars, params);
  const trades = [];
  let busyUntil = -1;
  for (const s of signals) {
    if (s.i < from || s.i >= to - 1 || s.i <= busyUntil) continue;
    const entry = s.entry ?? bars[s.i].c;
    const risk = Math.abs(entry - s.stop);
    if (!(risk > 0)) continue;
    // Limit entries can fill and stop out on the same bar; market entries act from the next bar.
    let exit = null, j = s.entry != null ? s.i : s.i + 1;
    for (; j < to; j++) {
      const b = bars[j];
      const hitStop = s.dir > 0 ? b.l <= s.stop : b.h >= s.stop;
      // On a limit-entry bar the extreme may have printed before the fill, so only the stop counts.
      const hitTarget = j > s.i && (s.dir > 0 ? b.h >= s.target : b.l <= s.target);
      if (hitStop) { exit = s.stop; break; }
      if (hitTarget) { exit = s.target; break; }
      if (j - s.i >= s.maxBars) { exit = b.c; break; }
    }
    if (exit === null) { j = to - 1; exit = bars[j].c; }
    const move = (exit - entry) * s.dir - inst.spread * costMult;
    trades.push({
      entryT: bars[s.i].t, exitT: bars[j].t, dir: s.dir, entry, exit,
      r: move / risk,
      pnl: move * inst.contract * inst.toUsd(exit),
    });
    busyUntil = j;
  }
  return { trades, metrics: metrics(trades, bars[from].t, bars[to - 1].t, { weekends: inst.weekends }) };
}

export function metrics(trades, startT, endT, { weekends = false } = {}) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl <= 0);
  const avgWin = wins.length ? mean(wins.map((t) => t.pnl)) : 0;
  const avgLoss = losses.length ? Math.abs(mean(losses.map((t) => t.pnl))) : 0;

  let eq = 0, peak = 0, maxDD = 0;
  const equity = [0], drawdown = [0];
  for (const t of trades) {
    eq += t.pnl;
    peak = Math.max(peak, eq);
    maxDD = Math.min(maxDD, eq - peak);
    equity.push(eq);
    drawdown.push(eq - peak);
  }

  const days = Math.max(1, Math.round((endT - startT) / DAY));
  const daily = new Array(days + 1).fill(0);
  for (const t of trades) daily[Math.min(days, Math.floor((t.exitT - startT) / DAY))] += t.pnl;
  // FX and gold rest at weekends; 24/7 markets such as bitcoin keep every day and annualize over 365.
  const tradingDays = weekends ? daily : daily.filter((_, i) => ![0, 6].includes(new Date(startT + i * DAY).getUTCDay()));
  const sd = std(tradingDays);
  const sharpe = sd ? (mean(tradingDays) / sd) * Math.sqrt(weekends ? 365 : 252) : 0;

  const months = {};
  for (const t of trades) {
    const k = new Date(t.exitT).toISOString().slice(0, 7);
    months[k] = (months[k] || 0) + t.r;
  }
  const monthly = Object.entries(months).map(([month, r]) => ({ month, r: round(r, 2) }));

  return {
    trades: n,
    winrate: n ? wins.length / n : 0,
    rr: avgLoss ? avgWin / avgLoss : 0,
    expectancy: n ? mean(trades.map((t) => t.pnl)) : 0,
    expectancyR: n ? mean(trades.map((t) => t.r)) : 0,
    net: eq,
    maxDD,
    sharpe: round(sharpe, 2),
    equity,
    drawdown,
    monthly,
  };
}

export function downsample(arr, n = 48) {
  if (arr.length <= n) return arr.map((v) => round(v, 0));
  const out = [];
  for (let i = 0; i < n; i++) out.push(round(arr[Math.floor((i * (arr.length - 1)) / (n - 1))], 0));
  return out;
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
export const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
