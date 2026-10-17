// Strategy templates ("recipes"). Each turns bars + params into entry signals:
// { i, dir, stop, target, maxBars } — entry at the close of bar i.
import { ema, sma, stdev, atr, highest, lowest } from './indicators.js';

const P = (name, def, min, max, int = true) => ({ name, def, min, max, int });

export const TEMPLATES = {
  trend: {
    label: 'Trend-follower',
    blurb: 'EMA crossover in the direction of the trend, ATR stop, fixed R target.',
    params: [P('fast', 20, 5, 60), P('slow', 80, 30, 250), P('stopAtr', 2.2, 1, 4, false), P('rr', 2.5, 1, 5, false)],
    signals(bars, p) {
      const c = bars.map((b) => b.c), f = ema(c, p.fast), s = ema(c, p.slow), a = atr(bars);
      const out = [];
      for (let i = p.slow; i < bars.length; i++) {
        const up = f[i] > s[i] && f[i - 1] <= s[i - 1], dn = f[i] < s[i] && f[i - 1] >= s[i - 1];
        if (up || dn) out.push(bracket(i, up ? 1 : -1, c[i], a[i] * p.stopAtr, p.rr, 300));
      }
      return out;
    },
  },
  breakout: {
    label: 'Breakout',
    blurb: 'Close above the N-bar high (or below the low) enters with the break.',
    params: [P('lookback', 40, 10, 120), P('stopAtr', 1.8, 0.8, 4, false), P('rr', 2, 1, 5, false)],
    signals(bars, p) {
      const H = bars.map((b) => b.h), L = bars.map((b) => b.l), a = atr(bars);
      const out = [];
      for (let i = p.lookback + 1; i < bars.length; i++) {
        const hi = highest(H, p.lookback, i - 1), lo = lowest(L, p.lookback, i - 1), c = bars[i].c;
        if (c > hi && bars[i - 1].c <= hi) out.push(bracket(i, 1, c, a[i] * p.stopAtr, p.rr, 200));
        else if (c < lo && bars[i - 1].c >= lo) out.push(bracket(i, -1, c, a[i] * p.stopAtr, p.rr, 200));
      }
      return out;
    },
  },
  meanrev: {
    label: 'Range fade',
    blurb: 'Fade closes outside the Bollinger band back toward the mean.',
    params: [P('period', 20, 10, 60), P('k', 2.2, 1.5, 3.2, false), P('stopAtr', 1.5, 0.8, 3, false)],
    signals(bars, p) {
      const c = bars.map((b) => b.c), m = sma(c, p.period), sd = stdev(c, p.period), a = atr(bars);
      const out = [];
      for (let i = p.period + 1; i < bars.length; i++) {
        const up = m[i] + p.k * sd[i], lo = m[i] - p.k * sd[i];
        if (c[i] < lo && c[i - 1] >= m[i - 1] - p.k * sd[i - 1])
          out.push({ i, dir: 1, stop: c[i] - a[i] * p.stopAtr, target: m[i], maxBars: 40 });
        else if (c[i] > up && c[i - 1] <= m[i - 1] + p.k * sd[i - 1])
          out.push({ i, dir: -1, stop: c[i] + a[i] * p.stopAtr, target: m[i], maxBars: 40 });
      }
      return out;
    },
  },
  momentum: {
    label: 'Time-series momentum',
    blurb: 'Hold the sign of the past L-bar return for H bars, wide ATR stop.',
    params: [P('lookback', 120, 24, 400), P('hold', 48, 12, 160), P('stopAtr', 4, 2, 7, false)],
    signals(bars, p) {
      const c = bars.map((b) => b.c), a = atr(bars);
      // Rebalance on a clock anchored to time, not to the window start, so a sliding live
      // window keeps the same rebalance bars as the backtest.
      const step = bars.length > 1 ? Math.min(...bars.slice(1, 50).map((b, k) => b.t - bars[k].t)) : 3600_000;
      const out = [];
      for (let i = p.lookback; i < bars.length; i++) {
        if (Math.round(bars[i].t / step) % p.hold !== 0) continue;
        const dir = Math.sign(c[i] - c[i - p.lookback]);
        if (dir) out.push({ i, dir, stop: c[i] - dir * a[i] * p.stopAtr, target: dir * Infinity, maxBars: p.hold });
      }
      return out;
    },
  },
  squeeze: {
    label: 'Volatility squeeze',
    blurb: 'Bollinger bandwidth compresses, then trade the first close outside the band.',
    params: [P('period', 20, 10, 50), P('squeeze', 0.7, 0.4, 0.95, false), P('stopAtr', 1.5, 0.8, 3, false), P('rr', 2.2, 1, 5, false)],
    signals(bars, p) {
      const c = bars.map((b) => b.c), m = sma(c, p.period), sd = stdev(c, p.period), a = atr(bars);
      const bw = c.map((_, i) => (4 * sd[i]) / m[i]), avg = sma(bw.map((x) => (isNaN(x) ? 0 : x)), 100);
      const out = [];
      for (let i = 101; i < bars.length; i++) {
        if (!(bw[i - 1] < avg[i - 1] * p.squeeze)) continue;
        if (c[i] > m[i] + 2 * sd[i]) out.push(bracket(i, 1, c[i], a[i] * p.stopAtr, p.rr, 120));
        else if (c[i] < m[i] - 2 * sd[i]) out.push(bracket(i, -1, c[i], a[i] * p.stopAtr, p.rr, 120));
      }
      return out;
    },
  },
  fvg: {
    label: 'Fair value gap',
    blurb: 'With the trend, buy the first retrace into a fresh 3-candle imbalance.',
    params: [P('trend', 100, 30, 250), P('minGapAtr', 0.3, 0.1, 1, false), P('rr', 2, 1, 4, false)],
    signals(bars, p) {
      const c = bars.map((b) => b.c), t = ema(c, p.trend), a = atr(bars);
      const out = [];
      for (let i = p.trend; i < bars.length - 1; i++) {
        const bull = bars[i].l - bars[i - 2].h, bear = bars[i - 2].l - bars[i].h;
        const dir = bull > a[i] * p.minGapAtr && c[i] > t[i] ? 1 : bear > a[i] * p.minGapAtr && c[i] < t[i] ? -1 : 0;
        if (!dir) continue;
        const edge = dir > 0 ? bars[i].l : bars[i].h, far = dir > 0 ? bars[i - 2].h : bars[i - 2].l;
        for (let j = i + 1; j < Math.min(bars.length, i + 20); j++) {
          if (dir > 0 ? bars[j].l <= edge : bars[j].h >= edge) {
            const risk = Math.abs(edge - far) + a[j] * 0.3;
            out.push({ i: j, dir, entry: edge, stop: edge - dir * risk, target: edge + dir * risk * p.rr, maxBars: 80 });
            break;
          }
        }
      }
      return out;
    },
  },
};

function bracket(i, dir, price, risk, rr, maxBars) {
  return { i, dir, stop: price - dir * risk, target: price + dir * risk * rr, maxBars };
}

export function defaults(template) {
  return Object.fromEntries(TEMPLATES[template].params.map((p) => [p.name, p.def]));
}

// Random perturbation of params within their bounds (variants in the lab).
export function mutate(template, base, r, spread = 0.35) {
  const out = {};
  for (const p of TEMPLATES[template].params) {
    let v = base[p.name] * (1 + (r() * 2 - 1) * spread);
    v = Math.min(p.max, Math.max(p.min, v));
    out[p.name] = p.int ? Math.round(v) : Math.round(v * 100) / 100;
  }
  if (out.fast && out.slow && out.fast >= out.slow) out.slow = out.fast + 10;
  return out;
}

export function scale(template, params, factor) {
  const out = {};
  for (const p of TEMPLATES[template].params) {
    const v = params[p.name] * factor;
    out[p.name] = p.int ? Math.max(1, Math.round(v)) : v;
  }
  if (out.fast && out.slow && out.fast >= out.slow) out.slow = out.fast + 5;
  return out;
}
