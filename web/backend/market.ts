// Market data and pair maths for OS AI Trading.
// Prices come from Yahoo's free chart JSON (delayed, unofficial). Gold and silver
// use the COMEX front-month futures (GC=F, SI=F), which trade a few dollars off spot.

export type Bar = { t: number; open: number; high: number; low: number; close: number; vol: number };

type Metal = { contract: number; pip: number; dec: number; future: string };

const METALS: Record<string, Metal> = {
  XAU: { contract: 100, pip: 0.1, dec: 2, future: 'GC=F' },
  XAG: { contract: 5000, pip: 0.01, dec: 3, future: 'SI=F' },
};

// crypto, USD-quoted only. Broker convention: 1 lot = 1 coin, 1 pip = $1. Trades 24/7.
const CRYPTO: Record<string, { contract: number; pip: number; dec: number; symbol: string }> = {
  BTC: { contract: 1, pip: 1, dec: 2, symbol: 'BTC-USD' },
};

const CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD']);

export const PAIRS = [
  'EURUSD', 'XAUUSD', 'BTCUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD',
  'EURGBP', 'EURJPY', 'GBPJPY', 'XAGUSD',
];

export const TIMEFRAMES: Record<string, { interval: string; range: string; merge: number }> = {
  '15m': { interval: '15m', range: '5d', merge: 1 },
  '1h': { interval: '1h', range: '1mo', merge: 1 },
  '4h': { interval: '1h', range: '3mo', merge: 4 },
  '1d': { interval: '1d', range: '1y', merge: 1 },
};

export class MarketError extends Error {}

export function normPair(raw: string): string {
  const p = String(raw || '').toUpperCase().replace(/[\/_\-\s]|=X/g, '');
  const alias: Record<string, string> = { GOLD: 'XAUUSD', SILVER: 'XAGUSD', BITCOIN: 'BTCUSD', BTC: 'BTCUSD', XBTUSD: 'BTCUSD' };
  const pair = alias[p] || p;
  const base = pair.slice(0, 3);
  const quote = pair.slice(3);
  if (base in CRYPTO && quote !== 'USD') throw new MarketError(`${base} is only supported against USD (use ${base}USD)`);
  const baseOk = CURRENCIES.has(base) || base in METALS || base in CRYPTO;
  if (pair.length !== 6 || !baseOk || !CURRENCIES.has(quote) || base === quote) {
    throw new MarketError(`Not a supported pair: ${raw}`);
  }
  return pair;
}

export const isMetal = (pair: string) => pair.slice(0, 3) in METALS;

/** Crypto trades 24/7: no FX sessions, no weekend close. */
export const isCrypto = (pair: string) => pair.slice(0, 3) in CRYPTO;

export function pipSize(pair: string): number {
  if (isCrypto(pair)) return CRYPTO[pair.slice(0, 3)].pip;
  if (isMetal(pair)) return METALS[pair.slice(0, 3)].pip;
  return pair.slice(3) === 'JPY' ? 0.01 : 0.0001;
}

export function decimals(pair: string): number {
  if (isCrypto(pair)) return CRYPTO[pair.slice(0, 3)].dec;
  if (isMetal(pair)) return METALS[pair.slice(0, 3)].dec;
  return pair.slice(3) === 'JPY' ? 3 : 5;
}

export function contract(pair: string): number {
  if (isCrypto(pair)) return CRYPTO[pair.slice(0, 3)].contract;
  return isMetal(pair) ? METALS[pair.slice(0, 3)].contract : 100000;
}

export function yahooSymbol(pair: string): string {
  if (isCrypto(pair)) return CRYPTO[pair.slice(0, 3)].symbol;
  if (isMetal(pair) && pair.slice(3) === 'USD') return METALS[pair.slice(0, 3)].future;
  return `${pair}=X`;
}

export const roundTo = (x: number, dec: number) => Number(x.toFixed(dec));

export function fmt(pair: string, x: number): string {
  return x.toFixed(decimals(pair));
}

/** Yahoo chart JSON -> sorted bars, dropping the null bars Yahoo sends for closed hours. */
export function parseChart(data: unknown): Bar[] {
  const chart = (data as { chart?: { result?: unknown[]; error?: unknown } })?.chart;
  const res = chart?.result?.[0] as
    | { timestamp?: number[]; indicators?: { quote?: Array<Record<string, Array<number | null>>> } }
    | undefined;
  if (!res) {
    throw new MarketError('The price feed sent no bars' + (chart?.error ? `: ${JSON.stringify(chart.error)}` : ''));
  }
  const q = res.indicators?.quote?.[0] || {};
  const bars: Bar[] = [];
  (res.timestamp || []).forEach((t, i) => {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) return;
    bars.push({ t, open: o, high: h, low: l, close: c, vol: q.volume?.[i] ?? 0 });
  });
  bars.sort((a, b) => a.t - b.t);
  return bars;
}

/** Merge 1h bars into n-hour bars on UTC boundaries (4h: 0, 4, 8, ...). */
export function merge(bars: Bar[], n: number): Bar[] {
  if (n === 1) return bars;
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let key: number | null = null;
  for (const b of bars) {
    const k = Math.floor(b.t / (3600 * n));
    if (k !== key) {
      if (cur) out.push(cur);
      cur = { ...b, t: k * 3600 * n };
      key = k;
    } else if (cur) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.vol += b.vol;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const cache = new Map<string, { at: number; bars: Bar[] }>();
const CACHE_MS = 30_000;

async function yahoo(symbol: string, interval: string, range: string): Promise<unknown> {
  let last: unknown = null;
  for (const host of ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: ctrl.signal });
      if (!r.ok) {
        last = new MarketError(`price feed answered HTTP ${r.status}`);
        continue;
      }
      return await r.json();
    } catch (e) {
      last = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new MarketError(`Could not load prices for ${symbol} (${last instanceof Error ? last.message : 'network error'})`);
}

export async function fetchBars(pair: string, tf: string): Promise<Bar[]> {
  const spec = TIMEFRAMES[tf];
  if (!spec) throw new MarketError(`Timeframe must be one of ${Object.keys(TIMEFRAMES).join(', ')}`);
  const key = `${pair}:${tf}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.bars;
  const bars = merge(parseChart(await yahoo(yahooSymbol(pair), spec.interval, spec.range)), spec.merge);
  if (!bars.length) throw new MarketError(`No ${tf} bars for ${pair} right now (market closed?)`);
  cache.set(key, { at: Date.now(), bars });
  return bars;
}

/** Latest price of a pair from Yahoo's quote meta. */
export async function lastPrice(pair: string): Promise<number> {
  const data = await yahoo(yahooSymbol(pair), '1d', '5d');
  const meta = (data as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } })?.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  if (!price) throw new MarketError(`No price for ${pair}`);
  return price;
}

/** USD per one unit of `ccy`. */
async function usdPer(ccy: string): Promise<number> {
  if (ccy === 'USD') return 1;
  if (ccy in METALS) return lastPrice(`${ccy}USD`);
  try {
    return await lastPrice(`${ccy}USD`);
  } catch {
    return 1 / (await lastPrice(`USD${ccy}`));
  }
}

export type SizeInput = {
  pair: string; entry: number; stop: number; target?: number;
  account: number; riskPct: number; leverage: number;
};

/** Lots for a USD account: risk-based size, capped by leverage. */
export async function size(input: SizeInput) {
  const { pair, entry, stop, target, account, riskPct, leverage } = input;
  if (!(entry > 0) || !(stop > 0)) throw new MarketError('Entry and stop must be positive prices');
  if (entry === stop) throw new MarketError('The stop cannot equal the entry');
  if (!(account > 0)) throw new MarketError('Account size must be more than 0');
  if (!(riskPct > 0 && riskPct <= 10)) throw new MarketError('Risk must be between 0 and 10 percent');
  if (!(leverage >= 1 && leverage <= 500)) throw new MarketError('Leverage must be between 1 and 500');
  const side = stop < entry ? 'buy' : 'sell';
  if (target != null && (target - entry) * (side === 'buy' ? 1 : -1) <= 0) {
    throw new MarketError(`For a ${side}, the target must be ${side === 'buy' ? 'above' : 'below'} the entry`);
  }
  const ps = pipSize(pair);
  const base = pair.slice(0, 3);
  const quote = pair.slice(3);
  const pipValue = quote === 'USD' ? contract(pair) * ps
    : base === 'USD' ? (contract(pair) * ps) / entry
      : contract(pair) * ps * (await usdPer(quote));
  const notionalPerLot = base === 'USD' ? contract(pair)
    : quote === 'USD' ? contract(pair) * entry
      : contract(pair) * (await usdPer(base));
  const stopPips = Math.abs(entry - stop) / ps;
  const maxLoss = (account * riskPct) / 100;
  const step = 0.01;
  const byRisk = Math.floor(maxLoss / (stopPips * pipValue) / step + 1e-9) * step;
  const byLeverage = Math.floor((account * leverage) / notionalPerLot / step + 1e-9) * step;
  const lots = roundTo(Math.min(byRisk, byLeverage), 2);
  const targetPips = target != null ? Math.abs(target - entry) / ps : null;
  return {
    pair, side, lots,
    // currencies trade in whole units; a coin splits (0.44 lots = 0.44 BTC)
    units: isCrypto(pair) ? roundTo(lots * contract(pair), 2) : Math.round(lots * contract(pair)),
    unitName: isMetal(pair) ? 'oz' : isCrypto(pair) ? pair.slice(0, 3) : 'units',
    limit: lots === roundTo(byRisk, 2) ? 'max loss' : 'leverage',
    byRisk: roundTo(byRisk, 2), byLeverage: roundTo(byLeverage, 2),
    pipValue: roundTo(pipValue, 2), stopPips: roundTo(stopPips, 1),
    targetPips: targetPips == null ? null : roundTo(targetPips, 1),
    maxLoss: roundTo(maxLoss, 2),
    lossAtStop: roundTo(lots * stopPips * pipValue, 2),
    gainAtTarget: targetPips == null ? null : roundTo(lots * targetPips * pipValue, 2),
    margin: roundTo((lots * notionalPerLot) / leverage, 2),
    rewardRisk: targetPips == null ? null : roundTo(targetPips / stopPips, 2),
  };
}

const SESSIONS: Array<[string, string, number, number]> = [
  ['Sydney', 'Australia/Sydney', 7, 16],
  ['Tokyo', 'Asia/Tokyo', 9, 18],
  ['London', 'Europe/London', 8, 17],
  ['New York', 'America/New_York', 8, 17],
];

function localParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '';
  return { weekday: get('weekday'), hour: Number(get('hour')), minute: Number(get('minute')) };
}

/** FX is open Sunday 17:00 to Friday 17:00 New York time. */
export function clock(now = new Date()) {
  const ny = localParts(now, 'America/New_York');
  const closed = ny.weekday === 'Sat' || (ny.weekday === 'Fri' && ny.hour >= 17) || (ny.weekday === 'Sun' && ny.hour < 17);
  const live = closed ? [] : SESSIONS.filter(([, tz, open, close]) => {
    const p = localParts(now, tz);
    return p.weekday !== 'Sat' && p.weekday !== 'Sun' && p.hour >= open && p.hour < close;
  }).map(([name]) => name);
  return {
    open: !closed,
    sessions: live,
    overlap: live.includes('London') && live.includes('New York'),
    newYork: `${ny.weekday} ${String(ny.hour).padStart(2, '0')}:${String(ny.minute).padStart(2, '0')}`,
  };
}
