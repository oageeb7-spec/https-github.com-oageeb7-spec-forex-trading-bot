// Answers spoken or typed questions about the running system ("what's gold at?", "which strategy is
// best?"). Questions about live numbers are answered straight from the state; anything else goes to
// Claude when an Anthropic credential is set, with a compact summary of the state as context.
// Answers are short and plain so they read well aloud. The assistant never trades or approves.
import Anthropic from '@anthropic-ai/sdk';
import { INSTRUMENTS } from './market.js';

const MODEL = process.env.ASSISTANT_MODEL || process.env.ANALYST_MODEL || 'claude-opus-5-5';
const PRICES = { 'claude-opus-5-5': [4e-6, 20e-6], 'claude-sonnet-5-5': [2e-6, 10e-6], 'claude-haiku-5-5': [0.1e-6, 0.5e-6] };

const NAMES = {
  EURUSD: /\b(eur ?usd|euro( dollar)?|fiber)\b/, GBPUSD: /\b(gbp ?usd|pound|sterling|cable)\b/, AUDUSD: /\b(aud ?usd|aussie|australian)\b/,
  USDJPY: /\b(usd ?jpy|yen)\b/, USDCAD: /\b(usd ?cad|loonie|canadian)\b/, XAUUSD: /\b(xau ?usd|gold)\b/, BTCUSD: /\b(btc ?usd|bitcoin|btc)\b/,
};

const money = (x) => `${x < 0 ? 'minus ' : ''}${Math.abs(Math.round(x)).toLocaleString('en')} dollars`;
const price = (sym, s) => {
  const d = s.data.symbols.find((x) => x.symbol === sym);
  return d ? `${INSTRUMENTS[sym].name} is at ${d.price.toFixed(d.digits)}` : null;
};

// Direct answers from the live state. Returns null when the question needs Claude.
export function answerLocal(q, s) {
  const t = q.toLowerCase();
  const syms = Object.keys(NAMES).filter((k) => NAMES[k].test(t) && s.data.symbols.some((x) => x.symbol === k));
  if (syms.length && /\b(price|at|trading|quote|worth|cost|how much|level|where|doing)\b|\bhow('s| is)\b/.test(t)) return `${syms.map((k) => price(k, s)).join('. ')}.`;
  if (/\b(prices|markets?|quotes)\b/.test(t) && !syms.length) return `${s.data.symbols.map((x) => price(x.symbol, s)).join('. ')}.`;
  if (/\b(best|top|strongest|winning)\b.*\bstrateg|\bstrateg.*\b(best|top|strongest|winning)\b/.test(t)) {
    const top = s.ranked[0];
    if (!top) return 'No strategy has been tested yet.';
    return `The best is ${top.name}, now ${top.status === 'validated' ? 'validated' : `on ${top.status}`}, with a Sharpe of ${(top.sharpe ?? 0).toFixed(2)}${top.oosSharpe != null ? ` and ${top.oosSharpe.toFixed(2)} out of sample` : ''}.`;
  }
  if (/\b(paper|positions?|open trades?|how are .*trades)\b/.test(t)) {
    if (!s.paper.length) return 'Nothing is paper trading yet. Approve a paper proposal under Decisions.';
    const open = s.paper.filter((p) => p.pos);
    const live = s.bridge?.positions?.length ? ` On MetaTrader there are ${s.bridge.positions.length} open OS AI positions.` : '';
    return `${s.paper.length} strategies are trading on paper, ${open.length} with an open position. `
      + `Together they are ${money(s.paper.reduce((a, p) => a + p.net, 0))}.${live}`;
  }
  if (/\b(account|balance|equity|metatrader|mt4|mt5|broker|live trading)\b/.test(t)) {
    const b = s.bridge;
    if (!b?.configured) return 'MetaTrader is not set up. Add a BRIDGE_TOKEN on the server and install the OS AI expert advisor.';
    if (!b.account) return `MetaTrader is set up but the expert advisor has not reported yet. Live trading is ${b.armed ? 'armed' : 'disarmed'}.`;
    return `Account ${b.account.login} on ${b.account.server}: balance ${b.account.balance} and equity ${b.account.equity} ${b.account.currency}. `
      + `Live trading is ${b.armed ? 'armed' : 'disarmed'}${b.killed ? ' and the kill switch is on' : ''}.`;
  }
  if (/\b(budget|spent|spend|cost)\b/.test(t)) return `${s.budget.spent.toFixed(2)} of ${s.budget.limit} dollars of thinking budget used, about ${s.budget.perHour.toFixed(2)} an hour.`;
  if (/\b(agents?|team|who is working|what are you doing|busy)\b/.test(t)) {
    const busy = s.agents.filter((a) => a.status === 'working');
    return busy.length ? `${busy.map((a) => `${a.name} is ${a.task || 'working'}`).slice(0, 4).join('. ')}.` : 'All agents are idle right now.';
  }
  return null;
}

// What Claude sees: the numbers someone would ask about, small enough to keep each question cheap.
export function context(s) {
  return JSON.stringify({
    round: s.round, paused: s.paused, counts: s.counts, budget: { spent: s.budget.spent, limit: s.budget.limit },
    prices: Object.fromEntries(s.data.symbols.map((x) => [x.symbol, x.price])),
    topStrategies: s.ranked.slice(0, 8).map(({ name, template, symbol, tf, status, sharpe, oosSharpe }) => ({ name, template, symbol, tf, status, sharpe, oosSharpe })),
    paper: s.paper.map(({ name, symbol, status, net, trades, winrate, pos }) => ({ name, symbol, status, net, trades, winrate, open: pos ? (pos.dir > 0 ? 'long' : 'short') : null })),
    waitingDecisions: s.decisions.filter((d) => d.status === 'pending').map((d) => ({ kind: d.kind, title: d.title })),
    sieveFailReasons: s.sieveFailReasons,
    agents: s.agents.map((a) => ({ name: a.name, status: a.status, task: a.task })),
    recentLog: s.log.slice(-15).map((l) => `${l.kind}: ${l.text}`),
    metatrader: s.bridge && { configured: s.bridge.configured, armed: s.bridge.armed, killed: s.bridge.killed, account: s.bridge.account, positions: s.bridge.positions?.length ?? 0, dayPnl: s.bridge.dayPnl },
  });
}

const SYSTEM = `You are the voice of OS AI, an agentic forex and crypto research and paper-trading system.
Answer the user's question using the JSON state you are given. Your answer is read aloud: reply in one to
three short, plain sentences, with no markdown, lists or symbols, and numbers written as they are spoken.
If the state does not contain the answer, say so briefly. You cannot place trades, arm live trading or
approve decisions: tell the user to do those on screen. Do not give personal financial advice or promise returns.`;

export class Assistant {
  constructor({ client } = {}) {
    this.enabled = Boolean(client || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    this.client = client || (this.enabled ? new Anthropic() : null);
  }

  // Returns { answer, by, cost }.
  async ask(question, state) {
    const q = String(question || '').slice(0, 500).trim();
    if (!q) return { answer: 'I did not hear a question.', by: 'local', cost: 0 };
    const local = answerLocal(q, state);
    if (local) return { answer: local, by: 'local', cost: 0 };
    if (!this.enabled) {
      return { answer: 'I can answer questions about prices, the best strategy, paper trades, the MetaTrader account, the budget and the agents. Add an Anthropic key on the server to ask me anything else.', by: 'local', cost: 0 };
    }
    if (state.budget.spent >= state.budget.limit) return { answer: 'The thinking budget is used up, so I can only answer simple questions about prices, strategies and trades.', by: 'local', cost: 0 };
    const res = await this.client.beta.messages.create({
      model: MODEL,
      max_tokens: 1024,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: `<state>\n${context(state)}\n</state>\n\nQuestion: ${q}` }],
    });
    const [pin, pout] = PRICES[res.model] || PRICES['claude-opus-5-5'];
    const cost = res.usage.input_tokens * pin + res.usage.output_tokens * pout;
    if (res.stop_reason === 'refusal') return { answer: 'I can\'t help with that one.', by: 'claude', cost };
    const answer = res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').replace(/[*#_`]/g, '').trim();
    return { answer: answer || 'I don\'t have an answer for that.', by: 'claude', cost };
  }
}
