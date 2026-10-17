import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../server/engine/bridge.js';

const strat = (id, symbol = 'EURUSD') => ({ id, name: `Trend ${id}`, symbol });
const pos = (dir = 1) => ({ dir, stop: 1.08, target: 1.1 });
const armed = (opts = {}) => {
  const b = new Bridge({ token: 't', passwordSet: true, ...opts });
  assert.equal(b.arm(true), null);
  return b;
};

test('arming needs a token and a dashboard password', () => {
  assert.match(new Bridge({ passwordSet: true }).arm(true), /BRIDGE_TOKEN/);
  assert.match(new Bridge({ token: 't' }).arm(true), /DASHBOARD_PASSWORD/);
  assert.equal(new Bridge({ token: 't', passwordSet: true }).arm(true), null);
});

test('no order is sent unless armed', () => {
  const b = new Bridge({ token: 't', passwordSet: true });
  assert.match(b.open(strat('a'), pos()).blocked, /not armed/);
  assert.equal(b.pending(0), '');
});

test('open orders reach the EA once, capped at the configured lot size', () => {
  const b = armed({ lots: 5, maxLots: 0.2 });
  b.open(strat('a'), pos(-1));
  assert.equal(b.pending(0), '1|open|a|EURUSD|sell|0.2|1.08|1.1');
  assert.equal(b.pending(1), '');
  b.report('FILL|1|123456|1.0912\nACCOUNT|111|Broker-Demo|USD|1000|1000\nPOS|a|123456|EURUSD|sell|0.2|1.0912|-1.5');
  assert.equal(b.orders[0].status, 'filled');
  assert.equal(b.view().positions.length, 1);
  assert.ok(b.connected);
});

test('limits open trades', () => {
  const b = armed({ maxOpen: 2 });
  assert.ok(b.open(strat('a'), pos()).order);
  assert.ok(b.open(strat('b'), pos()).order);
  assert.match(b.open(strat('c'), pos()).blocked, /limit 2/);
});

test('closing works even when disarmed, but only for held positions', () => {
  const b = armed();
  b.open(strat('a'), pos());
  b.arm(false);
  assert.ok(b.close(strat('a')).order);
  assert.match(b.close(strat('z')).blocked, /no live position/);
  assert.match(b.pending(0), /2\|close\|a\|EURUSD/);
});

test('daily loss limit disarms and closes everything', () => {
  const b = armed({ maxDailyLoss: 50 });
  b.report('ACCOUNT|1|S|USD|1000|1000');
  b.report('ACCOUNT|1|S|USD|1000|949');
  assert.equal(b.armed, false);
  assert.equal(b.killed, true);
  assert.match(b.pending(0), /\|close_all$/);
  assert.match(b.open(strat('a'), pos()).blocked, /not armed/);
});

test('rejections are recorded and stale opens expire instead of firing late', () => {
  const b = armed();
  b.open(strat('a'), pos());
  b.report('REJECT|1|10016|Invalid stops');
  assert.equal(b.orders[0].status, 'rejected');
  b.open(strat('b'), pos());
  b.orders[1].t -= 5 * 60_000;
  assert.equal(b.pending(0), '');
  assert.equal(b.orders[1].status, 'expired');
});

test('a restart never leaves real trading armed', () => {
  const a = armed();
  a.open(strat('a'), pos());
  const b = new Bridge({ token: 't', passwordSet: true });
  b.restore(JSON.parse(JSON.stringify(a.save())));
  assert.equal(b.armed, false);
  assert.equal(b.seq, 1);
  assert.match(b.view().events[0].text, /disarmed until you arm it again/);
});

test('a live strategy\'s trades reach the bridge; paper strategies never do', async () => {
  const { Brain } = await import('../server/engine/brain.js');
  const bridge = new Bridge({ token: 't', passwordSet: true, maxOpen: 10 });
  const brain = new Brain({ bridge });
  for (let i = 0; i < 150; i++) brain.tick(Date.now() + i * 1000);
  const papers = brain.decisions.filter((d) => d.kind === 'paper' && d.status === 'pending').slice(0, 2);
  assert.equal(papers.length, 2);
  for (const d of papers) brain.decide(d.id, 'approve');
  brain.strategies.get(papers[0].strategyId).status = 'live'; // as if its live proposal was approved
  bridge.arm(true);
  for (let i = 0; i < 2000 && !bridge.orders.length; i++) brain.tick();
  assert.ok(bridge.orders.length > 0, 'expected the live strategy to trade');
  assert.ok(bridge.orders.every((o) => o.strategyId === papers[0].strategyId));
  assert.match(brain.log.filter((l) => l.kind === 'ORDER').at(-1).text, /sent to MetaTrader/);
});
