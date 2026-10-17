import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Feed } from '../server/engine/market.js';

// Stand-in for Yahoo's v8 chart endpoint: hourly candles ending with one still forming.
const H = 3600_000;
const end = Math.floor(Date.now() / H) * H; // start of the current (forming) hour
const make = (seed, n) => new Feed('EURUSD', seed).generate(n).map((b, i) => ({ ...b, t: end - (n - 1 - i) * H }));
const series = { 'EURUSD=X': make(1, 9000), 'JPY=X': make(2, 9000), 'GC=F': make(3, 9000) };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const ticker = decodeURIComponent(u.pathname.split('/').pop());
  const bars = series[ticker];
  if (!bars) { res.writeHead(404); return res.end(JSON.stringify({ chart: { result: null, error: { description: 'No data found' } } })); }
  const n = u.searchParams.get('range') === '5d' ? 120 : bars.length;
  const slice = bars.slice(-n);
  const col = (k) => slice.map((b, i) => (i === 5 ? null : b[k])); // one gap to skip
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: slice.at(-1).c }, timestamp: slice.map((b) => b.t / 1000), indicators: { quote: [{ open: col('o'), high: col('h'), low: col('l'), close: col('c') }] } }], error: null } }));
});
await new Promise((r) => server.listen(0, r));
process.env.YAHOO_URL = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const { loadYahooFeeds, fetchBars } = await import('../server/engine/yahoo.js');
const { Brain } = await import('../server/engine/brain.js');

test('fetchBars drops gaps and the forming candle', async () => {
  const { bars, price } = await fetchBars('EURUSD', '730d');
  assert.equal(bars.length, 9000 - 2);
  assert.ok(bars.every((b, i) => !i || b.t > bars[i - 1].t));
  assert.ok(bars.at(-1).t + H <= Date.now());
  assert.equal(price, series['EURUSD=X'].at(-1).c);
});

test('loads available instruments, skips missing ones, keeps the last N bars', async () => {
  const warnings = [];
  const { feeds } = await loadYahooFeeds({ bars: 8000, log: (m) => warnings.push(m) });
  assert.deepEqual(Object.keys(feeds), ['EURUSD', 'USDJPY', 'XAUUSD']);
  assert.equal(feeds.EURUSD.bars.length, 8000);
  assert.equal(warnings.length, 3);
});

test('poll appends only newer candles', async () => {
  const { feeds } = await loadYahooFeeds({ bars: 1000, symbols: ['EURUSD', 'USDJPY'] });
  const f = feeds.EURUSD;
  const latest = f.bars.at(-1).t;
  f.bars.splice(-3); // the feed fell three closed candles behind
  await f.poll();
  assert.equal(f.error, null);
  assert.equal(f.bars.at(-1).t, latest);
  assert.equal(f.bars.at(-4).t, latest - 3 * H);
  assert.ok(f.bars.every((b, i) => !i || b.t > f.bars[i - 1].t));
});

test('fails loudly when fewer than two instruments load', async () => {
  await assert.rejects(loadYahooFeeds({ symbols: ['GBPUSD', 'AUDUSD'], log: () => {} }), /fewer than 2 instruments/);
});

test('brain runs on OS AI data feeds', async () => {
  const { feeds } = await loadYahooFeeds({ bars: 3000, symbols: ['EURUSD', 'USDJPY'] });
  const brain = new Brain({ feeds, data: { source: 'osai', env: 'live' } });
  for (let i = 0; i < 40; i++) brain.tick(Date.now() + i * 1000);
  const s = brain.snapshot();
  assert.equal(s.data.source, 'osai');
  assert.ok(s.counts.tested > 0);
});
