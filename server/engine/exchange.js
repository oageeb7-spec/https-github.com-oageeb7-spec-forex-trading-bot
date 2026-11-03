// Exchange trader: turns opens and closes of *live* strategies into real spot orders on a crypto
// exchange (Binance, Kraken, Coinbase, Bybit, OKX, … through the ccxt library). Real money is at
// stake, so every order passes the guards in `allow()`, and the server watches each position's
// stop and target itself between candles.
//
// Spot accounts can only buy what they then own: OS AI buys on a long signal and sells that same
// amount to close. Short signals are never sent (meme coins are tested long-only for this reason).

const DAY = 86400_000;

export class ExchangeTrader {
  constructor({ client = null, name = '', quote = 'USDT', tradeUsd = 20, maxTradeUsd = 100, maxOpen = 3, maxDailyLoss = 50, passwordSet = false } = {}) {
    this.client = client; // a ccxt exchange instance, created with your API key on the server
    this.name = name;
    this.quote = quote;
    this.maxTradeUsd = maxTradeUsd;
    this.tradeUsd = Math.min(tradeUsd, maxTradeUsd);
    this.maxOpen = maxOpen;
    this.maxDailyLoss = maxDailyLoss;
    this.passwordSet = passwordSet;
    this.active = true; // false on a standby copy, so only one copy ever trades
    this.armed = false;
    this.killed = false;
    this.seq = 0;
    this.orders = [];
    this.positions = new Map(); // strategyId -> { symbol, market, amount, entry, stop, target, price, t }
    this.account = null; // { free, total } in the quote currency
    this.day = { day: 0, realized: 0 };
    this.lastOk = 0;
    this.events = [];
    this.chain = Promise.resolve();
  }

  get configured() { return Boolean(this.client) && this.active; }
  get connected() { return Date.now() - this.lastOk < 120_000; }

  note(text) {
    this.events.push({ t: Date.now(), text });
    if (this.events.length > 50) this.events.shift();
  }

  // Exchange orders run one at a time, in the order they were made.
  run(fn) {
    this.chain = this.chain.then(fn).catch((e) => this.note(`Exchange error: ${e.message}`));
    return this.chain;
  }

  market(symbol) {
    if (!/USD$/.test(symbol)) return null;
    return `${symbol.slice(0, -3)}/${this.quote}`;
  }

  // Your switch on the dashboard. Arming needs exchange keys and a dashboard password; without a
  // password anyone who finds the site could switch on real trading.
  arm(on) {
    if (on && !this.client) return 'Set EXCHANGE, EXCHANGE_API_KEY and EXCHANGE_SECRET on the server first.';
    if (on && !this.active) return 'This copy is on standby; try again.';
    if (on && !this.passwordSet) return 'Set DASHBOARD_PASSWORD first: arming real trading on an open dashboard is refused.';
    if (on && this.killed) this.killed = false;
    this.armed = !!on;
    this.note(on ? 'Live trading armed' : 'Live trading disarmed');
    return null;
  }

  kill(reason = 'Kill switch pressed') {
    this.armed = false;
    this.killed = true;
    this.note(`${reason}: trading disarmed, selling every OS AI position`);
    for (const id of [...this.positions.keys()]) this.close({ id, name: this.positions.get(id).name, symbol: this.positions.get(id).symbol }, reason);
  }

  allow(strategy, pos) {
    if (!this.configured) return 'exchange not connected';
    if (!this.armed) return 'live trading is not armed';
    if (this.killed) return 'kill switch is on';
    if (!this.market(strategy.symbol)) return `${strategy.symbol} does not trade on a crypto exchange`;
    if (pos.dir < 0) return 'spot accounts cannot sell short; long signals only';
    if (this.positions.has(strategy.id) || this.pendingOpen(strategy.id)) return 'already holding this strategy';
    const open = this.positions.size + this.orders.filter((o) => o.action === 'open' && ['queued', 'sending'].includes(o.status)).length;
    if (open >= this.maxOpen) return `already ${open} open trades (limit ${this.maxOpen})`;
    return null;
  }

  pendingOpen(id) { return this.orders.some((o) => o.action === 'open' && o.strategyId === id && ['queued', 'sending'].includes(o.status)); }

  push(order) {
    const o = { seq: ++this.seq, t: Date.now(), status: 'queued', ...order };
    this.orders.push(o);
    if (this.orders.length > 300) this.orders.splice(0, 100);
    return o;
  }

  // Called by the brain when a live strategy opens. Returns at once; the order runs in the background.
  open(strategy, pos) {
    const blocked = this.allow(strategy, pos);
    if (blocked) return { blocked };
    const o = this.push({ action: 'open', side: 'buy', strategyId: strategy.id, name: strategy.name, symbol: strategy.symbol, usd: this.tradeUsd });
    // Stop and target travel as distances from the signal's entry, applied to the real fill price.
    const stopPct = (pos.entry - pos.stop) / pos.entry, targetPct = Number.isFinite(pos.target) ? (pos.target - pos.entry) / pos.entry : null;
    this.run(() => this.execOpen(o, stopPct, targetPct));
    return { order: o, text: `BUY ${this.tradeUsd} ${this.quote} of ${this.market(strategy.symbol)} sent to ${this.name}` };
  }

  async execOpen(o, stopPct, targetPct) {
    if (!this.armed || this.killed) return this.finish(o, 'cancelled', 'disarmed before it was sent');
    o.status = 'sending';
    const c = this.client, m = this.market(o.symbol);
    try {
      await c.loadMarkets();
      if (!c.markets[m]) return this.finish(o, 'rejected', `${this.name} has no ${m} market`);
      const ticker = await c.fetchTicker(m);
      const price = ticker.last || ticker.ask;
      const amount = Number(c.amountToPrecision(m, o.usd / price));
      const min = c.markets[m].limits || {};
      if (min.amount?.min && amount < min.amount.min) return this.finish(o, 'rejected', `${o.usd} ${this.quote} is below ${this.name}'s minimum for ${m}`);
      if (min.cost?.min && o.usd < min.cost.min) return this.finish(o, 'rejected', `${o.usd} ${this.quote} is below ${this.name}'s minimum order of ${min.cost.min}`);
      const res = c.has.createMarketBuyOrderWithCost
        ? await c.createMarketBuyOrderWithCost(m, o.usd)
        : await c.createOrder(m, 'market', 'buy', amount);
      const fill = res.average || res.price || price, got = res.filled || amount;
      Object.assign(o, { status: 'filled', price: fill, amount: got, id: res.id });
      this.positions.set(o.strategyId, {
        strategyId: o.strategyId, name: o.name, symbol: o.symbol, market: m, amount: got, entry: fill, price: fill, t: Date.now(),
        stop: fill * (1 - stopPct), target: targetPct === null ? null : fill * (1 + targetPct),
      });
      this.lastOk = Date.now();
      this.note(`Bought ${got} ${m} at ${fill} for ${o.name}`);
    } catch (e) {
      this.finish(o, 'rejected', e.message);
    }
  }

  // Called by the brain when a live strategy closes, by the stop/target watch, and by the kill switch.
  // Selling is allowed even when disarmed, so a position is never stranded.
  close(strategy, why = 'strategy closed') {
    if (!this.client || !this.active) return { blocked: 'exchange not connected' };
    if (!this.positions.has(strategy.id) && !this.pendingOpen(strategy.id)) return { blocked: 'no live position for this strategy' };
    if (this.orders.some((o) => o.action === 'close' && o.strategyId === strategy.id && ['queued', 'sending'].includes(o.status))) return { blocked: 'already selling' };
    const o = this.push({ action: 'close', side: 'sell', strategyId: strategy.id, name: strategy.name, symbol: strategy.symbol, why });
    this.run(() => this.execClose(o));
    return { order: o, text: `SELL ${this.market(strategy.symbol)} sent to ${this.name} (${why})` };
  }

  async execClose(o) {
    const p = this.positions.get(o.strategyId);
    if (!p) return this.finish(o, 'cancelled', 'position already closed');
    o.status = 'sending';
    const c = this.client;
    try {
      // Fees can leave slightly less coin than was bought; never try to sell more than is free.
      const bal = await c.fetchBalance();
      const free = bal.free?.[p.market.split('/')[0]] ?? p.amount;
      const amount = Number(c.amountToPrecision(p.market, Math.min(p.amount, free)));
      const res = await c.createOrder(p.market, 'market', 'sell', amount);
      const fill = res.average || res.price || p.price;
      const pnl = (fill - p.entry) * amount;
      Object.assign(o, { status: 'filled', price: fill, amount, id: res.id, pnl });
      this.positions.delete(o.strategyId);
      this.today().realized += pnl;
      this.lastOk = Date.now();
      this.note(`Sold ${amount} ${p.market} at ${fill} (${o.why}) · ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} ${this.quote}`);
      this.checkDailyLoss();
    } catch (e) {
      this.finish(o, 'rejected', e.message);
    }
  }

  finish(o, status, error) {
    Object.assign(o, { status, error });
    this.note(`Order ${o.seq} (${o.side} ${o.symbol}) ${status}: ${error}`);
  }

  today() {
    const day = Math.floor(Date.now() / DAY);
    if (this.day.day !== day) this.day = { day, realized: 0 };
    return this.day;
  }

  unrealized() {
    let u = 0;
    for (const p of this.positions.values()) u += (p.price - p.entry) * p.amount;
    return u;
  }

  checkDailyLoss() {
    const pnl = this.today().realized + this.unrealized();
    if (pnl <= -this.maxDailyLoss && (this.armed || this.positions.size)) this.kill(`Daily loss limit hit (${pnl.toFixed(2)} ${this.quote})`);
  }

  // Every half minute: prices, balance, and each position's stop and target checked on the
  // exchange's own price, so a stop is not left waiting for the next hourly candle.
  async watch() {
    if (!this.configured) return;
    const c = this.client;
    try {
      const markets = [...new Set([...this.positions.values()].map((p) => p.market))];
      if (markets.length) {
        const tickers = c.has.fetchTickers ? await c.fetchTickers(markets) : Object.fromEntries(await Promise.all(markets.map(async (m) => [m, await c.fetchTicker(m)])));
        for (const p of this.positions.values()) {
          const price = tickers[p.market]?.last;
          if (!price) continue;
          p.price = price;
          if (price <= p.stop) this.close({ id: p.strategyId, name: p.name, symbol: p.symbol }, `stop ${p.stop.toPrecision(6)} hit`);
          else if (p.target && price >= p.target) this.close({ id: p.strategyId, name: p.name, symbol: p.symbol }, `target ${p.target.toPrecision(6)} hit`);
        }
      }
      const bal = await c.fetchBalance();
      this.account = { free: bal.free?.[this.quote] ?? 0, total: bal.total?.[this.quote] ?? 0 };
      this.lastOk = Date.now();
      this.lastError = null;
      this.checkDailyLoss();
    } catch (e) {
      if (this.lastError !== e.message) this.note(`Could not reach ${this.name}: ${e.message}`); // once, not every 30 s
      this.lastError = e.message;
    }
  }

  view() {
    return {
      kind: 'exchange', name: this.name, quote: this.quote,
      configured: this.configured, armed: this.armed, killed: this.killed, connected: this.connected, passwordSet: this.passwordSet,
      limits: { tradeUsd: this.tradeUsd, maxTradeUsd: this.maxTradeUsd, maxOpen: this.maxOpen, maxDailyLoss: this.maxDailyLoss },
      account: this.account,
      positions: [...this.positions.values()].map((p) => ({ ...p, pnl: (p.price - p.entry) * p.amount })),
      dayPnl: this.today().realized + this.unrealized(),
      orders: this.orders.slice(-30).reverse(), events: this.events.slice(-20).reverse(),
    };
  }

  save() {
    return { armed: this.armed, killed: this.killed, seq: this.seq, orders: this.orders.slice(-200), positions: [...this.positions.values()], day: this.day, events: this.events };
  }

  restore(s) {
    if (!s) return;
    // A restart never re-arms real trading by itself. Positions are real coins you hold, so they
    // are kept and their stops and targets are still watched.
    Object.assign(this, { killed: s.killed, seq: s.seq || 0, orders: s.orders || [], day: s.day || this.day, events: s.events || [] });
    for (const o of this.orders) if (['queued', 'sending'].includes(o.status)) Object.assign(o, { status: 'unknown', error: 'server restarted while sending; check the exchange' });
    this.positions = new Map((s.positions || []).map((p) => [p.strategyId, p]));
    if (s.armed) this.note('Restarted: live trading was armed before the restart and is now disarmed until you arm it again');
  }
}
