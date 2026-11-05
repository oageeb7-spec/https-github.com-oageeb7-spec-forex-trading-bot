// LOCAL ONLY: serves dist/ and runs backend/index.ts. Yahoo is blocked in this sandbox,
// so fetch() of a Yahoo chart URL is answered from the saved real fixtures.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const FIX = join(import.meta.dirname, '..', '..', '.claude', 'skills', 'trader-forex', 'tests', 'fixtures');
const realFetch = globalThis.fetch;
let cut = Number(process.env.CUT || 0);
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  if (url.includes('finance.yahoo.com')) {
    const sym = decodeURIComponent(url.split('/chart/')[1].split('?')[0]);
    const file = sym === 'EURUSD=X' ? 'EURUSD_15m.json' : sym === 'GC=F' ? 'XAUUSD_15m.json' : sym === 'BTC-USD' ? 'BTCUSD_15m.json' : null;
    if (!file || process.env.FEED_DOWN) return new Response('{}', { status: 503 });
    const data = JSON.parse(readFileSync(join(FIX, file), 'utf8'));
    if (cut > 0) {   // pretend it is earlier: drop the newest `cut` bars
      const r = data.chart.result[0];
      r.timestamp = r.timestamp.slice(0, -cut);
      for (const k of Object.keys(r.indicators.quote[0])) r.indicators.quote[0][k] = r.indicators.quote[0][k].slice(0, -cut);
    }
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(input, init);
}) as typeof fetch;

const backend = await import('../backend/index.ts');
const { handler } = backend;
const DIST = join(import.meta.dirname, '..', 'dist');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  if (u.pathname === '/local/cut') {   // move the simulated clock
    cut = Number(u.searchParams.get('n') || 0);
    res.end(JSON.stringify({ cut }));
    return;
  }
  if (u.pathname === '/local/cron') {   // fire the scheduled scan by hand
    const out = await backend.scanMarkets();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }
  if (u.pathname.startsWith('/api/')) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const out = await handler({
      method: req.method || 'GET', path: u.pathname,
      query: Object.fromEntries(u.searchParams), body: raw ? JSON.parse(raw) : undefined,
    });
    res.writeHead(out.statusCode, out.headers);
    res.end(out.body);
    return;
  }
  const file = join(DIST, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(Number(process.env.PORT || 5180), () => console.log('local server on', process.env.PORT || 5180));
