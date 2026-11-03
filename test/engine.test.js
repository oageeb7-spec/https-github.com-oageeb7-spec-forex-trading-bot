import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backtest, metrics } from '../server/engine/backtest.js';
import { TEMPLATES } from '../server/engine/strategies.js';
import { Feed } from '../server/engine/market.js';
import { CONCEPTS, analyzeConcept } from '../server/engine/patterns.js';
import { Brain } from '../server/engine/brain.js';

const H = 3600_000;
const bar = (i, o, h, l, c) => ({ t: Date.UTC(2024, 0, 2) + i * H, o, h, l, c });

test('bracket trade exits at the target and books R and dollars', () => {
  const bars = [bar(0, 1, 1.001, 0.999, 1), bar(1, 1, 1.001, 0.999, 1), bar(2, 1, 1.0035, 0.9995, 1.003)];
  TEMPLATES.__fixed = { params: [], signals: () => [{ i: 0, dir: 1, stop: 0.998, target: 1.003, maxBars: 10 }] };
  const { trades } = backtest(bars, '__fixed', {}, 'EURUSD', { costMult: 0 });
  delete TEMPLATES.__fixed;
  assert.equal(trades.length, 1);
  assert.ok(Math.abs(trades[0].r - 1.5) < 1e-9);
  assert.ok(Math.abs(trades[0].pnl - 300) < 1e-6);
});

test('stop is assumed hit before target when both print on one bar', () => {
  const bars = [bar(0, 1, 1, 1, 1), bar(1, 1, 1.01, 0.99, 1)];
  TEMPLATES.__fixed = { params: [], signals: () => [{ i: 0, dir: 1, stop: 0.995, target: 1.005, maxBars: 10 }] };
  const { trades } = backtest(bars, '__fixed', {}, 'EURUSD', { costMult: 0 });
  delete TEMPLATES.__fixed;
  assert.equal(trades[0].r, -1);
});

test('metrics: win rate, drawdown and equity', () => {
  const t0 = Date.UTC(2024, 0, 1);
  const m = metrics([{ pnl: 100, r: 1, exitT: t0 + 86400_000 }, { pnl: -50, r: -1, exitT: t0 + 2 * 86400_000 }, { pnl: 80, r: 1, exitT: t0 + 3 * 86400_000 }], t0, t0 + 5 * 86400_000);
  assert.equal(m.trades, 3);
  assert.ok(Math.abs(m.winrate - 2 / 3) < 1e-9);
  assert.equal(m.maxDD, -50);
  assert.deepEqual(m.equity, [0, 100, 50, 130]);
});

test('feeds are deterministic per seed and skip weekends', () => {
  const a = new Feed('EURUSD').generate(500), b = new Feed('EURUSD').generate(500);
  assert.deepEqual(a, b);
  assert.ok(a.every((x) => ![0, 6].includes(new Date(x.t).getUTCDay())));
  assert.ok(a.every((x) => x.h >= Math.max(x.o, x.c) && x.l <= Math.min(x.o, x.c)));
});

test('every template produces signals with stops on the correct side', () => {
  const bars = new Feed('GBPUSD').generate(3000);
  for (const [name, t] of Object.entries(TEMPLATES)) {
    const p = Object.fromEntries(t.params.map((x) => [x.name, x.def]));
    const sigs = t.signals(bars, p);
    assert.ok(sigs.length > 0, `${name} has no signals`);
    for (const s of sigs) {
      const entry = s.entry ?? bars[s.i].c;
      assert.ok(s.dir > 0 ? s.stop < entry : s.stop > entry, `${name} stop on wrong side`);
    }
  }
});

test('every concept detector finds hits with an annotated example', () => {
  const bars = new Feed('EURUSD').generate(4000);
  for (const c of CONCEPTS) {
    const a = analyzeConcept(c, bars, 'EURUSD');
    assert.ok(a.found > 0, `${c.id} found nothing`);
    assert.ok(a.example.candles.length > 10);
  }
});

test('brain pipeline runs, proposes, and paper-trades approved strategies', () => {
  const brain = new Brain();
  for (let i = 0; i < 160; i++) brain.tick(Date.now() + i * 1000);
  const s = brain.snapshot();
  assert.ok(s.counts.sources > 0 && s.counts.recipes > 0 && s.counts.variants >= s.counts.tested * 10);
  assert.equal(s.counts.tested, s.counts.labFailed + s.counts.sieved);
  assert.equal(s.counts.sieved, s.counts.sieveFailed + s.counts.validated);
  const d = s.decisions.find((x) => x.kind === 'paper' && x.status === 'pending');
  assert.ok(d, 'expected at least one paper proposal');
  assert.ok(brain.decide(d.id, 'approve'));
  assert.equal(brain.decide(d.id, 'approve'), false);
  for (let i = 0; i < 30; i++) brain.tick();
  const p = brain.snapshot().paper.find((x) => x.id === d.strategyId);
  assert.ok(p && p.day >= 1);
  assert.ok(brain.strategyDetail(d.strategyId).equity.length > 1);
});

test('state saved by one brain restores into a fresh one', () => {
  const a = new Brain();
  for (let i = 0; i < 120; i++) a.tick(Date.now() + i * 1000);
  const d = a.decisions.find((x) => x.kind === 'paper' && x.status === 'pending');
  a.decide(d.id, 'approve');
  a.verdict('squeeze', false, 'too loose');
  const saved = JSON.parse(JSON.stringify(a.save()));

  const b = new Brain();
  assert.ok(b.restore(saved));
  const s = b.snapshot();
  assert.equal(s.counts.recipes, a.c.recipes);
  assert.ok(b.paper.has(d.strategyId));
  assert.equal(b.strategies.get(d.strategyId).status, 'paper');
  assert.equal(b.knowledge.find((k) => k.id === 'squeeze').verdict, 'wrong');
  assert.equal(b.decisions.find((x) => x.id === d.id).status, 'approved');
  // New ids continue after the restored ones instead of colliding.
  for (let i = 0; i < 30; i++) b.tick();
  assert.equal(new Set(b.decisions.map((x) => x.id)).size, b.decisions.length);
  assert.equal(b.restore({ version: 99 }), false);
});

test('bitcoin trades through weekends; forex does not', () => {
  const btc = new Feed('BTCUSD').generate(24 * 14);
  assert.ok(btc.some((b) => [0, 6].includes(new Date(b.t).getUTCDay())));
  // A Saturday win counts toward bitcoin's daily Sharpe but is ignored on FX's weekday calendar.
  const t0 = Date.UTC(2024, 0, 1); // a Monday
  const trades = [2, 5, 9].map((d) => ({ pnl: 100, r: 1, exitT: t0 + d * 86400_000 + 3600_000 })); // Wed, Sat, Wed
  const fx = metrics(trades, t0, t0 + 13 * 86400_000);
  const crypto = metrics(trades, t0, t0 + 13 * 86400_000, { weekends: true });
  assert.notEqual(fx.sharpe, crypto.sharpe);
  const sig = TEMPLATES.trend.signals(btc, { fast: 10, slow: 40, stopAtr: 2, rr: 2 });
  assert.ok(Array.isArray(sig));
});

test('hourly upkeep: newest candles reach the lab, stale proposals are withdrawn, old data is dropped', () => {
  const brain = new Brain({});
  for (let i = 0; i < 150; i++) brain.tick(Date.now() + i * 1000);
  const sym = brain.symbols[0];
  const before = brain.hist[sym]['1h'].at(-1).t;
  for (let i = 0; i < 6; i++) brain.feeds[sym].next(); // new closed candles arrive on the feed
  // a waiting proposal whose strategy no longer works on the latest prices
  const d = brain.decisions.find((x) => x.status === 'pending' && x.kind === 'paper');
  assert.ok(d, 'expected a paper proposal');
  const s = brain.strategies.get(d.strategyId);
  s.checkedAt = 0;
  s.template = 'trend'; s.params = { fast: 30, slow: 30, stopAtr: 2, rr: 2 }; // equal averages never cross: no trades now
  // plenty of old failed recipes and decided decisions
  for (let i = 0; i < 400; i++) brain.strategies.set(`old${i}`, { id: `old${i}`, status: 'failed-lab', created: i, symbol: sym });
  for (let i = 0; i < 300; i++) brain.decisions.unshift({ id: `od${i}`, status: 'rejected', kind: 'paper', title: 'old' });
  brain.upkeep();
  assert.ok(brain.hist[sym]['1h'].at(-1).t > before, 'lab history includes the new candles');
  assert.equal(s.status, 'expired');
  assert.equal(d.status, 'expired', 'the proposal is withdrawn, not left for you to approve');
  assert.ok([...brain.strategies.values()].filter((x) => x.status === 'failed-lab').length <= 200);
  assert.ok(brain.decisions.filter((x) => x.status !== 'pending').length <= 100);
});

test('meme-coin mode researches and trades only meme coins', async () => {
  const { MEME_COINS } = await import('../server/engine/market.js');
  const brain = new Brain({ markets: MEME_COINS });
  for (let i = 0; i < 150; i++) brain.tick(Date.now() + i * 1000);
  assert.deepEqual(brain.symbols, MEME_COINS);
  assert.ok(brain.topics.some((t) => t.meme) && !brain.topics.some((t) => t.fx), 'no forex-only research topics');
  assert.ok(brain.strategies.size > 0);
  assert.ok([...brain.strategies.values()].every((s) => MEME_COINS.includes(s.symbol)));
});
