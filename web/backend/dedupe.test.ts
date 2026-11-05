// Duplicate-signal fix and one-time repair, run in-process against the local SDK stand-in:
//   npx tsx --tsconfig .platform-shims/tsconfig.check.json backend/dedupe.test.ts
// Yahoo is answered from the saved real gold bars; `cut` moves the clock.
import { readFileSync } from 'node:fs';
import { db } from '@appdeploy/sdk';

const FIX = new URL('../../.claude/skills/trader-forex/tests/fixtures/XAUUSD_15m.json', import.meta.url);
let cut = 200;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (!url.includes('GC%3DF') && !url.includes('GC=F')) return new Response('{}', { status: 503 });
  const data = JSON.parse(readFileSync(FIX, 'utf8'));
  const r = data.chart.result[0];
  r.timestamp = r.timestamp.slice(0, -cut);
  for (const k of Object.keys(r.indicators.quote[0])) r.indicators.quote[0][k] = r.indicators.quote[0][k].slice(0, -cut);
  return new Response(JSON.stringify(data), { status: 200 });
}) as typeof fetch;

const { scanMarkets } = await import('./index');
let fails = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`, ok ? '' : JSON.stringify(detail));
  if (!ok) fails++;
};
const index = async () => ((await db.get<{ ids: string[] }>('meta', ['index']))[0]?.ids ?? []);
const signals = async () => {
  const ids = await index();
  return (await db.get<Record<string, any>>('signals', ids)).map((s, i) => ({ id: ids[i], ...s }));
};

// 1. the first scheduled run repairs nothing (empty db) and logs the gold setups
await scanMarkets();
const first = await signals();
check('scan logs setups', first.length > 0, first.length);
check('setup ids carry the levels, not the candle time', first.every((s) => s.id.includes(`_${s.side}_`)), first.map((s) => s.id));

// 2. a candle later the same setups are not logged again (the old bug)
cut = 199;
await new Promise((r) => setTimeout(r, 31_000));   // let the 30-second price cache expire
await scanMarkets();
const second = await signals();
const keys = second.map((s) => `${s.pair}|${s.timeframe}|${s.side}|${s.entry}|${s.stop}`);
check('no setup is logged twice', new Set(keys).size === keys.length, keys);

// 3. plant duplicates the way the old ids made them, with a wrong, inflated record
await db.tx.update('meta', [{ id: 'migration_dedupe_v2', record: { done: false } }]);
const base = second[0];
const dupes = ['_1793600000_2', '_1793600900_2', '_1793601800_2'].map((sfx) => `${base.pair}_${base.timeframe}${sfx}`);
const { id: _skip, ...rec } = base;
void _skip;
for (const id of dupes) await db.tx.add('signals', [{ ...rec, id, outcome: 'stopped', realizedR: -1 }]);
await db.tx.update('signals', [{ id: base.id, record: { ...rec, outcome: 'stopped', realizedR: -1 } }]);
await db.tx.update('meta', [{ id: 'index', record: { ids: [base.id, ...dupes, ...second.slice(1).map((s) => s.id)], v: 99 } }]);
await db.tx.update('meta', [{ id: 'stats', record: { closed: 6, targetHit: 0, stopped: 6, stoppedAfterTp1: 0, missed: 0, rSum: -6 } }]);

await scanMarkets();
const after = await signals();
const k2 = after.map((s) => `${s.pair}|${s.timeframe}|${s.side}|${s.entry}|${s.stop}`);
check('repair removes the planted duplicates', new Set(k2).size === k2.length && !after.some((s) => dupes.includes(s.id)), after.map((s) => s.id));
const [stats] = await db.get<Record<string, number>>('meta', ['stats']);
check('stats rebuilt: the trade counts once', stats?.closed === 1 && stats?.stopped === 1 && stats?.rSum === -1, stats);
const [flag] = await db.get<Record<string, unknown>>('meta', ['migration_dedupe_v2']);
check('repair is recorded and runs once', flag?.done === true && flag?.removed === 3, flag);
const [feed] = await db.get<{ items: Array<{ text: string }> }>('meta', ['feed']);
check('the feed explains the repair', Boolean(feed?.items.some((e) => e.text.startsWith('Maintenance: removed 3 duplicate'))), feed?.items.map((e) => e.text));

await scanMarkets();
const [stats2] = await db.get<Record<string, number>>('meta', ['stats']);
check('a later run does not repair again', stats2?.closed === 1, stats2);

console.log(fails ? `${fails} FAILED` : 'all dedupe checks passed');
process.exit(fails ? 1 : 0);
