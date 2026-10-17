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
