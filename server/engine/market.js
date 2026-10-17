// Synthetic but realistic market data: regime-switching drift + clustered volatility.
// Deterministic per seed so backtests are reproducible.

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(r) {
  let u = 0, v = 0;
  while (!u) u = r();
  while (!v) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// contract = units per 1 standard lot; toUsd converts a quote-currency P&L to USD.
export const INSTRUMENTS = {
  EURUSD: { name: 'EUR/USD', start: 1.085, vol: 0.0011, contract: 100000, spread: 0.00008, digits: 5, toUsd: () => 1 },
  GBPUSD: { name: 'GBP/USD', start: 1.27, vol: 0.0013, contract: 100000, spread: 0.0001, digits: 5, toUsd: () => 1 },
  AUDUSD: { name: 'AUD/USD', start: 0.66, vol: 0.0013, contract: 100000, spread: 0.0001, digits: 5, toUsd: () => 1 },
  USDJPY: { name: 'USD/JPY', start: 151.2, vol: 0.0012, contract: 100000, spread: 0.012, digits: 3, toUsd: (p) => 1 / p },
  USDCAD: { name: 'USD/CAD', start: 1.36, vol: 0.001, contract: 100000, spread: 0.00012, digits: 5, toUsd: (p) => 1 / p },
  XAUUSD: { name: 'Gold', start: 2350, vol: 0.0022, contract: 100, spread: 0.3, digits: 2, toUsd: () => 1 },
};

const HOUR = 3600_000;

// Feed: an endless 1h bar generator; `history` is the backtest window, `next()` extends it (paper trading).
export class Feed {
  constructor(symbol, seed = hashStr(symbol)) {
    this.symbol = symbol;
    this.inst = INSTRUMENTS[symbol];
    this.r = rng(seed);
    this.price = this.inst.start;
    this.drift = 0;
    this.volState = 1;
    this.regimeLeft = 0;
    this.t = Date.UTC(2024, 0, 1);
    this.bars = [];
  }

  step() {
    const { r, inst } = this;
    if (this.regimeLeft-- <= 0) {
      const k = r();
      this.drift = k < 0.35 ? 0 : (k < 0.67 ? 1 : -1) * inst.vol * (0.004 + r() * 0.03);
      this.regimeLeft = 60 + Math.floor(r() * 400);
    }
    // Volatility clustering (mean-reverting log-vol) and a London/NY session bump.
    this.volState = Math.exp(0.94 * Math.log(this.volState) + 0.18 * gauss(r));
    const hour = new Date(this.t).getUTCHours();
    const session = hour >= 7 && hour <= 17 ? 1.35 : 0.7;
    const sigma = inst.vol * session * Math.min(3, Math.max(0.35, this.volState));
    const o = this.price;
    const c = o * Math.exp(this.drift + sigma * gauss(r));
    const h = Math.max(o, c) * (1 + Math.abs(gauss(r)) * sigma * 0.45);
    const l = Math.min(o, c) * (1 - Math.abs(gauss(r)) * sigma * 0.45);
    const bar = { t: this.t, o, h, l, c };
    this.price = c;
    do this.t += HOUR; while ([0, 6].includes(new Date(this.t).getUTCDay()));
    return bar;
  }

  generate(n) {
    for (let i = 0; i < n; i++) this.bars.push(this.step());
    return this.bars;
  }

  next() {
    const b = this.step();
    this.bars.push(b);
    if (this.bars.length > 20000) this.bars.splice(0, 5000);
    return b;
  }
}

export function resample(bars, factor) {
  const out = [];
  for (let i = 0; i + factor <= bars.length; i += factor) {
    const chunk = bars.slice(i, i + factor);
    out.push({
      t: chunk[0].t,
      o: chunk[0].o,
      h: Math.max(...chunk.map((b) => b.h)),
      l: Math.min(...chunk.map((b) => b.l)),
      c: chunk[chunk.length - 1].c,
    });
  }
  return out;
}
