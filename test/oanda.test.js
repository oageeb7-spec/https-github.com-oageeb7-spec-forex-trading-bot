import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Feed, INSTRUMENTS } from '../server/engine/market.js';
import { loadOandaFeeds, OANDA_NAMES } from '../server/engine/oanda.js';
import { Brain } from '../server/engine/brain.js';

// A minimal stand-in for OANDA's v20 candles endpoint, enforcing the same parameter rules.
const TOKEN = 'test-token';
const series = Object.fromEntries(Object.keys(OANDA_NAMES).map((s) => [OANDA_NAMES[s], new Feed(s).generate(9000)]));
let requests = 0;
const fmt = (x) => x.toFixed(5);
const server = http.createServer((req, res) => {
  requests++;
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/v3\/instruments\/(\w+)\/candles$/);
  const fail = (code, msg) => { res.writeHead(code); res.end(JSON.stringify({ errorMessage: msg })); };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return fail(401, 'Insufficient authorization');
  if (req.headers['accept-datetime-format'] !== 'UNIX') return fail(400, 'expected UNIX times');
  if (!m || !series[m[1]]) return fail(404, 'Invalid instrument');
  if (m[1] === 'XAU_USD') return fail(400, 'Instrument not tradeable in this region');
  const q = url.searchParams;
  if (q.get('granularity') !== 'H1' || q.get('price') !== 'MBA') return fail(400, 'bad params');
  if (q.has('from') && q.has('count') && q.has('to')) return fail(400, 'count, from and to together');
  if (Number(q.get('count')) > 5000) return fail(400, 'count > 5000');
  let bars = series[m[1]];
  if (q.has('to')) bars = bars.filter((b) => b.t < Number(q.get('to')) * 1000);
  if (q.has('from')) bars = bars.filter((b) => b.t >= Number(q.get('from')) * 1000).slice(0, 5000);
  else bars = bars.slice(-Number(q.get('count') || 500));
  const last = series[m[1]][series[m[1]].length - 1];
  const px = (v, d) => ({ o: fmt(v.o + d), h: fmt(v.h + d), l: fmt(v.l + d), c: fmt(v.c + d) });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    instrument: m[1], granularity: 'H1',
    candles: bars.map((b) => ({ time: (b.t / 1000).toFixed(9), complete: b !== last, volume: 100, mid: px(b, 0), bid: px(b, -0.00005), ask: px(b, 0.00005) })),
  }));
});
await new Promise((r) => server.listen(0, r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

test('loads paged hourly history, real spreads, and skips untradeable instruments', async () => {
  const warnings = [];
  const { feeds } = await loadOandaFeeds({ token: TOKEN, baseUrl, bars: 8000, log: (m) => warnings.push(m) });
  assert.deepEqual(Object.keys(feeds), ['EURUSD', 'GBPUSD', 'AUDUSD', 'USDJPY', 'USDCAD']);
  assert.match(warnings[0], /XAUUSD/);
  const eur = feeds.EURUSD;
  assert.equal(eur.bars.length, 8000);
  // Only completed candles, strictly increasing, ending just before the still-forming candle.
  assert.ok(eur.bars.every((b, i) => !i || b.t > eur.bars[i - 1].t));
  assert.equal(eur.bars[7999].t, series.EUR_USD[8998].t);
  assert.ok(Math.abs(INSTRUMENTS.EURUSD.spread - 0.0001) < 1e-9);
});

test('poll appends newly closed candles', async () => {
  const { feeds } = await loadOandaFeeds({ token: TOKEN, baseUrl, bars: 1000, symbols: ['EURUSD', 'GBPUSD'] });
  const f = feeds.EURUSD;
  const prev = f.bars[f.bars.length - 1].t;
  const s = series.EUR_USD, t = s[s.length - 1].t;
  // The forming candle closes, one more closes, and a new one starts forming.
  s.push({ ...s[s.length - 1], t: t + 3600_000 }, { ...s[s.length - 1], t: t + 7200_000 });
  await f.poll();
  assert.equal(f.error, null);
  assert.ok(f.bars[f.bars.length - 1].t > prev);
  assert.equal(f.bars[f.bars.length - 1].t, t + 3600_000);
  assert.equal(f.bars[f.bars.length - 2].t, t);
});

test('bad token fails loudly instead of falling back to fake data', async () => {
  await assert.rejects(loadOandaFeeds({ token: 'nope', baseUrl, bars: 600, log: () => {} }), /fewer than 2 instruments/);
});

test('brain runs its pipeline on OANDA feeds', async () => {
  const { feeds } = await loadOandaFeeds({ token: TOKEN, baseUrl, bars: 3000, symbols: ['EURUSD', 'USDJPY'] });
  const brain = new Brain({ feeds, data: { source: 'oanda', env: 'practice' } });
  for (let i = 0; i < 60; i++) brain.tick(Date.now() + i * 1000);
  const s = brain.snapshot();
  assert.equal(s.data.source, 'oanda');
  assert.deepEqual(s.data.symbols.map((x) => x.symbol), ['EURUSD', 'USDJPY']);
  assert.ok(s.counts.tested > 0);
  assert.ok([...brain.strategies.values()].every((x) => ['EURUSD', 'USDJPY'].includes(x.symbol)));
});
