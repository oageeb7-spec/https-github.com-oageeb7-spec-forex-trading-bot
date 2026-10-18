import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Local stand-ins for arXiv, GitHub, Hacker News and an article page.
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (body, type = 'application/json') => { res.writeHead(200, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (u.pathname === '/api/query') return send(`<feed><entry><id>http://arxiv.org/abs/2401.00001v1</id><published>2024-01-02T00:00:00Z</published>
    <title>Time-Series Momentum in Currency &amp; Futures</title><summary>We show a 12-month lookback
    momentum rule on G10 FX earns a Sharpe of 0.8.</summary></entry></feed>`, 'application/atom+xml');
  if (u.pathname === '/search/repositories') return send({ items: [{ full_name: 'quant/fx-breakout', html_url: 'https://github.com/quant/fx-breakout', description: 'Donchian breakout on EUR/USD', pushed_at: '2024-05-01T00:00:00Z', stargazers_count: 42 }] });
  if (u.pathname === '/repos/quant/fx-breakout/readme') return send('# FX breakout\nDonchian channel breakout with a 55-bar lookback on EURUSD and GBPUSD, ATR stop.', 'text/plain');
  if (u.pathname === '/api/v1/search') return send({ hits: [{ title: 'Mean reversion in FX ranges', url: `http://127.0.0.1:${server.address().port}/article`, created_at_i: 1700000000 }, { title: 'Ask HN: no url', url: null }] });
  if (u.pathname === '/article') return send('<html><head><style>x{}</style></head><body><nav>menu</nav><p>Fade Bollinger band extremes on EUR/USD.</p><script>evil()</script></body></html>', 'text/html');
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
Object.assign(process.env, { ARXIV_URL: base, GITHUB_API_URL: base, HN_API_URL: base });
after(() => server.close());

const { searchers, readSource, htmlToText } = await import('../server/research/sources.js');
const { ClaudeAnalyst, KeywordAnalyst, cleanParams } = await import('../server/research/analyst.js');
const { Brain } = await import('../server/engine/brain.js');

test('arXiv search parses Atom entries', async () => {
  const [p] = await searchers.arxiv('time series momentum');
  assert.equal(p.title, 'Time-Series Momentum in Currency & Futures');
  assert.equal(p.url, 'http://arxiv.org/abs/2401.00001v1');
  assert.match(p.text, /Sharpe of 0.8/);
});

test('GitHub search + README read', async () => {
  const [r] = await searchers.github('donchian breakout');
  assert.equal(r.repo, 'quant/fx-breakout');
  assert.match(await readSource(r), /55-bar lookback/);
});

test('Hacker News search skips link-less posts and article text is stripped of markup', async () => {
  const hits = await searchers.web('mean reversion');
  assert.equal(hits.length, 1);
  const text = await readSource(hits[0]);
  assert.match(text, /Fade Bollinger band extremes/);
  assert.doesNotMatch(text, /evil|menu|<p>/);
  assert.equal(htmlToText('<p>a &amp; b</p>'), 'a & b');
});

test('Claude analyst sends a structured-output request with fallbacks and prices usage', async () => {
  let sent;
  const client = { beta: { messages: { create: async (req) => {
    sent = req;
    return { model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 },
      content: [{ type: 'text', text: JSON.stringify({ testable: true, hype: false, template: 'breakout', timeframe: '4h', symbols: ['EURUSD', 'NZDUSD'],
        params: [{ name: 'lookback', value: 55 }, { name: 'stopAtr', value: 99 }, { name: 'bogus', value: 1 }], claims: [], terms: ['Donchian channel'], summary: 'A breakout.' }) }] };
  } } } };
  const a = await new ClaudeAnalyst({ client }).analyze({ kind: 'github', title: 't', url: 'u' }, 'doc', ['EURUSD', 'GBPUSD']);
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.fallbacks, 'default');
  assert.deepEqual(sent.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.deepEqual(sent.output_config.format.schema.properties.symbols.items.enum, ['EURUSD', 'GBPUSD']);
  assert.match(sent.messages[0].content, /<document>\ndoc\n<\/document>/);
  assert.equal(a.testable, true);
  assert.deepEqual(a.symbols, ['EURUSD']);
  assert.deepEqual(a.params, { lookback: 55, stopAtr: 4, rr: 2 });
  assert.ok(Math.abs(a.cost - (1000 * 4e-6 + 200 * 20e-6)) < 1e-12);
});

test('Claude analyst treats a refusal as not testable', async () => {
  const client = { beta: { messages: { create: async () => ({ model: 'claude-opus-5-5', stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 0 }, content: [] }) } } };
  const a = await new ClaudeAnalyst({ client }).analyze({ kind: 'web', title: 't', url: 'u' }, 'doc', ['EURUSD']);
  assert.equal(a.testable, false);
});

test('keyword analyst classifies and flags hype', async () => {
  const k = new KeywordAnalyst();
  const a = await k.analyze({}, 'Donchian breakout system: breakout above the channel on EUR/USD', ['EURUSD', 'GBPUSD']);
  assert.equal(a.template, 'breakout');
  assert.deepEqual(a.symbols, ['EURUSD']);
  const h = await k.analyze({}, 'Breakout breakout: never lose, 100% win rate!', ['EURUSD']);
  assert.equal(h.testable, false);
  assert.equal(h.reason, 'promises unrealistic returns');
  assert.deepEqual(cleanParams('trend', [{ name: 'fast', value: 60 }, { name: 'slow', value: 40 }]).slow, 70);
});

test('brain runs the live pipeline end to end with async research', async () => {
  process.env.RESEARCH_SCOUT_MS = '1';
  const research = {
    kinds: ['github'],
    analyst: new KeywordAnalyst(),
    search: async () => [
      { kind: 'github', url: 'https://github.com/a/b', title: 'a/b', text: 'Donchian breakout breakout on EURUSD' },
      { kind: 'github', url: 'https://github.com/c/d', title: 'c/d', text: 'guaranteed profit robot' },
    ],
    read: async (s) => s.text,
  };
  const brain = new Brain({ research });
  const wait = () => new Promise((r) => setImmediate(r));
  for (let i = 0; i < 12; i++) { brain.tick(Date.now() + i * 60000); await wait(); }
  const s = brain.snapshot();
  assert.equal(s.research.mode, 'live');
  assert.equal(s.counts.sources, 2, 'second search must not re-add seen URLs');
  assert.equal(s.sources.find((x) => x.title === 'c/d').status, 'rejected');
  const strat = [...brain.strategies.values()].filter((x) => x.sourceKind !== 'lab'); // lab exploration is tested below
  assert.ok(strat.length >= 1 && strat.every((x) => x.template === 'breakout' && x.symbol === 'EURUSD' && x.sourceUrl === 'https://github.com/a/b'));
  assert.equal(s.budget.spent, 0, 'keyword analysis and backtests cost nothing');
});

test('a failing source marks the agent stuck and logs the error', async () => {
  const research = { kinds: ['arxiv'], analyst: new KeywordAnalyst(), search: async () => { throw new Error('export.arxiv.org returned 503'); }, read: async () => '' };
  const brain = new Brain({ research });
  brain.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(brain.agents.scout.status, 'stuck');
  assert.match(brain.log.at(-1).text, /503/);
});

test('with research down, sources rest and the lab keeps exploring every market', async () => {
  process.env.RESEARCH_SCOUT_MS = '1';
  let calls = 0;
  const research = { kinds: ['arxiv'], analyst: new KeywordAnalyst(), search: async () => { calls++; throw new Error('down'); }, read: async () => '' };
  const brain = new Brain({ research });
  const wait = () => new Promise((r) => setImmediate(r));
  const t0 = Date.now();
  for (let i = 0; i < 25; i++) { brain.tick(t0 + i * 61_000); await wait(); } // 25 minutes, inside the 30-minute rest
  assert.equal(calls, 3, 'a source that failed 3 times rests instead of being hammered');
  assert.match(brain.log.map((l) => l.text).join('\n'), /resting it for 30 minutes/);
  const explored = [...brain.strategies.values()].filter((x) => x.sourceKind === 'lab');
  assert.ok(explored.length >= 10, `expected exploration, got ${explored.length}`);
  assert.ok(explored.some((x) => /^(DOGE|SHIB|PEPE|BONK|WIF|FLOKI)USD$/.test(x.symbol)), 'meme coins are explored too');
  assert.ok(brain.c.tested > 0, 'the lab actually tested them');
});
