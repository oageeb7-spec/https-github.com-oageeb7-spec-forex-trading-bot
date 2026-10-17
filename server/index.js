import './env.js';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Brain } from './engine/brain.js';
import { loadOandaFeeds } from './engine/oanda.js';
import { createResearch } from './research/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const THREE_DIR = path.join(ROOT, '..', 'node_modules', 'three');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TICK_MS = Number(process.env.TICK_MS) || 1500;

const OANDA_KEY = process.env.OANDA_API_KEY;
// Real data is the default. Simulation runs only when asked for explicitly.
const SOURCE = process.env.DATA_SOURCE || 'oanda';
const RESEARCH = process.env.RESEARCH || 'live';
const SIMULATED = SOURCE === 'synthetic' && RESEARCH === 'simulated';
// Warm-up and demo auto-approval only make sense for the fully simulated mode.
const WARMUP = Number(process.env.WARMUP ?? (SIMULATED ? 150 : 0));
const DEMO = (process.env.DEMO ?? (SIMULATED ? '1' : '0')) !== '0';

if (SOURCE === 'oanda' && !OANDA_KEY) {
  console.error('Real market data needs an OANDA API token. Copy .env.example to .env and set OANDA_API_KEY,\n'
    + 'or run: OANDA_API_KEY=your-token npm start\n'
    + 'Get one free from an OANDA practice account (My Account → Manage API Access).\n'
    + 'To run on generated prices instead: DATA_SOURCE=synthetic npm start');
  process.exit(1);
}
if (!['live', 'simulated'].includes(RESEARCH)) {
  console.error(`RESEARCH must be "live" or "simulated", got "${RESEARCH}"`);
  process.exit(1);
}
const POLL_MS = Number(process.env.OANDA_POLL_MS) || 30000;

let feeds = null, data = { source: 'synthetic' };
if (SOURCE === 'oanda') {
  const env = process.env.OANDA_ENV || 'practice';
  console.log(`Loading hourly history from OANDA (${env})…`);
  try {
    ({ feeds } = await loadOandaFeeds({ token: OANDA_KEY, env, baseUrl: process.env.OANDA_URL }));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  data = { source: 'oanda', env };
  console.log(`OANDA: loaded ${Object.entries(feeds).map(([s, f]) => `${s} (${f.bars.length} bars)`).join(', ')}`);
  // Completed hourly candles are appended as they close; paper trading acts on them.
  setInterval(() => Object.values(feeds).forEach((f) => f.poll()), POLL_MS);
} else if (SOURCE !== 'synthetic') {
  console.error(`DATA_SOURCE must be "oanda" or "synthetic", got "${SOURCE}"`);
  process.exit(1);
}

const research = RESEARCH === 'live' ? createResearch() : null;
if (research) console.log(`Research: live sources (${research.kinds.join(', ')}) · analyst: ${research.analyst.label}`);
const brain = new Brain({ budget: Number(process.env.BUDGET) || 50, feeds, data, research });

// Warm up so the dashboard opens with history: ticks are spread over the last WARMUP×12s.
const t0 = Date.now() - WARMUP * 12000;
for (let i = 0; i < WARMUP; i++) {
  brain.tick(t0 + i * 12000);
  // Demo mode: approve the first two paper proposals so paper trading has something to show.
  if (DEMO) for (const d of brain.decisions.filter((d) => d.kind === 'paper' && d.status === 'pending').slice(0, 2 - brain.c.paper)) brain.decide(d.id, 'approve');
}

const clients = new Set();
let latest = JSON.stringify(brain.snapshot());
function publish() {
  latest = JSON.stringify(brain.snapshot());
  for (const res of clients) res.write(`data: ${latest}\n\n`);
}
setInterval(() => {
  brain.tick();
  publish();
}, TICK_MS);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

// When hosted publicly: a password protects the dashboard, and only these sites may embed it
// (your Shopify store), so nobody else can frame or open your trading data.
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS || "'self' https://ostradingai.com https://*.ostradingai.com https://*.myshopify.com https://admin.shopify.com";

function authorized(req) {
  if (!PASSWORD) return true;
  const [scheme, value] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !value) return false;
  const pass = Buffer.from(value, 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(pass), b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let m;

  res.setHeader('Content-Security-Policy', `frame-ancestors ${FRAME_ANCESTORS}`);
  if (p === '/healthz') return json(res, 200, { ok: true });
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="OS AI", charset="UTF-8"' });
    return res.end('Password required');
  }

  if (p === '/api/state') return json(res, 200, JSON.parse(latest));
  if (p === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${latest}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if ((m = p.match(/^\/api\/strategy\/(\w+)$/))) {
    const d = brain.strategyDetail(m[1]);
    return d ? json(res, 200, d) : json(res, 404, { error: 'not found' });
  }
  if ((m = p.match(/^\/api\/knowledge\/(\w+)$/))) {
    const d = brain.knowledgeDetail(m[1]);
    return d ? json(res, 200, d) : json(res, 404, { error: 'not found' });
  }
  if (req.method === 'POST' && (m = p.match(/^\/api\/decisions\/(\w+)$/))) {
    const { action } = await readBody(req);
    if (!['approve', 'reject'].includes(action)) return json(res, 400, { error: 'action must be approve or reject' });
    const ok = brain.decide(m[1], action);
    if (ok) publish();
    return json(res, ok ? 200 : 409, { ok });
  }
  if (req.method === 'POST' && (m = p.match(/^\/api\/knowledge\/(\w+)\/verdict$/))) {
    const { ok, note } = await readBody(req);
    const done = brain.verdict(m[1], !!ok, String(note || '').slice(0, 500));
    if (done) publish();
    return json(res, done ? 200 : 404, { ok: done });
  }
  if (req.method === 'POST' && p === '/api/budget') {
    const { limit } = await readBody(req);
    if (!(limit > 0)) return json(res, 400, { error: 'limit must be > 0' });
    brain.budget.limit = Number(limit);
    brain.settings.paused = brain.budget.spent >= brain.budget.limit;
    publish();
    return json(res, 200, { ok: true });
  }

  // three.js is served from node_modules so the agent room works without a CDN.
  const base = p.startsWith('/vendor/three/') ? THREE_DIR : ROOT;
  const file = path.normalize(path.join(base, p.startsWith('/vendor/three/') ? p.slice('/vendor/three'.length) : p === '/' ? 'index.html' : p));
  if (!file.startsWith(base)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA fallback for client-side routes.
      return fs.readFile(path.join(ROOT, 'index.html'), (e2, html) => {
        res.writeHead(e2 ? 404 : 200, { 'content-type': TYPES['.html'] });
        res.end(e2 ? 'not found' : html);
      });
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, HOST, () => console.log(`OS AI // TRADING running on http://localhost:${PORT}`));
