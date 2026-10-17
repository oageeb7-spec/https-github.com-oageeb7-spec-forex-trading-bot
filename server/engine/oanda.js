// OANDA v20 REST market data: hourly history for backtests and a polled live feed for paper trading.
// Docs: https://developer.oanda.com/rest-live-v20/instrument-ep/
import { INSTRUMENTS } from './market.js';

const HOSTS = { practice: 'https://api-fxpractice.oanda.com', live: 'https://api-fxtrade.oanda.com' };
const MAX_COUNT = 5000; // OANDA's per-request candle limit

export const OANDA_NAMES = { EURUSD: 'EUR_USD', GBPUSD: 'GBP_USD', AUDUSD: 'AUD_USD', USDJPY: 'USD_JPY', USDCAD: 'USD_CAD', XAUUSD: 'XAU_USD' };

export class OandaClient {
  constructor({ token, env = 'practice', baseUrl } = {}) {
    if (!token) throw new Error('OANDA_API_KEY is not set');
    if (!baseUrl && !HOSTS[env]) throw new Error(`OANDA_ENV must be "practice" or "live", got "${env}"`);
    this.token = token;
    this.env = env;
    this.base = baseUrl || HOSTS[env];
  }

  async candles(symbol, { count = MAX_COUNT, to, from, granularity = 'H1' } = {}) {
    const q = new URLSearchParams({ granularity, price: 'MBA' });
    if (from) q.set('from', String(from / 1000));
    else q.set('count', String(Math.min(count, MAX_COUNT)));
    if (to && !from) q.set('to', String(to / 1000));
    const url = `${this.base}/v3/instruments/${OANDA_NAMES[symbol]}/candles?${q}`;
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}`, 'Accept-Datetime-Format': 'UNIX' },
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new Error(`cannot reach ${this.base}: ${e.cause?.code || e.cause?.message || e.message}`);
    }
    if (!res.ok) throw new Error(`OANDA ${res.status} for ${symbol}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    return body.candles.map((c) => ({
      t: Math.round(Number(c.time) * 1000),
      o: Number(c.mid.o), h: Number(c.mid.h), l: Number(c.mid.l), c: Number(c.mid.c),
      spread: c.ask && c.bid ? Number(c.ask.c) - Number(c.bid.c) : null,
      complete: c.complete,
    }));
  }

  // Walks backwards in 5000-candle pages until `n` completed hourly bars are collected.
  async history(symbol, n) {
    const seen = new Map();
    let to;
    while (seen.size < n) {
      const page = await this.candles(symbol, { count: Math.min(MAX_COUNT, n - seen.size + 1), to });
      const before = seen.size;
      for (const c of page) if (c.complete) seen.set(c.t, c);
      if (!page.length || seen.size === before) break;
      to = page[0].t;
    }
    return [...seen.values()].sort((a, b) => a.t - b.t).slice(-n);
  }
}

// Same shape as the synthetic Feed (symbol, inst, bars, price, next) so the brain can use either.
export class OandaFeed {
  constructor(client, symbol, bars, spread) {
    this.client = client;
    this.symbol = symbol;
    this.inst = INSTRUMENTS[symbol];
    this.bars = bars.map(({ t, o, h, l, c }) => ({ t, o, h, l, c }));
    this.price = bars[bars.length - 1].c;
    this.spread = spread;
    this.lastPoll = null;
    this.error = null;
  }

  next() {} // live bars arrive through poll()

  async poll() {
    try {
      const last = this.bars[this.bars.length - 1].t;
      const fresh = await this.client.candles(this.symbol, { from: last + 1 });
      for (const c of fresh) {
        if (c.complete && c.t > this.bars[this.bars.length - 1].t) this.bars.push({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c });
      }
      if (fresh.length) this.price = fresh[fresh.length - 1].c;
      if (this.bars.length > 20000) this.bars.splice(0, 5000);
      this.lastPoll = Date.now();
      this.error = null;
    } catch (e) {
      this.error = e.message;
    }
  }
}

const median = (a) => {
  const s = a.filter((x) => x > 0).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

// Loads history for every instrument. Instruments the account cannot trade are skipped with a
// warning; if none load, this throws rather than silently falling back to fake data.
export async function loadOandaFeeds({ token, env, baseUrl, bars = 8000, symbols = Object.keys(OANDA_NAMES), log = console.warn }) {
  const client = new OandaClient({ token, env, baseUrl });
  const feeds = {};
  await Promise.all(symbols.map(async (s) => {
    try {
      const hist = await client.history(s, bars);
      if (hist.length < 500) throw new Error(`only ${hist.length} candles returned`);
      const spread = median(hist.slice(-2000).map((c) => c.spread));
      // Backtests charge the instrument's real median bid/ask spread instead of the default.
      if (spread) INSTRUMENTS[s].spread = spread;
      feeds[s] = new OandaFeed(client, s, hist, spread);
    } catch (e) {
      log(`OANDA: skipping ${s} — ${e.message}`);
    }
  }));
  if (Object.keys(feeds).length < 2) throw new Error('OANDA: fewer than 2 instruments loaded (the sieve tests a second pair); check OANDA_API_KEY and OANDA_ENV');
  return { client, feeds: Object.fromEntries(symbols.filter((s) => feeds[s]).map((s) => [s, feeds[s]])) };
}
