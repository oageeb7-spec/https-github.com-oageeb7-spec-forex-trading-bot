import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExchangeTrader } from '../server/engine/exchange.js';

// A small stand-in for a ccxt exchange: one price per market, instant market fills.
function fakeExchange({ prices = { 'DOGE/USDT': 0.2, 'PEPE/USDT': 0.00001 }, withCost = true } = {}) {
  const ex = {
    name: 'FakeEx', prices, orders: [], balance: { USDT: 1000 },
    markets: Object.fromEntries(Object.keys(prices).map((m) => [m, { limits: { amount: { min: 1 }, cost: { min: 5 } } }])),
    has: { createMarketBuyOrderWithCost: withCost, fetchTickers: true },
    async loadMarkets() { return ex.markets; },
    async fetchTicker(m) { return { last: ex.prices[m] }; },
    async fetchTickers(ms) { return Object.fromEntries(ms.map((m) => [m, { last: ex.prices[m] }])); },
    amountToPrecision: (m, a) => String(Math.floor(a)),
    async createMarketBuyOrderWithCost(m, cost) {
      const filled = Math.floor(cost / ex.prices[m]);
      ex.balance[m.split('/')[0]] = (ex.balance[m.split('/')[0]] || 0) + filled;
      ex.orders.push({ m, side: 'buy', cost });
      return { id: `b${ex.orders.length}`, average: ex.prices[m], filled };
    },
    async createOrder(m, type, side, amount) {
      ex.orders.push({ m, side, amount });
      if (side === 'sell') ex.balance[m.split('/')[0]] -= amount;
      return { id: `o${ex.orders.length}`, average: ex.prices[m], filled: amount };
    },
    async fetchBalance() { return { free: { ...ex.balance }, total: { ...ex.balance } }; },
  };
  return ex;
}

const strat = (id, symbol = 'DOGEUSD') => ({ id, name: `Momentum ${id}`, symbol });
// A long signal from the price feed: entry 0.2, stop 5% below, target 10% above.
const long = { dir: 1, entry: 0.2, stop: 0.19, target: 0.22 };
const settle = (t) => t.chain;

function armed(opts = {}) {
  const ex = opts.client || fakeExchange();
  const t = new ExchangeTrader({ client: ex, name: 'FakeEx', passwordSet: true, tradeUsd: 20, maxDailyLoss: 50, ...opts });
  assert.equal(t.arm(true), null);
  return { t, ex };
}

test('arming needs exchange keys and a dashboard password', () => {
  assert.match(new ExchangeTrader({ passwordSet: true }).arm(true), /EXCHANGE_API_KEY/);
  assert.match(new ExchangeTrader({ client: fakeExchange() }).arm(true), /DASHBOARD_PASSWORD/);
  const standby = new ExchangeTrader({ client: fakeExchange(), passwordSet: true });
  standby.active = false;
  assert.match(standby.arm(true), /standby/);
});

test('nothing is bought unless armed', async () => {
  const ex = fakeExchange();
  const t = new ExchangeTrader({ client: ex, passwordSet: true });
  assert.match(t.open(strat('a'), long).blocked, /not armed/);
  await settle(t);
  assert.equal(ex.orders.length, 0);
});

test('a long signal buys TRADE_USD of the coin; stop and target follow the real fill price', async () => {
  const { t, ex } = armed();
  ex.prices['DOGE/USDT'] = 0.25; // the exchange price differs from the feed's 0.2
  const r = t.open(strat('a'), long);
  assert.match(r.text, /BUY 20 USDT of DOGE\/USDT/);
  await settle(t);
  assert.deepEqual(ex.orders[0], { m: 'DOGE/USDT', side: 'buy', cost: 20 });
  const p = t.positions.get('a');
  assert.equal(p.amount, 80);
  assert.equal(p.entry, 0.25);
  assert.ok(Math.abs(p.stop - 0.2375) < 1e-9 && Math.abs(p.target - 0.275) < 1e-9, 'stop -5%, target +10% from the fill');
});

test('spot accounts never sell short, and the buy cap and open-trade limit hold', async () => {
  const { t } = armed({ tradeUsd: 500, maxTradeUsd: 100, maxOpen: 1 });
  assert.match(t.open(strat('s'), { ...long, dir: -1 }).blocked, /cannot sell short/);
  assert.equal(t.tradeUsd, 100);
  assert.ok(t.open(strat('a'), long).order);
  assert.match(t.open(strat('b', 'PEPEUSD'), long).blocked, /limit 1/);
  assert.match(t.open(strat('a'), long).blocked, /already holding/);
  assert.match(t.open(strat('x', 'XAUEUR'), long).blocked, /does not trade/);
});

test('orders below the exchange minimum are rejected, not sent', async () => {
  const { t, ex } = armed({ tradeUsd: 2 });
  t.open(strat('a'), long);
  await settle(t);
  assert.equal(ex.orders.length, 0);
  assert.equal(t.orders[0].status, 'rejected');
  assert.match(t.orders[0].error, /minimum/);
});

test('the 30-second watch sells at the stop on the exchange price', async () => {
  const { t, ex } = armed();
  t.open(strat('a'), long);
  await settle(t);
  ex.prices['DOGE/USDT'] = 0.185; // below the stop (0.19)
  await t.watch();
  await settle(t);
  assert.equal(ex.orders.at(-1).side, 'sell');
  assert.equal(ex.orders.at(-1).amount, 100);
  assert.equal(t.positions.size, 0);
  assert.match(t.orders.at(-1).why, /stop/);
  assert.ok(t.orders.at(-1).pnl < 0, 'the loss is booked');
});

test('closing works even when disarmed; only coins OS AI bought are sold', async () => {
  const { t, ex } = armed();
  t.open(strat('a'), long);
  await settle(t);
  t.arm(false);
  ex.balance.DOGE += 500; // coins you own yourself
  assert.ok(t.close(strat('a')).order);
  await settle(t);
  assert.equal(ex.orders.at(-1).amount, 100);
  assert.equal(ex.balance.DOGE, 500, 'your own coins are untouched');
  assert.match(t.close(strat('z')).blocked, /no live position/);
});

test('the daily loss limit sells everything and disarms', async () => {
  const { t, ex } = armed({ tradeUsd: 100, maxDailyLoss: 30 });
  t.open(strat('a'), { ...long, stop: 0.01 }); // a wide stop, so the daily limit acts first
  await settle(t);
  ex.prices['DOGE/USDT'] = 0.12; // 500 coins bought at 0.2: -40 USDT open loss
  await t.watch();
  await settle(t);
  assert.equal(t.armed, false);
  assert.equal(t.killed, true);
  assert.equal(t.positions.size, 0);
  assert.match(t.open(strat('b'), long).blocked, /not armed/);
});

test('the kill switch sells every OS AI position', async () => {
  const { t, ex } = armed({ maxOpen: 5 });
  t.open(strat('a'), long);
  t.open(strat('b', 'PEPEUSD'), { dir: 1, entry: 0.00001, stop: 0.000009, target: 0.000012 });
  await settle(t);
  assert.equal(t.positions.size, 2);
  t.kill();
  await settle(t);
  assert.equal(t.positions.size, 0);
  assert.equal(ex.orders.filter((o) => o.side === 'sell').length, 2);
});

test('a restart never leaves real trading armed, but keeps watching held coins', async () => {
  const { t } = armed();
  t.open(strat('a'), long);
  await settle(t);
  const t2 = new ExchangeTrader({ client: fakeExchange(), passwordSet: true });
  t2.restore(JSON.parse(JSON.stringify(t.save())));
  assert.equal(t2.armed, false);
  assert.equal(t2.positions.size, 1);
  assert.match(t2.view().events[0].text, /disarmed until you arm it again/);
});

test('a live strategy buys on the exchange; paper strategies never do', async () => {
  const { Brain } = await import('../server/engine/brain.js');
  const { MEME_COINS } = await import('../server/engine/market.js');
  const ex = fakeExchange({ prices: Object.fromEntries(MEME_COINS.map((s) => [`${s.slice(0, -3)}/USDT`, 1])) });
  const t = new ExchangeTrader({ client: ex, name: 'FakeEx', passwordSet: true, maxOpen: 10 });
  const brain = new Brain({ bridge: t, markets: MEME_COINS });
  for (let i = 0; i < 150; i++) brain.tick(Date.now() + i * 1000);
  const papers = brain.decisions.filter((d) => d.kind === 'paper' && d.status === 'pending').slice(0, 2);
  assert.equal(papers.length, 2);
  for (const d of papers) brain.decide(d.id, 'approve');
  brain.strategies.get(papers[0].strategyId).status = 'live'; // as if its live proposal was approved
  t.arm(true);
  for (let i = 0; i < 3000 && !t.orders.length; i++) brain.tick();
  await settle(t);
  assert.ok(t.orders.length > 0, 'expected the live strategy to trade');
  assert.ok(t.orders.every((o) => o.strategyId === papers[0].strategyId && o.side === 'buy'));
  assert.match(brain.log.filter((l) => l.kind === 'ORDER').at(-1).text, /BUY .* sent to FakeEx/);
});

test('meme coins are tested long-only, as they trade on a spot exchange', async () => {
  const { backtest } = await import('../server/engine/backtest.js');
  const { Feed } = await import('../server/engine/market.js');
  const f = new Feed('DOGEUSD', 3);
  f.generate(3000);
  for (const tpl of ['trend', 'breakout', 'meanrev', 'momentum']) {
    const r = backtest(f.bars, tpl, { trend: { fast: 20, slow: 80, stopAtr: 2, rr: 2 }, breakout: { lookback: 40, stopAtr: 1.8, rr: 2 }, meanrev: { period: 20, k: 2, stopAtr: 1.5 }, momentum: { lookback: 120, hold: 48, stopAtr: 4 } }[tpl], 'DOGEUSD');
    assert.ok(r.trades.every((x) => x.dir > 0), `${tpl} took a short on a spot coin`);
  }
});
