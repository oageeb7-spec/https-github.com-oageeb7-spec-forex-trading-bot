// "OS AI data": real hourly FX and gold prices from Yahoo Finance's public chart endpoint.
// No account or key is needed. Bid/ask spreads are not published there, so backtests charge
// each instrument's typical retail spread (INSTRUMENTS[symbol].spread) instead.
import { INSTRUMENTS } from './market.js';

const BASE = () => process.env.YAHOO_URL || 'https://query1.finance.yahoo.com';
const HOUR = 3600_000;

// Gold uses the COMEX front-month future (GC=F); Yahoo has no hourly spot gold series.
// Bitcoin (BTC-USD) trades around the clock, so its history includes weekends.
export const YAHOO_TICKERS = { EURUSD: 'EURUSD=X', GBPUSD: 'GBPUSD=X', AUDUSD: 'AUDUSD=X', USDJPY: 'JPY=X', USDCAD: 'CAD=X', XAUUSD: 'GC=F', BTCUSD: 'BTC-USD',
  DOGEUSD: 'DOGE-USD', SHIBUSD: 'SHIB-USD', PEPEUSD: 'PEPE24478-USD', BONKUSD: 'BONK-USD', WIFUSD: 'WIF-USD', FLOKIUSD: 'FLOKI-USD' };

export async function fetchBars(symbol, range) {
  const url = `${BASE()}/v8/finance/chart/${encodeURIComponent(YAHOO_TICKERS[symbol])}?interval=1h&range=${range}`;
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (OS Trading AI)', Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new Error(`cannot reach ${new URL(url).host}: ${e.cause?.code || e.cause?.message || e.message}`);
  }
  if (!res.ok) throw new Error(`price feed returned ${res.status} for ${symbol}`);
  const body = await res.json();
  const r = body.chart?.result?.[0];
  if (!r?.timestamp) throw new Error(`no price data for ${symbol}${body.chart?.error ? `: ${body.chart.error.description}` : ''}`);
  const q = r.indicators.quote[0];
  const now = Date.now();
  const bars = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const t = r.timestamp[i] * 1000;
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    // Skip gaps and the candle that is still forming.
    if ([o, h, l, c].some((v) => v == null || !Number.isFinite(v)) || t + HOUR > now) continue;
    if (bars.length && t <= bars[bars.length - 1].t) continue;
    bars.push({ t, o, h: Math.max(h, o, c), l: Math.min(l, o, c), c });
  }
  return { bars, price: r.meta?.regularMarketPrice ?? bars[bars.length - 1]?.c };
}

// Same shape as the synthetic Feed, so the brain can use either.
export class YahooFeed {
  constructor(symbol, bars, price) {
    this.symbol = symbol;
    this.inst = INSTRUMENTS[symbol];
    this.bars = bars;
    this.price = price;
    this.lastPoll = null;
    this.error = null;
  }

  next() {} // new candles arrive through poll()

  async poll() {
    try {
      const { bars, price } = await fetchBars(this.symbol, '5d');
      const last = this.bars[this.bars.length - 1].t;
      for (const b of bars) if (b.t > last) this.bars.push(b);
      if (Number.isFinite(price)) this.price = price;
      if (this.bars.length > 20000) this.bars.splice(0, 5000);
      this.lastPoll = Date.now();
      this.error = null;
    } catch (e) {
      this.error = e.message;
    }
  }
}

// Loads up to `bars` hourly candles (Yahoo keeps ~2 years) for each instrument. Instruments that
// fail are skipped with a warning; fewer than two loaded aborts instead of inventing prices.
export async function loadYahooFeeds({ bars = 8000, symbols = Object.keys(YAHOO_TICKERS), log = console.warn } = {}) {
  const feeds = {};
  await Promise.all(symbols.map(async (s) => {
    try {
      const { bars: hist, price } = await fetchBars(s, '730d');
      if (hist.length < 500) throw new Error(`only ${hist.length} candles returned`);
      feeds[s] = new YahooFeed(s, hist.slice(-bars), price);
    } catch (e) {
      log(`OS AI data: skipping ${s} — ${e.message}`);
    }
  }));
  if (Object.keys(feeds).length < 2) throw new Error('OS AI data: fewer than 2 instruments loaded (the sieve tests a second pair); check the server can reach query1.finance.yahoo.com');
  return { feeds: Object.fromEntries(symbols.filter((s) => feeds[s]).map((s) => [s, feeds[s]])) };
}
