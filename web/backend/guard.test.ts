// Guardrail tests for the agent desk, run against the local SDK stand-in:
//   npx tsx --tsconfig .platform-shims/tsconfig.check.json backend/guard.test.ts
// The stub ai.run really calls every tool an agent declares; env switches force
// specific answers so each guardrail can be checked.
import { readFileSync } from 'node:fs';
const FIX = new URL('../../.claude/skills/trader-forex/tests/fixtures/EURUSD_15m.json', import.meta.url);
import { runDesk } from './agents';
import { analyze } from './analyze';
import { parseChart } from './market';

const bars = parseChart(JSON.parse(readFileSync(FIX, 'utf8')));
// the agents' tools fetch other timeframes; serve the fixture for any Yahoo URL
globalThis.fetch = (async () => new Response(readFileSync(FIX))) as typeof fetch;
const trade = analyze('EURUSD', bars, 3, 1.5, '15m');
const noTrade = analyze('EURUSD', bars, 3, 2, '15m');
let fails = 0;
const check = (name: string, ok: boolean, detail: unknown) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`, ok ? '' : JSON.stringify(detail)); if (!ok) fails++; };
const env = process.env;

env.STUB_ENUM = 'first'; delete env.STUB_RISK;
let r = await runDesk('a', trade, bars);
check('trade + all agents agree -> TAKE', r.final === 'take' && r.confidence === 70 && r.guardrails.length === 0, r);
check('agents really called their tools', r.analyst.tools.map((t) => t.name).join() === 'get_setup,get_price_action'
  && r.risk.tools.map((t) => t.name).join() === 'size_position,get_volatility,get_session', [r.analyst.tools, r.risk.tools]);
check('engine levels pass through unchanged', r.engine.entry === trade.entry && r.engine.stop === trade.stop && r.engine.tp2 === trade.tp2, r.engine);

env.STUB_RISK = 'veto';
r = await runDesk('b', trade, bars);
check('risk VETO overrides head TAKE -> SKIP', r.head.verdict === 'take' && r.final === 'skip' && r.confidence === 0
  && r.guardrails.some((g) => g.includes('vetoed')), r);
delete env.STUB_RISK;

r = await runDesk('c', noTrade, bars);
check('engine No Trade -> SKIP, risk and head not run', r.final === 'skip' && r.risk.status === 'skipped' && r.head.status === 'skipped'
  && r.analyst.status === 'done' && r.guardrails[0].includes('cannot create one'), r);

env.STUB_ENUM = 'last';
r = await runDesk('d', trade, bars);
check('head SKIP stands as SKIP', r.head.verdict === 'skip' && r.final === 'skip', r);
env.STUB_ENUM = 'first';

env.STUB_NO_EMIT = '1';
r = await runDesk('f', trade, bars);
check('agent that runs out of steps is rescued with its tool results', r.analyst.status === 'done' && r.risk.status === 'done'
  && r.analyst.tools.length === 2 && r.final === 'take', r);
delete env.STUB_NO_EMIT;

env.STUB_AI_DOWN = '1';
try { await runDesk('e', trade, bars); check('AI outage surfaces as an error (route turns 429 into a message)', false, 'no throw'); }
catch (e) { check('AI outage surfaces as an error (route turns 429 into a message)', (e as { statusCode?: number }).statusCode === 429, e); }
delete env.STUB_AI_DOWN;
console.log(fails ? `${fails} FAILED` : 'all guardrail checks passed');
process.exit(fails ? 1 : 0);
