import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DexDesk, safety } from '../server/engine/dex.js';

const H = 3600_000;
const pair = (over = {}) => ({
  chainId: 'robinhood', dexId: 'uniswap', url: 'https://dexscreener.com/robinhood/0xpair', pairAddress: '0xpair',
  baseToken: { address: '0xcat', name: 'Cash Cat', symbol: 'CASHCAT' }, quoteToken: { symbol: 'WETH' },
  priceUsd: '0.01', liquidity: { usd: 400_000 }, volume: { h24: 900_000 }, fdv: 10_000_000,
  txns: { h24: { buys: 900, sells: 700 }, h1: { buys: 60, sells: 40 } }, priceChange: { h1: 4, h24: 20 },
  pairCreatedAt: Date.now() - 30 * 24 * H, ...over,
});

// A fake DexScreener API answering the endpoints the desk uses.
function fakeApi(pairs) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const path = new URL(url).pathname;
    const body = path.startsWith('/latest/dex/search') ? { pairs }
      : path.startsWith('/token-') ? pairs.map((p) => ({ chainId: p.chainId, tokenAddress: p.baseToken.address }))
        : path.startsWith('/tokens/v1/') ? pairs.filter((p) => path.split('/')[4].split(',').includes(p.baseToken.address))
          : null;
    return { ok: !!body, status: body ? 200 : 404, json: async () => body };
  };
  return { fetchImpl, calls };
}

test('safety filter drops the obvious traps', () => {
  assert.deepEqual(safety(pair()).why, []);
  assert.match(safety(pair({ liquidity: { usd: 3000 } })).why[0], /liquidity/);
  assert.match(safety(pair({ pairCreatedAt: Date.now() - 20 * 60_000 })).why.join(), /min old/);
  assert.match(safety(pair({ txns: { h24: { buys: 500, sells: 0 } } })).why.join(), /may not be sellable/);
  assert.match(safety(pair({ fdv: 900_000_000 })).why.join(), /valuation/);
  assert.match(safety(pair({ priceChange: { h1: 140 } })).why.join(), /140% in 1h/);
});

test('discovery keeps only the chosen chain and the most liquid pair per coin', async () => {
  const other = pair({ chainId: 'solana', pairAddress: '0xsol', baseToken: { address: 'sol1', symbol: 'SOLCAT', name: 'x' } });
  const thin = pair({ pairAddress: '0xthin', liquidity: { usd: 50_000 } });
  const { fetchImpl } = fakeApi([pair(), other, thin]);
  const logs = [];
  const desk = new DexDesk({ fetchImpl, emit: (k, t) => logs.push(t) });
  await desk.discover();
  const v = desk.view();
  assert.deepEqual(v.pairs.map((p) => p.pair), ['0xpair']);
  assert.equal(v.pairs[0].safe, true);
  assert.match(logs.at(-1), /1 coins tracked .* 1 pass the safety filter/);
});

test('minute prices become 5-minute candles; a breakout paper-buys and the stop sells', async () => {
  const realNow = Date.now;
  let now = Math.floor(realNow() / (5 * 60_000)) * 5 * 60_000;
  Date.now = () => now;
  try {
    const p = pair();
    const { fetchImpl } = fakeApi([p]);
    const logs = [];
    const desk = new DexDesk({ fetchImpl, emit: (k, t) => logs.push(t) });
    await desk.discover();
    // two hours of flat prices (24 bars of 5 minutes, one read a minute)
    for (let i = 0; i < 24 * 5; i++) { now += 60_000; p.priceUsd = String(0.01 * (1 + 0.002 * Math.sin(i))); await desk.refresh(); }
    assert.ok(desk.pairs.get('0xpair').bars.length >= 24);
    assert.equal(desk.positions.size, 0, 'no trade without a breakout');
    // a breakout bar closes above the last hour's high, with more buyers than sellers
    for (let i = 0; i < 6; i++) { now += 60_000; p.priceUsd = '0.0110'; await desk.refresh(); }
    assert.equal(desk.positions.size, 1, 'paper bought the breakout');
    assert.match(logs.join('\n'), /Paper BUY CASHCAT/);
    // price falls through the 8% stop
    now += 60_000; p.priceUsd = '0.0095'; await desk.refresh();
    assert.equal(desk.positions.size, 0);
    const t = desk.view().trades[0];
    assert.equal(t.why, 'stop');
    assert.ok(t.pnl < 0 && t.ret < -0.08, 'loss includes the 1% cost');
  } finally {
    Date.now = realNow;
  }
});

test('unsafe coins are never traded, and state survives a restart', async () => {
  const p = pair({ liquidity: { usd: 1000 } });
  const { fetchImpl } = fakeApi([p]);
  const desk = new DexDesk({ fetchImpl });
  await desk.discover();
  desk.pairs.get('0xpair').bars = Array.from({ length: 30 }, (_, i) => ({ t: i, o: 1, h: 1, l: 1, c: i === 28 ? 2 : 1 }));
  desk.paperStep();
  assert.equal(desk.positions.size, 0);
  const d2 = new DexDesk({ fetchImpl });
  d2.restore(JSON.parse(JSON.stringify(desk.save())));
  assert.equal(d2.pairs.size, 1);
  assert.equal(d2.view().pairs[0].safe, false);
});

test('a DexScreener outage is shown, not thrown', async () => {
  const desk = new DexDesk({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  await desk.discover();
  assert.match(desk.view().error, /503/);
});

test('one breakout bar gives at most one paper buy', () => {
  const desk = new DexDesk({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  const bars = Array.from({ length: 30 }, (_, i) => ({ t: i * 300_000, o: 1, h: 1, l: 1, c: 1 }));
  bars[28] = { ...bars[28], h: 1.2, c: 1.2 }; // the breakout bar (closed)
  bars[29] = { ...bars[29], h: 1.2, l: 1.1, c: 1.2 }; // the bar forming now
  desk.pairs.set('0xp', { info: pair(), safety: { ok: true, why: [] }, bars });
  desk.paperStep();
  assert.equal(desk.positions.size, 1);
  desk.closePaper('0xp', desk.pairs.get('0xp'), desk.positions.get('0xp'), 1.2, 'test');
  desk.paperStep();
  assert.equal(desk.positions.size, 0, 'no second buy on the same breakout');
});
