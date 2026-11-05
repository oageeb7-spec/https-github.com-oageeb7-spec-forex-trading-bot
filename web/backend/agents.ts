// The agent desk: three AI agents that review a setup the analysis engine found.
//
//   Market Analyst  - investigates other timeframes and price action with tools
//   Risk Manager    - sizes the trade and checks stop vs volatility and the session; can veto
//   Head Trader     - reads both reports and decides TAKE or SKIP
//
// Agents never set prices: every level comes from the engine (analyze.ts). Their
// output is validated and guardrails are enforced in code - an engine No Trade or a
// risk veto always ends in SKIP, whatever an agent says.
import { ai } from '@appdeploy/sdk';
import { analyze, atr, Setup } from './analyze';
import { Bar, clock, fetchBars, isCrypto, pipSize, roundTo, size } from './market';

const SWING = 3;
const TFS = ['15m', '1h', '4h', '1d'];

export type ToolCall = { name: string; args: string };

export type AgentReport = {
  agent: 'analyst' | 'risk' | 'head';
  title: string;
  status: 'done' | 'skipped' | 'failed';
  verdict: string;
  confidence: number | null;
  points: string[];
  concerns: string[];
  tools: ToolCall[];
  ms: number;
};

export type DeskReview = {
  id: string;
  pair: string;
  timeframe: string;
  engine: Pick<Setup, 'decision' | 'side' | 'entry' | 'stop' | 'tp1' | 'tp2' | 'rr' | 'entryType' | 'price'>;
  analyst: AgentReport;
  risk: AgentReport;
  head: AgentReport;
  final: 'take' | 'skip';
  confidence: number;
  summary: string;
  guardrails: string[];
  createdAt: number;
};

// ---------- small validators: model output is untrusted ----------

const str = (x: unknown, max = 220): string => (typeof x === 'string' ? x.trim().slice(0, max) : '');
const list = (x: unknown, n = 5): string[] =>
  (Array.isArray(x) ? x : []).map((v) => str(v)).filter(Boolean).slice(0, n);
const pct = (x: unknown): number | null => {
  const v = Number(x);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;
};
const pick = <T extends string>(x: unknown, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(String(x)) ? (x as T) : fallback;

// ---------- tools backed by real data ----------

function engineSummary(s: Setup) {
  return {
    timeframe: s.timeframe, decision: s.decision, side: s.side, score: s.score,
    entry: s.entry ?? null, stop: s.stop ?? null, tp1: s.tp1 ?? null, tp2: s.tp2 ?? null,
    reward_risk: s.rr ?? null, reasons: s.reasons,
  };
}

function priceAction(pair: string, tf: string, bars: Bar[]) {
  const ps = pipSize(pair);
  const last = bars[bars.length - 1];
  const win = bars.slice(-20);
  const first = win[0];
  const hi = Math.max(...win.map((b) => b.high));
  const lo = Math.min(...win.map((b) => b.low));
  const ma = (k: number) => {
    const xs = bars.slice(bars.length - 20 - k, bars.length - k).map((b) => b.close);
    return xs.reduce((s, x) => s + x, 0) / xs.length;
  };
  const slope = bars.length >= 26 ? ma(0) - ma(5) : 0;
  return {
    timeframe: tf,
    last_close: last.close,
    change_last_20_bars_pct: roundTo(((last.close - first.open) / first.open) * 100, 3),
    atr_pips: roundTo(atr(bars) / ps, 1),
    pips_below_20_bar_high: roundTo((hi - last.close) / ps, 1),
    pips_above_20_bar_low: roundTo((last.close - lo) / ps, 1),
    ma20_slope: slope > 0 ? 'rising' : slope < 0 ? 'falling' : 'flat',
    close_vs_ma20: last.close > ma(0) ? 'above' : 'below',
  };
}

async function runAgent(opts: {
  system: string; prompt: string; tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown> | unknown>;
  result: Record<string, unknown>; maxSteps: number;
}): Promise<{ data: Record<string, unknown> | null; tools: ToolCall[] }> {
  const calls: ToolCall[] = [];
  const results: Array<{ tool: string; args: unknown; result: unknown }> = [];
  const emit = { name: 'emit_result', description: 'Return your final report.', parameters: opts.result };
  const res = await ai.run({
    system: opts.system,
    prompt: opts.prompt,
    tools: [...opts.tools, emit],
    onToolCall: async (name, args) => {
      calls.push({ name, args: JSON.stringify(args).slice(0, 80) });
      const h = opts.handlers[name];
      let out: unknown;
      if (!h) out = { error: `unknown tool ${name}` };
      else {
        try {
          out = await h(args);
        } catch (e) {
          out = { error: e instanceof Error ? e.message : 'tool failed' };
        }
      }
      if (name !== 'emit_result') results.push({ tool: name, args, result: out });
      return out;
    },
    maxSteps: opts.maxSteps,
    temperature: 0.2,
    thinkingMode: 'FAST',
  });
  let data = res.data && typeof res.data === 'object' ? (res.data as Record<string, unknown>) : null;
  if (!data && results.length) {
    // ran out of steps after doing the work: hand back what its tools returned and ask only for the report
    const rescue = await ai.run({
      system: opts.system,
      prompt: `${opts.prompt}\n\nYou already ran your tools. Their results:\n${JSON.stringify(results).slice(0, 12000)}\n\n`
        + 'Do not call any other tool. Call emit_result now with your report.',
      tools: [emit],
      maxSteps: 2,
      temperature: 0.2,
      thinkingMode: 'FAST',
    });
    data = rescue.data && typeof rescue.data === 'object' ? (rescue.data as Record<string, unknown>) : null;
  }
  return { data, tools: calls.filter((c) => c.name !== 'emit_result') };
}

const empty = (agent: AgentReport['agent'], title: string, status: AgentReport['status'], verdict: string, why: string): AgentReport =>
  ({ agent, title, status, verdict, confidence: null, points: [why], concerns: [], tools: [], ms: 0 });

// ---------- the three agents ----------

async function analyst(s: Setup, bars: Bar[]): Promise<AgentReport> {
  const t0 = Date.now();
  const barsFor = async (tf: string) => (tf === s.timeframe ? bars : fetchBars(s.pair, tf));
  const tfParam = { type: 'object', properties: { timeframe: { type: 'string', enum: TFS } }, required: ['timeframe'] };
  const { data, tools } = await runAgent({
    system: 'You are the Market Analyst on a forex trading desk. Investigate with your tools before concluding. '
      + 'Check at least one HIGHER timeframe than the setup and the price action on the setup timeframe. '
      + 'Never invent prices or numbers - only use what the tools return. Be concise and specific. '
      + 'Make at most 4 tool calls, then call emit_result.',
    prompt: `The rules engine read ${s.pair} on ${s.timeframe}:\n${JSON.stringify(engineSummary(s))}\n\n`
      + 'Does the wider market agree with this reading? Use the tools, then call emit_result.',
    tools: [
      { name: 'get_setup', description: 'Run the rules engine (structure, breaks, liquidity sweeps, premium/discount, fair-value gaps) on another timeframe of this pair.', parameters: tfParam },
      { name: 'get_price_action', description: 'Live price-action stats for a timeframe: 20-bar change, ATR in pips, distance to the 20-bar high/low, MA20 slope.', parameters: tfParam },
    ],
    handlers: {
      get_setup: async (a) => engineSummary(analyze(s.pair, await barsFor(String(a.timeframe)), SWING, 2, String(a.timeframe))),
      get_price_action: async (a) => priceAction(s.pair, String(a.timeframe), await barsFor(String(a.timeframe))),
    },
    result: {
      type: 'object',
      properties: {
        bias: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
        agrees_with_engine: { type: 'boolean' },
        confidence: { type: 'integer', minimum: 0, maximum: 100 },
        findings: { type: 'array', items: { type: 'string' }, maxItems: 5 },
        concerns: { type: 'array', items: { type: 'string' }, maxItems: 4 },
      },
      required: ['bias', 'agrees_with_engine', 'confidence', 'findings', 'concerns'],
    },
    maxSteps: 7,
  });
  if (!data) return { ...empty('analyst', 'Market Analyst', 'failed', 'no report', 'The analyst did not return a report.'), tools, ms: Date.now() - t0 };
  const bias = pick(data.bias, ['bullish', 'bearish', 'neutral'] as const, 'neutral');
  return {
    agent: 'analyst', title: 'Market Analyst', status: 'done',
    verdict: `${bias}${data.agrees_with_engine === true ? ' - agrees' : data.agrees_with_engine === false ? ' - disagrees' : ''}`,
    confidence: pct(data.confidence), points: list(data.findings), concerns: list(data.concerns, 4), tools, ms: Date.now() - t0,
  };
}

async function riskManager(s: Setup, bars: Bar[]): Promise<AgentReport> {
  const t0 = Date.now();
  const ps = pipSize(s.pair);
  const { data, tools } = await runAgent({
    system: 'You are the Risk Manager on a forex trading desk. Your job is to protect the account. '
      + 'Use your tools, then give pass, caution or veto. Veto a stop that is tighter than about half an ATR '
      + '(noise will hit it), reward:risk under 1.5, or a trade into the weekend close. Never invent numbers. '
      + 'Call each tool at most once, then call emit_result.',
    prompt: `Proposed ${s.side} ${s.pair} on ${s.timeframe}: entry ${s.entry}, stop ${s.stop}, TP1 ${s.tp1}, TP2 ${s.tp2 ?? 'none'}, `
      + `reward:risk ${s.rr}, ${s.entryType} entry. `
      + (isCrypto(s.pair) ? 'This is crypto: it trades 24/7, so there is no weekend close and FX sessions do not apply; 1 pip = $1, 1 lot = 1 coin. ' : '')
      + 'Check it with the tools, then call emit_result.',
    tools: [
      { name: 'size_position', description: 'Lots, loss at stop, gain at target and margin for a USD account.', parameters: {
        type: 'object', properties: { account_usd: { type: 'number', minimum: 100 }, risk_pct: { type: 'number', minimum: 0.1, maximum: 5 } },
        required: ['account_usd', 'risk_pct'] } },
      { name: 'get_volatility', description: 'ATR in pips on the setup timeframe and the stop distance as a multiple of ATR.', parameters: { type: 'object', properties: {} } },
      { name: 'get_session', description: 'Whether the FX market is open, which sessions are live, and New York time.', parameters: { type: 'object', properties: {} } },
    ],
    handlers: {
      size_position: (a) => size({
        pair: s.pair, entry: s.entry as number, stop: s.stop as number, target: (s.tp2 ?? s.tp1) as number,
        account: Number(a.account_usd), riskPct: Number(a.risk_pct), leverage: 30,
      }),
      get_volatility: () => {
        const a = atr(bars);
        const stopPips = Math.abs((s.entry as number) - (s.stop as number)) / ps;
        return { atr_pips: roundTo(a / ps, 1), stop_pips: roundTo(stopPips, 1), stop_in_atr: roundTo(stopPips / (a / ps), 2) };
      },
      get_session: () => ({ ...clock(), crypto_trades_24_7: isCrypto(s.pair) }),
    },
    result: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['pass', 'caution', 'veto'] },
        checks: { type: 'array', items: { type: 'string' }, maxItems: 5 },
        concerns: { type: 'array', items: { type: 'string' }, maxItems: 4 },
      },
      required: ['verdict', 'checks', 'concerns'],
    },
    maxSteps: 7,
  });
  if (!data) return { ...empty('risk', 'Risk Manager', 'failed', 'no report', 'The risk manager did not return a report.'), tools, ms: Date.now() - t0 };
  return {
    agent: 'risk', title: 'Risk Manager', status: 'done', verdict: pick(data.verdict, ['pass', 'caution', 'veto'] as const, 'caution'),
    confidence: null, points: list(data.checks), concerns: list(data.concerns, 4), tools, ms: Date.now() - t0,
  };
}

async function headTrader(s: Setup, an: AgentReport, rk: AgentReport): Promise<AgentReport> {
  const t0 = Date.now();
  const { data } = await runAgent({
    system: 'You are the Head Trader. You decide TAKE or SKIP for one setup, using only the engine reading '
      + 'and your two agents\' reports. Prices are fixed by the engine - do not propose new ones. Be decisive and brief.',
    prompt: `Engine: ${JSON.stringify(engineSummary(s))}\n\nMarket Analyst: ${JSON.stringify({ verdict: an.verdict, confidence: an.confidence, findings: an.points, concerns: an.concerns })}\n\n`
      + `Risk Manager: ${JSON.stringify({ verdict: rk.verdict, checks: rk.points, concerns: rk.concerns })}\n\nDecide, then call emit_result.`,
    tools: [],
    handlers: {},
    result: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['take', 'skip'] },
        confidence: { type: 'integer', minimum: 0, maximum: 100 },
        summary: { type: 'string', maxLength: 240 },
        plan: { type: 'array', items: { type: 'string' }, maxItems: 4 },
      },
      required: ['decision', 'confidence', 'summary', 'plan'],
    },
    maxSteps: 2,
  });
  if (!data) return { ...empty('head', 'Head Trader', 'failed', 'no decision', 'The head trader did not return a decision.'), ms: Date.now() - t0 };
  return {
    agent: 'head', title: 'Head Trader', status: 'done', verdict: pick(data.decision, ['take', 'skip'] as const, 'skip'),
    confidence: pct(data.confidence), points: [str(data.summary, 240), ...list(data.plan, 4)].filter(Boolean), concerns: [], tools: [], ms: Date.now() - t0,
  };
}

/** Run the desk on a setup. Guardrails are applied here, in code. */
export async function runDesk(id: string, s: Setup, bars: Bar[]): Promise<DeskReview> {
  const guardrails: string[] = [];
  const isTrade = s.decision === 'trade';
  // analyst and risk manager work independently, so they run side by side
  const [an, rk] = await Promise.all([
    analyst(s, bars),
    isTrade
      ? riskManager(s, bars)
      : Promise.resolve(empty('risk', 'Risk Manager', 'skipped', 'n/a', 'Nothing to size: the engine found no trade.')),
  ]);
  let hd: AgentReport;
  if (!isTrade) {
    hd = empty('head', 'Head Trader', 'skipped', 'skip', 'No trade from the engine, so there is nothing to approve.');
    guardrails.push('The engine found no trade - agents cannot create one.');
  } else {
    hd = await headTrader(s, an, rk);
  }
  let final: 'take' | 'skip' = hd.verdict === 'take' ? 'take' : 'skip';
  if (s.decision === 'trade' && rk.verdict === 'veto' && final === 'take') {
    final = 'skip';
    guardrails.push('Risk Manager vetoed - the desk cannot take it.');
  }
  if (an.status === 'failed' || rk.status === 'failed' || hd.status === 'failed') {
    if (final === 'take') guardrails.push('An agent failed to report - skipping to be safe.');
    final = 'skip';
  }
  // the head trader's confidence only stands when its decision stood
  const confidence = final === hd.verdict ? hd.confidence ?? 0 : 0;
  const summary = hd.status === 'done' ? hd.points[0] : (guardrails[0] || an.points[0] || 'No decision.');
  return {
    id, pair: s.pair, timeframe: s.timeframe,
    engine: { decision: s.decision, side: s.side, entry: s.entry, stop: s.stop, tp1: s.tp1, tp2: s.tp2, rr: s.rr, entryType: s.entryType, price: s.price },
    analyst: an, risk: rk, head: hd, final, confidence, summary, guardrails, createdAt: Date.now(),
  };
}
