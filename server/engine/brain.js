// The "trade brain": a team of agents that turns research sources into strategy recipes,
// backtests variants in the lab, puts survivors through the sieve, and paper-trades
// what you approve. Every number shown in the dashboard comes from here.
import os from 'node:os';
import { Feed, INSTRUMENTS, resample, rng } from './market.js';
import { TEMPLATES, defaults, mutate, scale } from './strategies.js';
import { backtest, downsample, round } from './backtest.js';
import { CONCEPTS, analyzeConcept } from './patterns.js';
import { HYPE as HYPE_RE } from '../research/analyst.js';

const HIST_BARS = 8000;
const SPLIT = 0.7;
const VARIANTS_PER_RECIPE = 10;
const BARS_PER_PAPER_DAY = 24;
const PAPER_DAYS = 21;
const SCOUT_MS = Number(process.env.RESEARCH_SCOUT_MS) || 45000;

const TOPICS = [
  { topic: 'Time-series momentum on FX majors', template: 'momentum', q: 'time series momentum fx' },
  { topic: 'Trend following with ATR stops', template: 'trend', q: 'trend following atr stop' },
  { topic: 'London breakout', template: 'breakout', q: 'london breakout strategy' },
  { topic: 'Donchian channel breakouts', template: 'breakout', q: 'donchian breakout backtest' },
  { topic: 'Range trading EUR/USD', template: 'meanrev', q: 'eurusd range trading' },
  { topic: 'Bollinger band mean reversion', template: 'meanrev', q: 'bollinger mean reversion fx' },
  { topic: 'Volatility squeeze before news', template: 'squeeze', q: 'volatility squeeze breakout' },
  { topic: 'Fair value gaps (ICT)', template: 'fvg', q: 'fair value gap backtest' },
  { topic: 'Order blocks and imbalance', template: 'fvg', q: 'order block imbalance strategy' },
  { topic: 'Moving average crossover systems', template: 'trend', q: 'ema crossover forex' },
];
const HYPE = ['This strategy wins every time', '100% win rate scalping secret', 'Turn $100 into $10,000 in a week', 'The only indicator you will ever need'];
const TERMS = ['Judas swing', 'Optimal trade entry', 'Silver bullet', 'Kill zone', 'Balanced price range', 'Breaker block', 'Mitigation block', 'Premium / discount', 'Power of three', 'Inducement'];
const KINDS = ['youtube', 'github', 'arxiv', 'web'];
// USD per action; tuned so a $50 budget lasts several hours of continuous running.
const COST = { search: 0.0002, read: 0.0005, watch: 0.0012, summarize: 0.0006, term: 0.0002, recipe: 0.0004, variant: 0.00004, sieve: 0.00015, director: 0.0007 };

export const AGENTS = [
  { id: 'director', name: 'Director', color: '#a78bfa', role: 'Plans the day, proposes decisions and skills' },
  { id: 'scout', name: 'Scout', color: '#34d399', role: 'Searches YouTube, GitHub, arXiv and the web' },
  { id: 'reader', name: 'Reader', color: '#fde68a', role: 'Reads articles, papers and repos' },
  { id: 'watcher', name: 'Watcher', color: '#f472b6', role: 'Watches videos, pulls subtitles' },
  { id: 'sum1', name: 'Summarizer 1', color: '#60a5fa', role: 'Summarizes sources into claims' },
  { id: 'sum2', name: 'Summarizer 2', color: '#60a5fa', role: 'Summarizes sources into claims' },
  { id: 'sum3', name: 'Summarizer 3', color: '#60a5fa', role: 'Summarizes sources into claims' },
  { id: 'terms', name: 'Terms checker', color: '#fb7185', role: 'Checks jargon against the knowledge base' },
  { id: 'recipes', name: 'Recipe maker', color: '#fbbf24', role: 'Turns summaries into testable recipes' },
  { id: 'lab', name: 'Lab', color: '#22d3ee', role: 'Backtests variants, runs the sieve' },
];

export class Brain {
  // `feeds` (symbol → feed with .bars) lets real market data replace the synthetic generator.
  // `research` (see server/research) switches the agents from simulated sources to real ones.
  constructor({ budget = 50, seed = 7, feeds = null, data = { source: 'synthetic' }, research = null } = {}) {
    this.r = rng(seed);
    this.started = Date.now();
    this.tickNo = 0;
    this.now = Date.now();
    this.ids = 0;
    this.settings = { earlyCostCheck: false, paused: false };
    this.data = data;
    this.research = research;
    this.cost = research ? Object.fromEntries(Object.keys(COST).map((k) => [k, 0])) : COST; // live mode bills real LLM usage only
    this.seenUrls = new Set();
    this.scoutN = 0;
    this.lastScout = 0;
    this.pendingTerms = [];

    if (!feeds) {
      feeds = {};
      for (const s of Object.keys(INSTRUMENTS)) {
        feeds[s] = new Feed(s);
        feeds[s].generate(HIST_BARS);
      }
    }
    this.feeds = feeds;
    this.symbols = Object.keys(feeds);
    this.hist = {};
    for (const s of this.symbols) {
      const h1 = feeds[s].bars.slice();
      this.hist[s] = { '1h': h1, '4h': resample(h1, 4) };
    }

    this.c = { sources: 0, read: 0, summarized: 0, sourceRejected: 0, recipes: 0, tested: 0, variants: 0, labFailed: 0, sieved: 0, sieveFailed: 0, validated: 0, paper: 0, live: 0 };
    this.sieveFailReasons = { oos: 0, robust: 0, transfer: 0, cost: 0, months: 0 };
    this.sources = [];
    this.queues = { toRead: [], toWatch: [], toSummarize: [], toRecipe: [], toLab: [] };
    this.strategies = new Map();
    this.variants = [];
    this.decisions = [];
    this.log = [];
    this.handoffs = [];
    this.budget = { limit: budget, spent: 0, byAgent: Object.fromEntries(AGENTS.map((a) => [a.id, 0])), history: [] };
    this.agents = Object.fromEntries(AGENTS.map((a) => [a.id, { ...a, status: 'idle', task: '', done: 0 }]));
    this.activity = [];
    this.buckets = { youtube: [], github: [], arxiv: [], web: [], thought: [], tested: [], validated: [] };
    this.terms = [];
    this.paper = new Map();
    this.reports = [];
    this.knowledge = CONCEPTS.map((k, n) => ({
      id: k.id, step: n < 3 ? 6 : n < 7 ? 5 : 3 + (n % 2), verdict: n < 3 ? 'ok' : null, note: '',
      stats: analyzeConcept(k, this.hist[this.symbols[0]]['1h'], this.symbols[0]),
    }));
  }

  // ---------- helpers ----------
  id(p) { return `${p}${++this.ids}`; }
  pick(a) { return a[Math.floor(this.r() * a.length)]; }
  chance(p) { return this.r() < p; }

  emit(kind, text, agent) {
    this.log.push({ t: this.now, kind, text, agent });
    if (this.log.length > 300) this.log.splice(0, 100);
    const minute = Math.floor(this.now / 60000);
    const last = this.activity[this.activity.length - 1];
    if (last && last.m === minute) last.n++;
    else this.activity.push({ m: minute, n: 1 });
    if (this.activity.length > 30) this.activity.shift();
  }

  bump(key, n = 1) {
    const slot = Math.floor(this.now / 300000); // 5-minute buckets
    const b = this.buckets[key];
    const last = b[b.length - 1];
    if (last && last.s === slot) last.n += n;
    else b.push({ s: slot, n });
    if (b.length > 24) b.shift();
  }

  spend(agent, what, mult = 1) {
    return this.spendUsd(agent, this.cost[what] * mult);
  }

  spendUsd(agent, usd) {
    this.budget.spent += usd;
    this.budget.byAgent[agent] += usd;
    return usd;
  }

  // Runs an async agent task (network or LLM). The agent shows as working until it settles.
  job(agent, task, fn, onDone) {
    const a = this.agents[agent];
    a.busy = true;
    a.status = 'working';
    a.task = task;
    fn()
      .then((res) => {
        this.now = Date.now();
        a.done++;
        a.status = 'idle';
        onDone(res);
      })
      .catch((e) => {
        this.now = Date.now();
        a.status = 'stuck';
        a.task = `Failed: ${task}`;
        this.emit('ERROR', `${a.name}: ${e.message}`, agent);
        onDone(null, e);
      })
      .finally(() => (a.busy = false));
  }

  work(agent, task, to) {
    const a = this.agents[agent];
    a.status = 'working';
    a.task = task;
    a.done++;
    if (to) this.handoffs.push({ from: agent, to, t: this.now });
  }

  // ---------- the loop ----------
  tick(now = Date.now()) {
    this.now = now;
    if (++this.tickNo === 1) this.started = now; // warm-up ticks are back-dated
    this.handoffs = [];
    for (const a of Object.values(this.agents)) if (a.status === 'working' && !a.busy) a.status = 'idle';

    if (this.budget.spent >= this.budget.limit) {
      if (!this.settings.paused) this.emit('BUDGET', `Thinking budget of $${this.budget.limit} reached — research paused`, 'director');
      this.settings.paused = true;
    }
    if (!this.settings.paused && this.research) {
      this.liveScout();
      this.liveRead('reader', this.queues.toRead);
      this.liveRead('watcher', this.queues.toWatch);
      this.liveSummarize();
      this.liveTerms();
      this.makeRecipes();
      this.runLab();
      this.direct();
    } else if (!this.settings.paused) {
      this.scout();
      this.read();
      this.watch();
      this.summarize();
      this.checkTerms();
      this.makeRecipes();
      this.runLab();
      this.direct();
    }
    this.paperStep();
    if (this.tickNo % 20 === 0) this.budget.history.push({ t: now, spent: round(this.budget.spent, 3) });
    if (this.budget.history.length > 200) this.budget.history.shift();
  }

  scout() {
    if (!this.chance(0.55)) return;
    const kind = this.pick(KINDS);
    const tp = this.pick(TOPICS);
    const hype = this.chance(0.08);
    const results = 3 + Math.floor(this.r() * 9);
    const fresh = 1 + Math.floor(this.r() * Math.min(3, results));
    const where = { youtube: 'YouTube', github: 'GitHub', arxiv: 'arXiv', web: 'the web' }[kind];
    this.spend('scout', 'search');
    this.work('scout', `Search ${where}: "${tp.q}"`, kind === 'youtube' ? 'watcher' : 'reader');
    this.emit('SEARCH', `Search ${where}: "${tp.q}" · ${results} results, ${fresh} new`, 'scout');
    for (let n = 0; n < fresh; n++) {
      const src = {
        id: this.id('s'), kind, topic: tp.topic, template: tp.template, t: this.now, status: 'queued', hype,
        title: hype ? this.pick(HYPE) : this.title(kind, tp.topic),
        size: kind === 'youtube' ? 8 + Math.floor(this.r() * 40) : 800 + Math.floor(this.r() * 6000),
      };
      this.sources.push(src);
      if (this.sources.length > 500) this.sources.shift();
      this.c.sources++;
      this.bump(kind);
      (kind === 'youtube' ? this.queues.toWatch : this.queues.toRead).push(src);
    }
  }

  title(kind, topic) {
    const t = topic.toLowerCase();
    return {
      youtube: this.pick([`I backtested ${t} for a year`, `${topic} — full walkthrough`, `Why ${t} works (with data)`]),
      github: this.pick([`${t.replace(/[^a-z]+/g, '-')}-backtest`, `fx-${t.split(' ')[0]}-research`, `quant-${t.replace(/[^a-z]+/g, '_')}`]),
      arxiv: this.pick([`On the profitability of ${t}`, `${topic}: evidence from 40 years of FX`, `A re-examination of ${t}`]),
      web: this.pick([`${topic}: a practical guide`, `What nobody tells you about ${t}`, `${topic} explained`]),
    }[kind];
  }

  reject(src, agent, reason) {
    src.status = 'rejected';
    this.c.sourceRejected++;
    this.emit('REJECTED', `Rejected: "${src.title}" · ${reason}`, agent);
  }

  read() {
    const src = this.queues.toRead.shift();
    if (!src) return;
    src.status = 'reading';
    this.spend('reader', 'read', src.size / 2000);
    if (src.hype) return this.reject(src, 'reader', 'promises fixed wins');
    if (this.chance(0.03)) return this.reject(src, 'reader', 'duplicate of an earlier source');
    src.status = 'read';
    this.c.read++;
    this.work('reader', `Reading "${src.title}"`, 'sum1');
    const what = { github: 'Repo', arxiv: 'Paper', web: 'Article' }[src.kind];
    this.emit('READ', `${what} opened · body text ${src.size.toLocaleString('en')} words · ${src.topic}`, 'reader');
    this.queues.toSummarize.push(src);
  }

  watch() {
    const src = this.queues.toWatch[0];
    if (!src) return;
    src.progress = (src.progress || 0) + 6 + Math.floor(this.r() * 10);
    src.status = 'reading';
    this.spend('watcher', 'watch', 0.4);
    this.work('watcher', `Watching "${src.title}", minute ${Math.min(src.progress, src.size)} of ${src.size}`);
    if (src.progress < src.size) return;
    this.queues.toWatch.shift();
    if (src.hype) return this.reject(src, 'watcher', 'promises fixed wins');
    src.status = 'read';
    this.c.read++;
    this.agents.watcher.task = `Finished "${src.title}"`;
    this.handoffs.push({ from: 'watcher', to: 'sum2', t: this.now });
    this.emit('WATCH', `Video 1 of 1 · subtitles fetched (${src.size} min) · ${src.topic}`, 'watcher');
    this.queues.toSummarize.push(src);
  }

  summarize() {
    for (const id of ['sum1', 'sum2', 'sum3']) {
      const src = this.queues.toSummarize.shift();
      if (!src) return;
      this.spend(id, 'summarize');
      const usable = this.chance(0.88);
      src.status = usable ? 'summarized' : 'rejected';
      if (!usable) { this.c.sourceRejected++; this.emit('SUMMARIZE', `Subagent summarizes · type: ${src.template} · status: no testable rule`, id); continue; }
      this.c.summarized++;
      this.work(id, `Summarizing "${src.title}"`, 'recipes');
      this.emit('SUMMARIZE', `Subagent summarizes · type: ${src.template} · status: usable`, id);
      this.queues.toRecipe.push(src);
    }
  }

  checkTerms() {
    if (!this.chance(0.06)) return;
    const term = this.pick(TERMS);
    if (this.terms.find((t) => t.term === term)) return;
    this.spend('terms', 'term');
    this.terms.push({ term, t: this.now, source: this.sources[this.sources.length - 1]?.title });
    this.work('terms', `New term "${term}"`);
    this.emit('TERM', `New term: "${term}" · proposal for the knowledge base`, 'terms');
    const k = this.knowledge.find((x) => x.step < 5);
    if (k) k.step++;
  }

  // ---------- live research (real sources) ----------
  liveScout() {
    const backlog = this.queues.toRead.length + this.queues.toWatch.length + this.queues.toSummarize.length;
    if (this.agents.scout.busy || backlog >= 12 || this.now - this.lastScout < SCOUT_MS) return;
    this.lastScout = this.now;
    const kinds = this.research.kinds, n = this.scoutN++;
    const kind = kinds[n % kinds.length], tp = TOPICS[Math.floor(n / kinds.length) % TOPICS.length];
    const where = { youtube: 'YouTube', github: 'GitHub', arxiv: 'arXiv', web: 'Hacker News' }[kind];
    this.job('scout', `Search ${where}: "${tp.q}"`, () => this.research.search(kind, tp.q), (results) => {
      if (!results) return;
      const fresh = results.filter((r) => r.url && !this.seenUrls.has(r.url));
      this.emit('SEARCH', `Search ${where}: "${tp.q}" · ${results.length} results, ${fresh.length} new`, 'scout');
      for (const r of fresh) {
        this.seenUrls.add(r.url);
        const src = { ...r, id: this.id('s'), topic: tp.topic, t: this.now, status: 'queued', size: r.text.split(/\s+/).length };
        this.sources.push(src);
        if (this.sources.length > 500) this.sources.shift();
        this.c.sources++;
        this.bump(kind);
        (kind === 'youtube' ? this.queues.toWatch : this.queues.toRead).push(src);
      }
      if (fresh.length) this.handoffs.push({ from: 'scout', to: kind === 'youtube' ? 'watcher' : 'reader', t: this.now });
    });
  }

  liveRead(agent, queue) {
    if (this.agents[agent].busy || !queue.length) return;
    const src = queue.shift();
    src.status = 'reading';
    this.reading = src;
    this.job(agent, `Reading "${src.title}"`, () => this.research.read(src), (text) => {
      if (!text) return this.reject(src, agent, 'could not be fetched');
      src.body = text;
      src.size = text.split(/\s+/).length;
      if (HYPE_RE.test(text)) return this.reject(src, agent, 'promises unrealistic returns');
      src.status = 'read';
      this.c.read++;
      const what = { github: 'README', arxiv: 'Abstract', web: 'Article', youtube: 'Video description' }[src.kind];
      this.emit(agent === 'watcher' ? 'WATCH' : 'READ', `${what} read · ${src.size.toLocaleString('en')} words · "${src.title}"`, agent);
      this.queues.toSummarize.push(src);
    });
  }

  liveSummarize() {
    for (const id of ['sum1', 'sum2', 'sum3']) {
      if (this.agents[id].busy || !this.queues.toSummarize.length) continue;
      const src = this.queues.toSummarize.shift();
      this.job(id, `Analyzing "${src.title}"`, () => this.research.analyst.analyze(src, src.body, this.symbols), (a) => {
        delete src.body;
        if (!a) { src.status = 'rejected'; this.c.sourceRejected++; return; }
        this.spendUsd(id, a.cost);
        src.summary = a.summary;
        for (const term of a.terms || []) this.pendingTerms.push({ term, source: src.title });
        if (!a.testable) {
          src.status = 'rejected';
          this.c.sourceRejected++;
          this.emit('SUMMARIZE', `"${src.title}" · ${a.reason}${a.cost ? ` · $${a.cost.toFixed(4)}` : ''}`, id);
          return;
        }
        src.status = 'summarized';
        src.template = a.template;
        src.analysis = a;
        this.c.summarized++;
        this.handoffs.push({ from: id, to: 'recipes', t: this.now });
        this.emit('SUMMARIZE', `"${src.title}" · ${TEMPLATES[a.template].label}${a.symbols.length ? ` on ${a.symbols.join(', ')}` : ''} · usable${a.cost ? ` · $${a.cost.toFixed(4)}` : ''}`, id);
        this.queues.toRecipe.push(src);
      });
    }
  }

  liveTerms() {
    const next = this.pendingTerms.shift();
    if (!next) return;
    const term = next.term.trim();
    if (!term || this.terms.find((t) => t.term.toLowerCase() === term.toLowerCase())) return;
    this.terms.push({ term, t: this.now, source: next.source });
    if (this.terms.length > 200) this.terms.shift();
    this.work('terms', `New term "${term}"`);
    const known = CONCEPTS.find((c) => c.name.toLowerCase() === term.toLowerCase() || c.aka.toLowerCase().split(/\s*·\s*/).includes(term.toLowerCase()));
    const k = known && this.knowledge.find((x) => x.id === known.id);
    if (k && k.step < 5) k.step++;
    this.emit('TERM', `${known ? 'Known' : 'New'} term: "${term}" · from "${next.source}"`, 'terms');
  }

  makeRecipes() {
    const src = this.queues.toRecipe.shift();
    if (!src) return;
    const an = src.analysis;
    // Live: test on the pairs the source names (or two others), with the source's own settings.
    const plan = an
      ? (an.symbols.length ? an.symbols.slice(0, 3) : this.symbols.slice().sort(() => this.r() - 0.5).slice(0, 2)).map((symbol) => ({ symbol, tf: an.timeframe, params: { ...an.params } }))
      : Array.from({ length: 1 + Math.floor(this.r() * 4) }, () => ({ symbol: this.pick(this.symbols), tf: this.chance(0.6) ? '1h' : '4h', params: mutate(src.template, defaults(src.template), this.r, 0.25) }));
    const n = plan.length;
    for (const { symbol, tf, params: base } of plan) {
      let name = `${TEMPLATES[src.template].label} ${symbol} ${tf}`;
      const same = [...this.strategies.values()].filter((s) => s.baseName === name).length;
      const strat = {
        id: this.id('r'), baseName: name, name: same ? `${name} v${same + 1}` : name,
        template: src.template, symbol, tf, params: base, source: src.title, sourceKind: src.kind, sourceUrl: src.url,
        status: 'queued', gates: [null, null, null, null, null], created: this.now,
      };
      this.strategies.set(strat.id, strat);
      this.c.recipes++;
      this.bump('thought');
      this.spend('recipes', 'recipe');
      this.queues.toLab.push(strat);
    }
    this.work('recipes', `Writing ${n} recipe${n > 1 ? 's' : ''} from "${src.title}"`, 'lab');
    this.emit('RECIPE', `${n} recipe${n > 1 ? 's' : ''} from "${src.title}" · ${TEMPLATES[src.template].label}`, 'recipes');
  }

  runLab() {
    for (let k = 0; k < 2; k++) {
      const s = this.queues.toLab.shift();
      if (!s) return;
      this.test(s);
    }
  }

  test(s) {
    const bars = this.hist[s.symbol][s.tf];
    const split = Math.floor(bars.length * SPLIT);
    let best = null;
    for (let v = 0; v < VARIANTS_PER_RECIPE; v++) {
      const params = v ? mutate(s.template, s.params, this.r) : s.params;
      const ins = backtest(bars, s.template, params, s.symbol, { to: split });
      this.spend('lab', 'variant');
      this.c.variants++;
      this.bump('tested');
      if (!best || ins.metrics.sharpe > best.ins.metrics.sharpe) best = { params, ins };
      if (v < 3) {
        const full = backtest(bars, s.template, params, s.symbol);
        this.variants.push({
          id: this.id('v'), strategyId: s.id, name: s.name, symbol: s.symbol, tf: s.tf,
          sharpe: ins.metrics.sharpe, trades: full.metrics.trades, winrate: round(full.metrics.winrate, 3),
          net: Math.round(full.metrics.net), equity: downsample(full.metrics.equity, 40),
          split: splitIndex(full.trades, bars[split].t), passed: null, t: this.now,
        });
        if (this.variants.length > 100) this.variants.shift();
      }
    }
    this.c.tested++;
    s.params = best.params;
    s.variantsTested = VARIANTS_PER_RECIPE;
    s.isSharpe = best.ins.metrics.sharpe;
    this.work('lab', `Testing ${s.name} · ${VARIANTS_PER_RECIPE} variants`, 'director');
    const minTrades = s.tf === '1h' ? 30 : 12;
    if (best.ins.metrics.sharpe < 0.5 || best.ins.metrics.trades < minTrades) {
      s.status = 'failed-lab';
      s.failReason = best.ins.metrics.trades < minTrades ? 'too few trades' : `in-sample Sharpe ${best.ins.metrics.sharpe}`;
      this.c.labFailed++;
      this.markVariants(s.id, false);
      this.emit('LAB', `${s.name} · best in-sample Sharpe ${best.ins.metrics.sharpe} · dropped`, 'lab');
      return;
    }
    this.sieve(s, bars, split);
  }

  // The sieve: five independent checks a recipe must survive before it can reach paper.
  sieve(s, bars, split) {
    this.c.sieved++;
    const g = s.gates;
    const fail = (i, reason, key) => {
      for (let j = i; j < 5; j++) if (g[j] === null) g[j] = j === i ? false : null;
      s.status = 'failed-sieve';
      s.failReason = reason;
      this.c.sieveFailed++;
      this.sieveFailReasons[key]++;
      this.markVariants(s.id, false);
      this.emit('SIEVE', `${s.name} · failed: ${reason}`, 'lab');
    };
    this.spend('lab', 'sieve');
    const full = backtest(bars, s.template, s.params, s.symbol);
    s.spark = downsample(full.metrics.equity, 24);

    const costFirst = this.settings.earlyCostCheck;
    const costCheck = () => backtest(bars, s.template, s.params, s.symbol, { costMult: 3 }).metrics.sharpe > 0.6;
    if (costFirst && !costCheck()) return fail(3, 'not robust at 3× spread', 'cost');

    const oos = backtest(bars, s.template, s.params, s.symbol, { from: split });
    s.oosSharpe = oos.metrics.sharpe;
    if (!(g[0] = oos.metrics.sharpe > 0.6)) return fail(0, `out-of-sample Sharpe ${oos.metrics.sharpe}`, 'oos');

    const lo = backtest(bars, s.template, scale(s.template, s.params, 0.8), s.symbol).metrics.sharpe;
    const hi = backtest(bars, s.template, scale(s.template, s.params, 1.2), s.symbol).metrics.sharpe;
    if (!(g[1] = lo > 0.2 && hi > 0.2)) return fail(1, `settings ±20% break it (${lo} / ${hi})`, 'robust');

    const other = this.pick(this.symbols.filter((x) => x !== s.symbol));
    const tr = backtest(this.hist[other][s.tf], s.template, s.params, other).metrics.sharpe;
    s.transfer = { symbol: other, sharpe: tr };
    if (!(g[2] = tr > 0)) return fail(2, `does not carry over to ${other}`, 'transfer');

    if (!(g[3] = costFirst || costCheck())) return fail(3, 'not robust at 3× spread', 'cost');

    const pos = full.metrics.monthly.filter((m) => m.r > 0).length / Math.max(1, full.metrics.monthly.length);
    if (!(g[4] = pos >= 0.5)) return fail(4, `only ${Math.round(pos * 100)}% of months positive`, 'months');

    s.status = 'validated';
    s.sharpe = full.metrics.sharpe;
    this.c.validated++;
    this.bump('validated');
    this.markVariants(s.id, true);
    this.emit('SIEVE', `${s.name} · passed all five checks · Sharpe ${full.metrics.sharpe}`, 'lab');
    this.propose({
      kind: 'paper', strategyId: s.id, title: s.name,
      body: `Sharpe OOS ${s.oosSharpe}. Also works with settings ±20% and on ${other}. The vault is reached.`,
    });
  }

  markVariants(id, passed) {
    for (const v of this.variants) if (v.strategyId === id) v.passed = passed;
  }

  propose(d) {
    this.decisions.push({ id: this.id('d'), status: 'pending', t: this.now, ...d });
    this.spend('director', 'director');
    this.work('director', `Proposal: ${d.title}`);
    this.emit('PROPOSAL', `${d.kind === 'skill' ? 'Skill proposal' : d.kind === 'live' ? 'To live' : 'To paper'}: ${d.title}`, 'director');
  }

  direct() {
    if (this.tickNo % 120 === 0) this.hermesReport();
    const costFails = this.sieveFailReasons.cost;
    if (!this.settings.earlyCostCheck && costFails >= 6 && !this.decisions.find((d) => d.skill === 'earlyCostCheck')) {
      const pct = Math.round((costFails / Math.max(1, this.c.sieveFailed)) * 100);
      this.propose({
        kind: 'skill', skill: 'earlyCostCheck', title: 'Check costs earlier',
        body: `${costFails} strategies only failed the sieve at the cost check (${pct}% of sieve failures). Checking costs first saves backtest time.`,
      });
    }
  }

  hermesReport() {
    const day = this.reports.length + 1;
    const top = [...this.strategies.values()].filter((s) => s.status === 'validated' || s.status === 'paper').sort((a, b) => b.sharpe - a.sharpe)[0];
    const topic = Object.entries(this.sources.reduce((m, s) => ((m[s.topic] = (m[s.topic] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1])[0];
    this.reports.push({
      t: this.now, day,
      cameIn: `${this.c.sources} sources found, ${this.c.read} read, ${this.c.recipes} recipes written, ${this.c.variants.toLocaleString('en')} variants tested.`,
      cost: `$${this.budget.spent.toFixed(2)} of $${this.budget.limit} thinking budget used.`,
      stoodOut: top ? `${top.name} passed all five checks with Sharpe ${top.sharpe}.` : 'Nothing passed the sieve yet.',
      topic: topic ? `Most-researched topic: ${topic[0]} (${topic[1]} sources).` : '',
      proposals: this.decisions.filter((d) => d.status === 'pending').length,
    });
    if (this.reports.length > 10) this.reports.shift();
    this.emit('REPORT', `Hermes wrote report #${day}`, 'director');
  }

  // ---------- decisions from you ----------
  decide(id, action) {
    const d = this.decisions.find((x) => x.id === id);
    if (!d || d.status !== 'pending') return false;
    d.status = action === 'approve' ? 'approved' : 'rejected';
    d.decidedAt = Date.now();
    const s = d.strategyId && this.strategies.get(d.strategyId);
    if (d.kind === 'paper' && s) {
      if (d.status === 'approved') {
        s.status = 'paper';
        this.c.paper++;
        this.paper.set(s.id, { pos: null, trades: [], equity: [0], bars: 0, lastT: 0, startT: this.now });
        this.emit('PAPER', `${s.name} starts paper trading · day 1 of ${PAPER_DAYS}`, 'director');
      } else s.status = 'rejected';
    }
    if (d.kind === 'live' && s && d.status === 'approved') {
      s.status = 'live';
      this.c.live++;
      this.emit('LIVE', `${s.name} switched to live on ${this.data.source === 'synthetic' ? 'generated prices' : 'real OS AI data'} · no orders are sent until a broker is connected`, 'director');
    }
    if (d.kind === 'skill' && d.status === 'approved') {
      this.settings[d.skill] = true;
      this.emit('SKILL', `Skill enabled: ${d.title}`, 'director');
    }
    return true;
  }

  verdict(id, ok, note = '') {
    const k = this.knowledge.find((x) => x.id === id);
    if (!k) return false;
    k.verdict = ok ? 'ok' : 'wrong';
    k.note = note;
    k.step = 6;
    this.emit('CHECK', `You marked "${CONCEPTS.find((c) => c.id === id).name}" as ${ok ? 'correct' : 'wrong'}${note ? ` · "${note}"` : ''}`, 'terms');
    return true;
  }

  // ---------- paper trading on the live synthetic feed ----------
  paperStep() {
    for (const s of this.symbols) this.feeds[s].next();
    for (const [id, p] of this.paper) {
      const s = this.strategies.get(id);
      const raw = this.feeds[s.symbol].bars;
      const bars = s.tf === '1h' ? raw.slice(-600) : resample(raw.slice(-(2400 + (raw.length % 4))), 4);
      const last = bars[bars.length - 1];
      if (last.t === p.lastT) continue;
      p.lastT = last.t;
      p.bars++;
      const inst = INSTRUMENTS[s.symbol];
      if (p.pos) {
        const o = p.pos;
        o.held++;
        const stop = o.dir > 0 ? last.l <= o.stop : last.h >= o.stop;
        const tgt = o.dir > 0 ? last.h >= o.target : last.l <= o.target;
        const exit = stop ? o.stop : tgt ? o.target : o.held >= o.maxBars ? last.c : null;
        if (exit !== null) {
          const move = (exit - o.entry) * o.dir - inst.spread;
          const pnl = move * inst.contract * inst.toUsd(exit);
          p.trades.push({ dir: o.dir, entry: o.entry, exit, pnl, r: move / Math.abs(o.entry - o.stop), t: last.t });
          p.equity.push(p.equity[p.equity.length - 1] + pnl);
          p.pos = null;
          this.emit(s.status === 'live' ? 'LIVE' : 'PAPER', `${s.name} closed ${o.dir > 0 ? 'long' : 'short'} · ${pnl >= 0 ? '+' : ''}$${Math.round(pnl)}`, 'lab');
        }
      } else {
        const sig = TEMPLATES[s.template].signals(bars, s.params).filter((x) => x.i === bars.length - 1)[0];
        if (sig && !sig.entry) {
          p.pos = { dir: sig.dir, entry: last.c, stop: sig.stop, target: sig.target, maxBars: sig.maxBars, held: 0, t: last.t };
          this.emit(s.status === 'live' ? 'LIVE' : 'PAPER', `${s.name} opened ${sig.dir > 0 ? 'long' : 'short'} at ${last.c.toFixed(inst.digits)}`, 'lab');
        }
      }
      const day = Math.floor(p.bars / (s.tf === '1h' ? BARS_PER_PAPER_DAY : BARS_PER_PAPER_DAY / 4));
      if (s.status === 'paper' && day >= PAPER_DAYS && !p.liveProposed) {
        p.liveProposed = true;
        const net = p.equity[p.equity.length - 1];
        if (net > 0) this.propose({ kind: 'live', strategyId: id, title: s.name, body: `${PAPER_DAYS} paper days done: ${p.trades.length} trades, ${net >= 0 ? '+' : ''}$${Math.round(net)}. Ready for live.` });
        else this.emit('PAPER', `${s.name} finished paper at $${Math.round(net)} · not proposed for live`, 'director');
      }
    }
  }

  // ---------- views ----------
  snapshot() {
    const strategies = [...this.strategies.values()];
    const tier = (s) => (['live', 'paper', 'validated'].includes(s.status) ? 1 : 0);
    const ranked = strategies.filter((s) => s.spark).sort((a, b) => tier(b) - tier(a) || (b.sharpe ?? b.isSharpe) - (a.sharpe ?? a.isSharpe)).slice(0, 40);
    const paperList = [...this.paper.entries()].map(([id, p]) => {
      const s = this.strategies.get(id);
      const net = p.equity[p.equity.length - 1];
      const wins = p.trades.filter((t) => t.pnl > 0).length;
      return {
        id, name: s.name, status: s.status, symbol: s.symbol, tf: s.tf,
        day: Math.min(PAPER_DAYS, 1 + Math.floor(p.bars / (s.tf === '1h' ? BARS_PER_PAPER_DAY : BARS_PER_PAPER_DAY / 4))),
        days: PAPER_DAYS, net: Math.round(net), trades: p.trades.length, winrate: p.trades.length ? wins / p.trades.length : 0,
        equity: downsample(p.equity, 40), pos: p.pos && { dir: p.pos.dir, entry: p.pos.entry, stop: p.pos.stop, target: p.pos.target },
        price: this.feeds[s.symbol].price, digits: INSTRUMENTS[s.symbol].digits,
      };
    });
    const liveNet = paperList.filter((p) => p.status === 'live').reduce((a, p) => a + p.net, 0);
    const elapsedH = Math.max(0.05, (Date.now() - this.started) / 3600000);
    return {
      now: Date.now(),
      round: this.tickNo,
      paused: this.settings.paused,
      settings: this.settings,
      counts: { ...this.c, onPaper: paperList.filter((p) => p.status === 'paper').length, liveNet },
      budget: { limit: this.budget.limit, spent: round(this.budget.spent, 3), byAgent: this.budget.byAgent, history: this.budget.history, perHour: round(this.budget.spent / elapsedH, 3) },
      buckets: Object.fromEntries(Object.entries(this.buckets).map(([k, v]) => [k, v.map((b) => b.n)])),
      sourceTotals: Object.fromEntries(KINDS.map((k) => [k, this.sources.filter((s) => s.kind === k).length])),
      activity: this.activity.map((a) => a.n),
      log: this.log.slice(-80),
      handoffs: this.handoffs,
      agents: Object.values(this.agents),
      decisions: this.decisions.slice(-40),
      variants: this.variants,
      ranked: ranked.map(summary),
      sieveFailReasons: this.sieveFailReasons,
      sources: this.sources.slice(-300).map(({ id, kind, topic, title, status, t, size, progress, url, summary }) => ({ id, kind, topic, title, status, t, size, progress, url, summary })),
      research: this.research ? { mode: 'live', analyst: this.research.analyst.label, kinds: this.research.kinds } : { mode: 'simulated' },
      topics: TOPICS.map((t) => t.topic),
      reading: this.research ? (this.reading && { id: this.reading.id, kind: this.reading.kind, topic: this.reading.topic, title: this.reading.title, status: this.reading.status, size: this.reading.size, url: this.reading.url, live: true }) : this.queues.toWatch[0] || this.sources.filter((s) => s.status === 'read' || s.status === 'summarized').slice(-1)[0] || null,
      queues: Object.fromEntries(Object.entries(this.queues).map(([k, v]) => [k, v.length])),
      paper: paperList,
      terms: this.terms,
      report: this.reports[this.reports.length - 1] || null,
      knowledge: this.knowledge.map((k) => {
        const c = CONCEPTS.find((x) => x.id === k.id);
        return { id: k.id, name: c.name, aka: c.aka, category: c.category, tag: c.tag, step: k.step, verdict: k.verdict, note: k.note, found: k.stats.found, followRate: k.stats.followRate };
      }),
      machines: machineStats(),
      data: {
        ...this.data,
        symbols: this.symbols.map((s) => {
          const f = this.feeds[s], last = f.bars[f.bars.length - 1];
          return { symbol: s, bars: this.hist[s]['1h'].length, from: this.hist[s]['1h'][0].t, lastBar: last.t, price: f.price, spread: INSTRUMENTS[s].spread, digits: INSTRUMENTS[s].digits, lastPoll: f.lastPoll ?? null, error: f.error ?? null };
        }),
      },
    };
  }

  strategyDetail(id) {
    const s = this.strategies.get(id);
    if (!s) return null;
    const bars = this.hist[s.symbol][s.tf];
    const full = backtest(bars, s.template, s.params, s.symbol);
    const m = full.metrics;
    return {
      ...summary(s), params: s.params, paramDefs: TEMPLATES[s.template].params, blurb: TEMPLATES[s.template].blurb,
      source: s.source, sourceUrl: s.sourceUrl, transfer: s.transfer, failReason: s.failReason,
      metrics: { trades: m.trades, winrate: m.winrate, rr: m.rr, expectancy: m.expectancy, expectancyR: m.expectancyR, net: m.net, maxDD: m.maxDD, sharpe: m.sharpe },
      equity: downsample(m.equity, 160), drawdown: downsample(m.drawdown, 160), monthly: m.monthly,
      split: splitIndex(full.trades, bars[Math.floor(bars.length * SPLIT)].t),
      trades: full.trades.slice(-25).reverse().map((t) => ({ ...t, pnl: Math.round(t.pnl), r: round(t.r, 2) })),
      digits: INSTRUMENTS[s.symbol].digits,
    };
  }

  knowledgeDetail(id) {
    const k = this.knowledge.find((x) => x.id === id);
    const c = CONCEPTS.find((x) => x.id === id);
    if (!k) return null;
    return { id, name: c.name, aka: c.aka, category: c.category, tag: c.tag, plain: c.plain, code: c.code, step: k.step, verdict: k.verdict, note: k.note, ...k.stats };
  }
}

function summary(s) {
  return {
    id: s.id, name: s.name, template: s.template, symbol: s.symbol, tf: s.tf, status: s.status,
    gates: s.gates, sharpe: s.sharpe ?? s.isSharpe, oosSharpe: s.oosSharpe ?? null, isSharpe: s.isSharpe, spark: s.spark,
  };
}

// Position (0..1) along the downsampled equity where out-of-sample begins.
function splitIndex(trades, splitT) {
  if (!trades.length) return 0.7;
  const n = trades.filter((t) => t.exitT < splitT).length;
  return n / trades.length;
}

function machineStats() {
  const mem = process.memoryUsage();
  return [
    { name: 'orion', role: 'Brain loop · research and lab', load: os.loadavg()[0], cpus: os.cpus().length, rss: mem.rss, heap: mem.heapUsed, uptime: process.uptime() },
    { name: 'hermes', role: 'Reporter · morning brief', load: os.loadavg()[1], cpus: os.cpus().length, rss: mem.external, heap: mem.arrayBuffers, uptime: os.uptime() },
  ];
}
