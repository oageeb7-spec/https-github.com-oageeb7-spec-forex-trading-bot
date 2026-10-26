// DEX desk: scans a DexScreener chain (default: Robinhood Chain, https://dexscreener.com/robinhood)
// for meme-coin pairs, filters out the obvious traps, builds 5-minute candles from live prices and
// paper-trades the coins that pass. No real money: real swaps need a wallet (see docs/DEX.md).
//
// DexScreener's public API has no candle history, so the desk records its own: each tracked pair's
// price is read every minute and folded into 5-minute bars.

const API = () => process.env.DEXSCREENER_URL || 'https://api.dexscreener.com';
const MIN = 60_000, BAR = 5 * MIN, HOUR = 60 * MIN;

// Safety filter. Brand-new DEX coins are often traps (can't be sold, liquidity pulled, one wallet
// holding most of it); these checks drop the obvious ones. They cannot catch everything.
export const RULES = {
  minLiquidityUsd: Number(process.env.DEX_MIN_LIQUIDITY) || 25_000,
  minVolume24hUsd: Number(process.env.DEX_MIN_VOLUME) || 25_000,
  minAgeHours: Number(process.env.DEX_MIN_AGE_HOURS) || 6,
  minBuys24h: 20,
  minSells24h: 20, // people are actually selling: a coin nobody can sell is a trap
  maxFdvToLiquidity: 200, // a huge valuation on a thin pool is easy to crash
  maxMove1hPct: 60, // already up (or down) this much in an hour: too late, or collapsing
};

// Paper trading rules on 5-minute bars (long only: a DEX swap buys the coin).
const TRADE = { breakoutBars: 12, stopPct: 0.08, targetPct: 0.16, maxBars: 48, costPct: 0.01, minBars: 24 };

export function safety(p, now = Date.now(), r = RULES) {
  const why = [];
  const liq = p.liquidity?.usd ?? 0, vol = p.volume?.h24 ?? 0, tx = p.txns?.h24 || {};
  const age = p.pairCreatedAt ? (now - p.pairCreatedAt) / HOUR : 0;
  if (liq < r.minLiquidityUsd) why.push(`liquidity $${Math.round(liq).toLocaleString('en')}`);
  if (vol < r.minVolume24hUsd) why.push(`24h volume $${Math.round(vol).toLocaleString('en')}`);
  if (age < r.minAgeHours) why.push(`${age < 1 ? `${Math.round(age * 60)} min` : `${age.toFixed(1)} h`} old`);
  if ((tx.buys ?? 0) < r.minBuys24h) why.push(`${tx.buys ?? 0} buys in 24h`);
  if ((tx.sells ?? 0) < r.minSells24h) why.push(`${tx.sells ?? 0} sells in 24h (may not be sellable)`);
  const fdv = p.fdv ?? p.marketCap;
  if (fdv && liq && fdv / liq > r.maxFdvToLiquidity) why.push(`valuation ${Math.round(fdv / liq)}× its liquidity`);
  if (Math.abs(p.priceChange?.h1 ?? 0) > r.maxMove1hPct) why.push(`${Math.round(p.priceChange.h1)}% in 1h`);
  return { ok: !why.length, why };
}

export class DexDesk {
  constructor({ chain = 'robinhood', fetchImpl = fetch, emit = () => {}, tradeUsd = 100, maxOpen = 5, track = 30 } = {}) {
    this.chain = chain;
    this.fetch = fetchImpl;
    this.emit = emit;
    this.tradeUsd = tradeUsd;
    this.maxOpen = maxOpen;
    this.track = track;
    this.pairs = new Map(); // pairAddress -> { info, safety, bars, firstSeen }
    this.positions = new Map(); // pairAddress -> paper position
    this.trades = [];
    this.lastDiscover = 0;
    this.lastRefresh = 0;
    this.error = null;
  }

  async get(path) {
    const res = await this.fetch(`${API()}${path}`, { headers: { Accept: 'application/json', 'User-Agent': 'OS-Trading-AI' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`DexScreener returned ${res.status} for ${path.split('?')[0]}`);
    return res.json();
  }

  // Find pairs on the chain: searches plus the newest profiled and boosted tokens on it.
  async discover() {
    this.lastDiscover = this.lastRefresh = Date.now();
    const found = [];
    const queries = (process.env.DEX_QUERIES || 'robinhood,WETH,USDC,meme,cat,dog,pepe,hood').split(',');
    for (const q of queries) {
      try {
        const r = await this.get(`/latest/dex/search?q=${encodeURIComponent(q.trim())}`);
        found.push(...(r.pairs || []).filter((p) => p.chainId === this.chain));
      } catch (e) { this.error = e.message; }
    }
    const addrs = new Set();
    for (const path of ['/token-profiles/latest/v1', '/token-boosts/latest/v1', '/token-boosts/top/v1']) {
      try {
        for (const t of await this.get(path)) if (t.chainId === this.chain && t.tokenAddress) addrs.add(t.tokenAddress);
      } catch (e) { this.error = e.message; }
    }
    const list = [...addrs];
    for (let i = 0; i < list.length; i += 30) {
      try { found.push(...(await this.get(`/tokens/v1/${this.chain}/${list.slice(i, i + 30).join(',')}`)).filter((p) => p.chainId === this.chain)); } catch (e) { this.error = e.message; }
    }
    // Keep the most liquid pair per coin, then the most active coins.
    const best = new Map();
    for (const p of found) {
      const k = p.baseToken?.address;
      if (k && (!best.has(k) || (p.liquidity?.usd ?? 0) > (best.get(k).liquidity?.usd ?? 0))) best.set(k, p);
    }
    const ranked = [...best.values()].sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0)).slice(0, this.track);
    let added = 0;
    for (const p of ranked) {
      if (!this.pairs.has(p.pairAddress)) { this.pairs.set(p.pairAddress, { bars: [], firstSeen: Date.now() }); added++; }
      this.update(p);
    }
    // Stop tracking coins that dropped out, unless paper still holds them.
    const keep = new Set(ranked.map((p) => p.pairAddress));
    for (const k of [...this.pairs.keys()]) if (!keep.has(k) && !this.positions.has(k) && this.pairs.size > this.track) this.pairs.delete(k);
    if (ranked.length) this.error = null;
    this.emit('DEX', `DexScreener ${this.chain}: ${ranked.length} coins tracked (${added} new), ${[...this.pairs.values()].filter((x) => x.safety?.ok).length} pass the safety filter`);
  }

  // Every minute: fresh prices for every tracked pair (30 per request).
  async refresh() {
    this.lastRefresh = Date.now();
    const tokens = [...new Set([...this.pairs.values()].map((x) => x.info?.baseToken?.address).filter(Boolean))];
    for (let i = 0; i < tokens.length; i += 30) {
      try {
        const pairs = await this.get(`/tokens/v1/${this.chain}/${tokens.slice(i, i + 30).join(',')}`);
        for (const p of pairs) if (this.pairs.has(p.pairAddress)) this.update(p);
        this.error = null;
      } catch (e) { this.error = e.message; }
    }
    this.paperStep();
  }

  update(p) {
    const x = this.pairs.get(p.pairAddress);
    x.info = p;
    x.safety = safety(p);
    const price = Number(p.priceUsd), now = Date.now();
    if (!(price > 0)) return;
    const t = Math.floor(now / BAR) * BAR, last = x.bars.at(-1);
    if (last && last.t === t) Object.assign(last, { h: Math.max(last.h, price), l: Math.min(last.l, price), c: price });
    else x.bars.push({ t, o: price, h: price, l: price, c: price });
    if (x.bars.length > 600) x.bars.splice(0, x.bars.length - 600);
  }

  // Paper trading: buy a safe coin when it closes above its last hour's high with more buyers than
  // sellers in the past hour; sell at -8% (stop), +16% (target) or after 4 hours. 1% round-trip
  // cost covers the pool fee and slippage.
  paperStep() {
    for (const [k, x] of this.pairs) {
      const bars = x.bars, last = bars.at(-1);
      if (!last) continue;
      const pos = this.positions.get(k);
      if (pos) {
        pos.price = last.c;
        pos.held = Math.floor((last.t - pos.t) / BAR);
        const exit = last.l <= pos.stop ? pos.stop : last.h >= pos.target ? pos.target : pos.held >= TRADE.maxBars ? last.c : null;
        if (exit !== null) this.closePaper(k, x, pos, exit, exit === pos.stop ? 'stop' : exit === pos.target ? 'target' : 'time');
        continue;
      }
      if (!x.safety?.ok || this.positions.size >= this.maxOpen || bars.length < TRADE.minBars) continue;
      const closed = bars.slice(-TRADE.breakoutBars - 2, -1); // finished bars before the forming one
      const prev = closed.at(-1), hi = Math.max(...closed.slice(0, -1).map((b) => b.h));
      const h1 = x.info.txns?.h1 || {};
      if (prev && prev.c > hi && prev.t > (x.lastSignalT ?? 0) && (h1.buys ?? 0) > (h1.sells ?? 0)) {
        x.lastSignalT = prev.t; // one entry per breakout bar, even if the trade closes quickly
        const entry = last.c;
        this.positions.set(k, { pair: k, symbol: x.info.baseToken.symbol, name: x.info.baseToken.name, entry, price: entry, t: last.t, held: 0, usd: this.tradeUsd, stop: entry * (1 - TRADE.stopPct), target: entry * (1 + TRADE.targetPct), url: x.info.url });
        this.emit('DEX', `Paper BUY ${x.info.baseToken.symbol} at $${fmt(entry)} · breakout with ${h1.buys} buys / ${h1.sells} sells in 1h`);
      }
    }
  }

  closePaper(k, x, pos, exit, why) {
    const ret = exit / pos.entry - 1 - TRADE.costPct;
    const pnl = pos.usd * ret;
    this.trades.push({ symbol: pos.symbol, entry: pos.entry, exit, pnl, ret, why, t: Date.now(), held: pos.held, url: pos.url });
    if (this.trades.length > 300) this.trades.shift();
    this.positions.delete(k);
    this.emit('DEX', `Paper SELL ${pos.symbol} at $${fmt(exit)} (${why}) · ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
  }

  // Called from the server loop; discovery every 10 minutes, prices every minute.
  async tick(now = Date.now()) {
    if (now - this.lastDiscover >= 10 * MIN) await this.discover();
    else if (now - this.lastRefresh >= MIN) await this.refresh();
  }

  view() {
    const wins = this.trades.filter((t) => t.pnl > 0).length;
    return {
      chain: this.chain, error: this.error, lastRefresh: this.lastRefresh || null, rules: RULES, trade: { ...TRADE, usd: this.tradeUsd, maxOpen: this.maxOpen },
      pairs: [...this.pairs.entries()].map(([k, x]) => x.info && ({
        pair: k, symbol: x.info.baseToken?.symbol, name: x.info.baseToken?.name, dex: x.info.dexId, url: x.info.url,
        price: Number(x.info.priceUsd) || null, liquidity: x.info.liquidity?.usd ?? 0, volume24h: x.info.volume?.h24 ?? 0,
        change1h: x.info.priceChange?.h1 ?? null, change24h: x.info.priceChange?.h24 ?? null, fdv: x.info.fdv ?? x.info.marketCap ?? null,
        ageH: x.info.pairCreatedAt ? (Date.now() - x.info.pairCreatedAt) / HOUR : null, bars: x.bars.length,
        safe: x.safety.ok, why: x.safety.why, spark: x.bars.slice(-48).map((b) => b.c),
      })).filter(Boolean).sort((a, b) => b.safe - a.safe || b.volume24h - a.volume24h),
      positions: [...this.positions.values()].map((p) => ({ ...p, pnl: p.usd * (p.price / p.entry - 1 - TRADE.costPct) })),
      trades: this.trades.slice(-40).reverse(),
      stats: { trades: this.trades.length, wins, winrate: this.trades.length ? wins / this.trades.length : 0, net: this.trades.reduce((a, t) => a + t.pnl, 0) },
    };
  }

  save() {
    return { pairs: [...this.pairs.entries()].map(([k, x]) => [k, { info: x.info, bars: x.bars.slice(-300), firstSeen: x.firstSeen }]), positions: [...this.positions.entries()], trades: this.trades };
  }

  restore(s) {
    if (!s) return;
    this.pairs = new Map((s.pairs || []).filter(([, x]) => x.info).map(([k, x]) => [k, { ...x, safety: safety(x.info) }]));
    this.positions = new Map(s.positions || []);
    this.trades = s.trades || [];
  }
}

const fmt = (x) => (x >= 1 ? x.toFixed(4) : x.toPrecision(4));
