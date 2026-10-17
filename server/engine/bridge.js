// MetaTrader bridge: turns opens and closes of *live* strategies into orders that the OS AI
// Expert Advisor (mt/OSAI_Bridge.mq4 / .mq5) fetches, executes on your MT4/MT5 account, and
// reports back. Real money is at stake, so every order passes the guards in `allow()`.
//
// Wire format is plain text (simple to parse in MQL), one record per line, fields split by "|":
//   GET  /api/bridge/orders?after=SEQ  ->  seq|open|strategyId|SYMBOL|buy/sell|lots|sl|tp
//                                          seq|close|strategyId|SYMBOL
//                                          seq|close_all
//   POST /api/bridge/report  <-  ACCOUNT|login|server|currency|balance|equity
//                                FILL|seq|ticket|price
//                                REJECT|seq|code|message
//                                POS|strategyId|ticket|SYMBOL|buy/sell|lots|openPrice|profit

const DAY = 86400_000;

export class Bridge {
  constructor({ token = '', lots = 0.01, maxLots = 0.1, maxOpen = 3, maxDailyLoss = 100, passwordSet = false } = {}) {
    this.token = token;
    this.lots = Math.min(lots, maxLots);
    this.maxLots = maxLots;
    this.maxOpen = maxOpen;
    this.maxDailyLoss = maxDailyLoss;
    this.passwordSet = passwordSet;
    this.armed = false;
    this.killed = false;
    this.seq = 0;
    this.orders = [];
    this.account = null; // last ACCOUNT report from the EA
    this.positions = [];
    this.lastSeen = 0;
    this.dayStart = null; // { day, equity } for the daily loss limit
    this.events = [];
  }

  get configured() { return Boolean(this.token); }
  get connected() { return Date.now() - this.lastSeen < 60_000; }

  note(text) {
    this.events.push({ t: Date.now(), text });
    if (this.events.length > 50) this.events.shift();
  }

  // Your switch on the dashboard. Arming needs the EA token and a dashboard password; without a
  // password anyone who finds the site could switch on real trading.
  arm(on) {
    if (on && !this.configured) return 'Set BRIDGE_TOKEN on the server first.';
    if (on && !this.passwordSet) return 'Set DASHBOARD_PASSWORD first: arming real trading on an open dashboard is refused.';
    if (on && this.killed) this.killed = false;
    this.armed = !!on;
    this.note(on ? 'Live trading armed' : 'Live trading disarmed');
    return null;
  }

  kill(reason = 'Kill switch pressed') {
    this.armed = false;
    this.killed = true;
    this.push({ action: 'close_all' });
    this.note(`${reason}: trading disarmed, closing all OS AI positions`);
  }

  allow(kind) {
    if (!this.configured) return 'bridge not configured';
    if (!this.armed) return 'live trading is not armed';
    if (this.killed) return 'kill switch is on';
    if (kind === 'open') {
      const open = new Set(this.positions.map((p) => p.strategyId));
      for (const o of this.orders) if (o.action === 'open' && ['queued', 'sent'].includes(o.status)) open.add(o.strategyId);
      if (open.size >= this.maxOpen) return `already ${open.size} open trades (limit ${this.maxOpen})`;
    }
    return null;
  }

  push(order) {
    const o = { seq: ++this.seq, t: Date.now(), status: 'queued', ...order };
    this.orders.push(o);
    if (this.orders.length > 300) this.orders.splice(0, 100);
    return o;
  }

  open(strategy, pos) {
    const blocked = this.allow('open');
    if (blocked) return { blocked };
    const o = this.push({
      action: 'open', strategyId: strategy.id, name: strategy.name, symbol: strategy.symbol,
      dir: pos.dir > 0 ? 'buy' : 'sell', lots: this.lots,
      sl: pos.stop, tp: Number.isFinite(pos.target) ? pos.target : 0,
    });
    this.note(`Order ${o.seq}: ${o.dir} ${o.lots} ${o.symbol} for ${o.name}`);
    return { order: o };
  }

  close(strategy) {
    // Closing is always allowed while configured, even when disarmed, so positions never get stranded.
    if (!this.configured) return { blocked: 'bridge not configured' };
    const held = this.positions.some((p) => p.strategyId === strategy.id)
      || this.orders.some((o) => o.action === 'open' && o.strategyId === strategy.id && ['queued', 'sent', 'filled'].includes(o.status));
    if (!held) return { blocked: 'no live position for this strategy' };
    const o = this.push({ action: 'close', strategyId: strategy.id, name: strategy.name, symbol: strategy.symbol });
    this.note(`Order ${o.seq}: close ${o.symbol} for ${o.name}`);
    return { order: o };
  }

  // Orders the EA has not seen yet. Orders older than 2 minutes are expired rather than sent late.
  pending(after) {
    const now = Date.now();
    for (const o of this.orders) if (o.status === 'queued' && o.action === 'open' && now - o.t > 120_000) { o.status = 'expired'; this.note(`Order ${o.seq} expired: EA did not collect it in time`); }
    const out = this.orders.filter((o) => o.seq > after && (o.status === 'queued' || o.status === 'sent'));
    for (const o of out) o.status = 'sent';
    this.lastSeen = now;
    return out.map((o) => (o.action === 'open'
      ? [o.seq, 'open', o.strategyId, o.symbol, o.dir, o.lots, fmt(o.sl), fmt(o.tp)]
      : o.action === 'close' ? [o.seq, 'close', o.strategyId, o.symbol] : [o.seq, 'close_all']).join('|')).join('\n');
  }

  report(text) {
    this.lastSeen = Date.now();
    const positions = [];
    let sawPositions = false;
    for (const line of String(text).split(/\r?\n/)) {
      const f = line.trim().split('|');
      if (f[0] === 'ACCOUNT' && f.length >= 6) {
        this.account = { login: f[1], server: f[2], currency: f[3], balance: Number(f[4]), equity: Number(f[5]), at: Date.now() };
        this.checkDailyLoss();
      } else if (f[0] === 'FILL') {
        const o = this.orders.find((x) => x.seq === Number(f[1]));
        if (o) Object.assign(o, { status: 'filled', ticket: f[2], price: Number(f[3]) }), this.note(`Order ${o.seq} filled, ticket ${f[2]} at ${f[3]}`);
      } else if (f[0] === 'REJECT') {
        const o = this.orders.find((x) => x.seq === Number(f[1]));
        if (o) Object.assign(o, { status: 'rejected', error: `${f[2]} ${f[3] || ''}`.trim() }), this.note(`Order ${o.seq} rejected by the broker: ${o.error}`);
      } else if (f[0] === 'POS' && f.length >= 8) {
        sawPositions = true;
        positions.push({ strategyId: f[1], ticket: f[2], symbol: f[3], dir: f[4], lots: Number(f[5]), openPrice: Number(f[6]), profit: Number(f[7]) });
      } else if (f[0] === 'NOPOS') sawPositions = true;
    }
    if (sawPositions) this.positions = positions;
    return 'OK';
  }

  checkDailyLoss() {
    const day = Math.floor(Date.now() / DAY);
    if (!this.dayStart || this.dayStart.day !== day) this.dayStart = { day, equity: this.account.equity };
    const loss = this.dayStart.equity - this.account.equity;
    if (loss >= this.maxDailyLoss && this.armed) this.kill(`Daily loss limit hit (${loss.toFixed(2)} ${this.account.currency})`);
  }

  view() {
    return {
      configured: this.configured, armed: this.armed, killed: this.killed, connected: this.connected,
      lastSeen: this.lastSeen || null, passwordSet: this.passwordSet,
      limits: { lots: this.lots, maxLots: this.maxLots, maxOpen: this.maxOpen, maxDailyLoss: this.maxDailyLoss },
      account: this.account, positions: this.positions,
      dayPnl: this.account && this.dayStart ? this.account.equity - this.dayStart.equity : null,
      orders: this.orders.slice(-30).reverse(), events: this.events.slice(-20).reverse(),
    };
  }

  save() {
    return { armed: this.armed, killed: this.killed, seq: this.seq, orders: this.orders.slice(-200), dayStart: this.dayStart, events: this.events };
  }

  restore(s) {
    if (!s) return;
    // A restart never re-arms real trading by itself; you arm it again on the dashboard.
    Object.assign(this, { killed: s.killed, seq: s.seq, orders: s.orders || [], dayStart: s.dayStart, events: s.events || [] });
    if (s.armed) this.note('Restarted: live trading was armed before the restart and is now disarmed until you arm it again');
  }
}

const fmt = (x) => (Number.isFinite(x) && x ? Number(x.toPrecision(10)) : 0);
