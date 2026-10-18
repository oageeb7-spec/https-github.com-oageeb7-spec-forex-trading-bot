import './env.js';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Brain } from './engine/brain.js';
import { loadYahooFeeds } from './engine/yahoo.js';
import { createResearch } from './research/index.js';
import ccxt from 'ccxt';
import { ExchangeTrader } from './engine/exchange.js';
import { Assistant } from './engine/assistant.js';
import { INSTRUMENTS, MEME_COINS } from './engine/market.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const THREE_DIR = path.join(ROOT, '..', 'node_modules', 'three');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TICK_MS = Number(process.env.TICK_MS) || 1500;

// Real data is the default: OS AI data (no key needed). Simulation runs only when asked for explicitly.
const SOURCE = process.env.DATA_SOURCE || 'osai';
const RESEARCH = process.env.RESEARCH || 'live';
const SIMULATED = SOURCE === 'synthetic' && RESEARCH === 'simulated';
// Warm-up and demo auto-approval only make sense for the fully simulated mode.
const WARMUP = Number(process.env.WARMUP ?? (SIMULATED ? 150 : 0));
const DEMO = (process.env.DEMO ?? (SIMULATED ? '1' : '0')) !== '0';

if (!['live', 'simulated'].includes(RESEARCH)) {
  console.error(`RESEARCH must be "live" or "simulated", got "${RESEARCH}"`);
  process.exit(1);
}
const POLL_MS = Number(process.env.POLL_MS) || 30000;
// Markets OS AI researches, tests and trades: meme coins by default. MARKETS=all adds forex, gold
// and bitcoin back; or list symbols, e.g. MARKETS=DOGEUSD,SHIBUSD,BTCUSD.
const MARKETS = !process.env.MARKETS ? MEME_COINS
  : process.env.MARKETS === 'all' ? Object.keys(INSTRUMENTS)
    : process.env.MARKETS.split(',').map((x) => x.trim().toUpperCase()).filter((x) => INSTRUMENTS[x]);
if (MARKETS.length < 2) {
  console.error(`MARKETS needs at least 2 known symbols (the sieve tests a second market). Known: ${Object.keys(INSTRUMENTS).join(', ')}`);
  process.exit(1);
}

let feeds = null, data = { source: 'synthetic' };
if (SOURCE === 'osai') {
  console.log('Loading hourly history from OS AI data…');
  try {
    ({ feeds } = await loadYahooFeeds({ symbols: MARKETS }));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  data = { source: 'osai', env: 'live' };
  console.log(`OS AI data: loaded ${Object.entries(feeds).map(([s, f]) => `${s} (${f.bars.length} bars)`).join(', ')}`);
  // Completed hourly candles are appended as they close; paper trading acts on them.
  setInterval(() => Object.values(feeds).forEach((f) => f.poll()), POLL_MS);
} else if (SOURCE !== 'synthetic') {
  console.error(`DATA_SOURCE must be "osai" or "synthetic", got "${SOURCE}"`);
  process.exit(1);
}

const research = RESEARCH === 'live' ? createResearch() : null;
if (research) console.log(`Research: live sources (${research.kinds.join(', ')}) · analyst: ${research.analyst.label}`);
// Crypto exchange for live strategies (real orders). Inactive without exchange keys; never armed at
// start. Keys belong in the host's environment variables, never in code or chat.
const EXCHANGE = (process.env.EXCHANGE || '').toLowerCase();
let client = null;
if (EXCHANGE && !ccxt.exchanges.includes(EXCHANGE)) console.error(`EXCHANGE "${EXCHANGE}" is not supported; use one of: binance, kraken, coinbase, bybit, okx, …`);
else if (EXCHANGE && process.env.EXCHANGE_API_KEY && process.env.EXCHANGE_SECRET) {
  client = new ccxt[EXCHANGE]({
    apiKey: process.env.EXCHANGE_API_KEY, secret: process.env.EXCHANGE_SECRET,
    password: process.env.EXCHANGE_PASSPHRASE || undefined, enableRateLimit: true, options: { defaultType: 'spot' },
  });
  if (process.env.EXCHANGE_SANDBOX === '1') client.setSandboxMode(true);
}
const bridge = new ExchangeTrader({
  client, name: client ? `${client.name}${process.env.EXCHANGE_SANDBOX === '1' ? ' (test network)' : ''}` : '',
  quote: process.env.EXCHANGE_QUOTE || 'USDT',
  tradeUsd: Number(process.env.TRADE_USD) || 20,
  maxTradeUsd: Number(process.env.MAX_TRADE_USD) || 100,
  maxOpen: Number(process.env.MAX_OPEN_TRADES) || 3,
  maxDailyLoss: Number(process.env.MAX_DAILY_LOSS) || 50,
  passwordSet: Boolean(process.env.DASHBOARD_PASSWORD),
});
console.log(client ? `Live trading: ${bridge.name}, spot, ${bridge.quote} · disarmed until you arm it` : 'Live trading: no exchange connected (paper only)');
const brain = new Brain({ budget: Number(process.env.BUDGET) || 50, feeds, data, research, bridge, markets: MARKETS });
const assistant = new Assistant();
console.log(`Voice assistant: ${assistant.enabled ? 'Claude answers open questions' : 'built-in answers (no Anthropic key)'}`);

// State survives restarts (hosts restart idle apps). Kept outside the app folder so redeploys keep
// it too. The fully simulated demo does not persist unless STATE_FILE is set.
const STATE_FILE = process.env.STATE_FILE || (SIMULATED ? '' : path.join(os.homedir(), '.os-ai', 'state.json'));
let restored = false;

// Some hosts run several copies of the app. Only the copy holding this lock runs the agents, saves
// state and trades on the exchange. The others stay on standby and forward every API call to it over a
// local socket, so all visitors see one brain and real orders can never be duplicated.
const LOCK_FILE = STATE_FILE ? `${STATE_FILE}.lock` : '';
// Socket paths are limited to about 100 characters; a long state path gets a short one in the temp folder.
const SOCKET = !STATE_FILE || process.platform === 'win32' ? ''
  : `${STATE_FILE}.sock`.length <= 100 ? `${STATE_FILE}.sock`
    : path.join(os.tmpdir(), `osai-${crypto.createHash('sha1').update(STATE_FILE).digest('hex').slice(0, 12)}.sock`);
let primary = !LOCK_FILE;
function tryLock() {
  if (primary) return true;
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    try {
      const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 0); return false; } catch { fs.unlinkSync(LOCK_FILE); } // holder is gone
      }
    } catch { /* no lock yet */ }
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    primary = true;
  } catch { primary = false; }
  return primary;
}
tryLock();
if (!primary) {
  bridge.active = false;
  console.log('Standby copy: another copy holds the lock and trades on the exchange');
  const retry = setInterval(() => {
    if (!tryLock()) return;
    clearInterval(retry);
    bridge.active = true;
    try { brain.restore(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch { /* nothing saved yet */ }
    becomePrimary();
    console.log('This copy took over as primary');
  }, 10000);
  retry.unref();
}
if (STATE_FILE && fs.existsSync(STATE_FILE)) {
  try {
    restored = brain.restore(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
    if (restored) console.log(`State restored from ${STATE_FILE}`);
  } catch (e) {
    console.error(`Could not restore ${STATE_FILE}: ${e.message}`);
  }
}
function saveState() {
  if (!STATE_FILE || !primary) return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(brain.save()));
    fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
  } catch (e) {
    console.error(`Could not save state: ${e.message}`);
  }
}
setInterval(saveState, 30000).unref();
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => {
  saveState();
  if (primary && LOCK_FILE) try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
  process.exit(0);
});

// Warm up so the dashboard opens with history: ticks are spread over the last WARMUP×12s.
const t0 = Date.now() - WARMUP * 12000;
for (let i = 0; i < (restored ? 0 : WARMUP); i++) {
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
  if (!primary) return; // standby copies forward to the primary instead of running a second brain
  brain.tick();
  publish();
}, TICK_MS);
// Live positions: exchange prices, balance, stops and targets checked every 30 seconds.
setInterval(() => { if (primary && bridge.configured) bridge.watch().then(saveState); }, Number(process.env.WATCH_MS) || 30000);

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

// Standby copy: hand an API call to the primary over its local socket, streams included.
function forward(req, res) {
  const up = http.request({ socketPath: SOCKET, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) json(res, 503, { error: 'OS AI is starting up; try again in a few seconds.' }); else res.end(); });
  res.on('close', () => up.destroy()); // the visitor left (e.g. closed a live stream)
  req.pipe(up);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let m;

  res.setHeader('Content-Security-Policy', `frame-ancestors ${FRAME_ANCESTORS}`);
  if (p === '/healthz') return json(res, 200, { ok: true, primary });
  if (!primary && SOCKET && p.startsWith('/api/')) return forward(req, res);

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
    if (ok) publish(), saveState(); // your decisions are saved at once
    return json(res, ok ? 200 : 409, { ok });
  }
  if (req.method === 'POST' && (m = p.match(/^\/api\/knowledge\/(\w+)\/verdict$/))) {
    const { ok, note } = await readBody(req);
    const done = brain.verdict(m[1], !!ok, String(note || '').slice(0, 500));
    if (done) publish(), saveState();
    return json(res, done ? 200 : 404, { ok: done });
  }
  if (req.method === 'POST' && p === '/api/live/arm') {
    if (!primary) return json(res, 503, { error: 'This copy is on standby; try again.' });
    const { armed } = await readBody(req);
    const err = bridge.arm(Boolean(armed));
    if (err) return json(res, 409, { error: err });
    brain.emit('LIVE', armed ? `You armed live trading on ${bridge.name}` : 'You disarmed live trading', 'director');
    publish(), saveState();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/live/kill') {
    if (!primary) return json(res, 503, { error: 'This copy is on standby; try again.' });
    bridge.kill();
    brain.emit('LIVE', 'KILL SWITCH: live trading stopped, selling all OS AI positions', 'director');
    publish(), saveState();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/ask') {
    const { q } = await readBody(req);
    try {
      const r = await assistant.ask(q, brain.snapshot());
      if (r.cost) brain.spendUsd('director', r.cost);
      if (r.by === 'claude') brain.emit('VOICE', `Asked: "${String(q).slice(0, 80)}"`, 'director');
      return json(res, 200, { answer: r.answer, by: r.by });
    } catch (e) {
      console.error(`[voice] ${e.message}`);
      return json(res, 200, { answer: 'I could not reach Claude just now. Try again in a moment.', by: 'error' });
    }
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
        res.writeHead(e2 ? 404 : 200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' });
        res.end(e2 ? 'not found' : html);
      });
    }
    // Revalidate on every load so a redeploy reaches browsers at once.
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

http.createServer(handle).listen(PORT, HOST, () => console.log(`OS AI // TRADING running on http://localhost:${PORT}`));

// The primary also listens on a local socket that standby copies forward to.
function becomePrimary() {
  if (!SOCKET) return;
  try { fs.unlinkSync(SOCKET); } catch { /* none left over */ }
  // A plain net server handing its connections to an http server: hosts such as Hostinger's
  // LiteSpeed runner allow only one http listen() per app and silently ignore a second.
  const inner = http.createServer(handle);
  net.createServer((c) => inner.emit('connection', c)).listen(SOCKET, () => console.log('Primary: serving the other copies'))
    .on('error', (e) => console.error(`Could not open ${SOCKET}: ${e.message}`));
}
if (primary) becomePrimary();
