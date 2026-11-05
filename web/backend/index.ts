import { router, json, error, db } from '@appdeploy/sdk';
import { analyze, track, Setup } from './analyze';
import { Bar, MarketError, PAIRS, TIMEFRAMES, clock, fetchBars, isCrypto, normPair, size } from './market';
import { DeskReview, runDesk } from './agents';
import {
  FeedEvent, META, REVIEWS, SIGNALS, budgetUsed, closeSignal, feedAdd, feedList, getDoc, indexAdd,
  indexIds, indexRemove, stats, takeAgentBudget,
} from './store';

const SWING = 3;
const CHART_BARS = 220;
const AGENT_RUNS_PER_HOUR = 40;            // protects AI credits on a public page
const WATCHLIST = ['EURUSD', 'XAUUSD', 'BTCUSD', 'GBPUSD', 'USDJPY'];
const SCAN_TFS = ['15m', '1h'];
const SCAN_MIN_RR = 2;
const REVIEWS_PER_SCAN = 1;                // AI only for new setups, at most one per run
const MANUAL_SCAN_COOLDOWN_MS = 120_000;

type SignalRecord = Setup & {
  minRR: number; createdAt: number; source: 'manual' | 'scanner';
  outcome?: string; realizedR?: number; closedAt?: number;
};
type ScannerDoc = {
  lastRun: number; trigger: string; scanned: number; found: number; reviewed: number; closed: number;
  errors: number; note: string; ms: number; setups: string[];
};

const label = (pair: string) => `${pair.slice(0, 3)}/${pair.slice(3)}`;

function fail(e: unknown) {
  if (e instanceof MarketError) return error(e.message, 400);
  const rpc = e as { statusCode?: number; responseText?: string };
  if (rpc && typeof rpc === 'object' && rpc.statusCode === 429) {
    return error('The AI agents are busy right now (rate limited). Try again in a minute.', 429);
  }
  console.error('request failed', e);
  return error(e instanceof Error ? e.message : 'Something went wrong', 502);
}

function parseTf(raw: string | undefined): string {
  const tf = (raw || '15m').toLowerCase();
  if (!TIMEFRAMES[tf]) throw new MarketError(`Timeframe must be one of ${Object.keys(TIMEFRAMES).join(', ')}`);
  return tf;
}

function parseMinRR(raw: string | number | undefined): number {
  const v = raw === undefined || raw === '' ? 2 : Number(raw);
  if (!Number.isFinite(v) || v < 0.5 || v > 10) throw new MarketError('Minimum reward:risk must be between 0.5 and 10');
  return v;
}

async function runAnalysis(pairRaw: string, tfRaw: string | undefined, minRaw: string | number | undefined) {
  const pair = normPair(pairRaw);
  const tf = parseTf(tfRaw);
  const minRR = parseMinRR(minRaw);
  const bars = await fetchBars(pair, tf);
  return { pair, tf, minRR, bars, setup: analyze(pair, bars, SWING, minRR, tf) };
}

/** One record per pair, timeframe, closing bar and minimum - also the desk review id. */
function setupId(s: Setup, minRR: number): string {
  return `${s.pair}_${s.timeframe}_${s.lastBarTime}_${String(minRR).replace('.', 'p')}`;
}

function deskEvents(r: DeskReview): FeedEvent[] {
  const at = Date.now();
  const base = { pair: r.pair, tf: r.timeframe };
  const out: FeedEvent[] = [
    { ...base, at, agent: 'analyst', text: `Market Analyst: ${r.analyst.verdict}${r.analyst.confidence != null ? ` (${r.analyst.confidence}%)` : ''} after ${r.analyst.tools.length} tool call(s)`, tone: 'info' },
  ];
  if (r.risk.status !== 'skipped') {
    out.push({ ...base, at, agent: 'risk', text: `Risk Manager: ${r.risk.verdict.toUpperCase()}${r.risk.concerns[0] ? ` - ${r.risk.concerns[0]}` : ''}`, tone: r.risk.verdict === 'veto' ? 'bad' : r.risk.verdict === 'pass' ? 'good' : 'warn' });
  }
  out.push({ ...base, at, agent: 'head', text: `Desk decision: ${r.final.toUpperCase()}${r.final === 'take' ? ` (${r.confidence}%)` : ''} - ${r.summary}`, tone: r.final === 'take' ? 'good' : 'info' });
  return out;
}

async function reviewSetup(
  id: string, s: Setup, bars: Bar[], sink?: FeedEvent[],
): Promise<{ review: DeskReview; cached: boolean }> {
  const [saved] = await db.get<DeskReview>(REVIEWS, [id]);
  if (saved) return { review: saved, cached: true };
  const budget = await takeAgentBudget(AGENT_RUNS_PER_HOUR);
  if (!budget.ok) {
    throw new MarketError(`The agent desk has used its ${AGENT_RUNS_PER_HOUR} reviews for this hour. Try again after the hour turns.`);
  }
  const review = await runDesk(id, s, bars);
  await db.tx.add(REVIEWS, [{ ...review, id }]);
  if (sink) sink.push(...deskEvents(review));   // the scanner writes its feed in order, once
  else await feedAdd(deskEvents(review));
  return { review, cached: false };
}

const TERMINAL = new Set(['target hit', 'stopped', 'stopped after TP1', 'missed']);

/** Tracker: close finished trades and count them in the forward-test stats. */
async function trackOpen(events: FeedEvent[]): Promise<number> {
  const ids = await indexIds();
  if (!ids.length) return 0;
  const docs = await db.get<SignalRecord>(SIGNALS, ids);
  const cache = new Map<string, Promise<Bar[] | null>>();
  let closed = 0;
  for (let i = 0; i < ids.length; i++) {
    const s = docs[i];
    if (!s || s.decision !== 'trade' || s.outcome) continue;
    const key = `${s.pair}:${s.timeframe}`;
    if (!cache.has(key)) cache.set(key, fetchBars(s.pair, s.timeframe).catch(() => null));
    const bars = await cache.get(key);
    if (!bars || !bars.length) continue;
    const t = track(s, bars);
    if (!TERMINAL.has(t.status)) continue;
    const r = t.status === 'target hit' ? s.rr ?? 0 : t.status === 'missed' ? 0 : -1;
    if (await closeSignal(ids[i], t.status, r)) {
      closed++;
      events.push({
        at: Date.now(), agent: 'tracker', pair: s.pair, tf: s.timeframe,
        text: `Tracker: ${label(s.pair)} ${s.timeframe} ${String(s.side).toUpperCase()} ${t.status}${t.status === 'missed' ? '' : ` (${r > 0 ? '+' : ''}${r}R)`}`,
        tone: t.status === 'target hit' ? 'good' : t.status === 'missed' ? 'info' : 'bad',
      });
    }
  }
  return closed;
}

/** Scanner: read every watched chart; new setups are logged and the newest gets an agent review. */
async function scan(trigger: 'cron' | 'manual', withAgents: boolean): Promise<ScannerDoc> {
  const t0 = Date.now();
  const events: FeedEvent[] = [];
  const doc: ScannerDoc = { lastRun: t0, trigger, scanned: 0, found: 0, reviewed: 0, closed: 0, errors: 0, note: '', ms: 0, setups: [] };
  const c = clock();
  // FX closes for the weekend; crypto trades 24/7, so it is always scanned
  const pairs = c.open ? WATCHLIST : WATCHLIST.filter(isCrypto);
  if (!c.open) doc.note = 'FX market is closed until Sunday 17:00 New York - scanned crypto only.';
  {
    const fresh: Array<{ id: string; s: Setup; bars: Bar[] }> = [];
    for (const pair of pairs) {
      for (const tf of SCAN_TFS) {
        try {
          const bars = await fetchBars(pair, tf);
          const s = analyze(pair, bars, SWING, SCAN_MIN_RR, tf);
          doc.scanned++;
          if (s.decision !== 'trade') continue;
          const id = setupId(s, SCAN_MIN_RR);
          doc.setups.push(`${label(pair)} ${tf} ${String(s.side).toUpperCase()}`);
          const record: SignalRecord = { ...s, minRR: SCAN_MIN_RR, createdAt: Date.now(), source: 'scanner' };
          const [created] = await db.tx.add(SIGNALS, [{ ...record, id }]);
          if (created) {
            await indexAdd(id);
            fresh.push({ id, s, bars });
            doc.found++;
          }
        } catch (e) {
          doc.errors++;
          console.warn('scan failed', pair, tf, e instanceof Error ? e.message : e);
        }
      }
    }
    events.push({
      at: Date.now(), agent: 'scanner', tone: doc.found ? 'good' : 'info',
      text: `Scanner: read ${doc.scanned} charts - ${doc.setups.length ? `setups on ${doc.setups.join(', ')}` : 'no setups that meet 1:2'}`
        + `${doc.found ? ` (${doc.found} new, logged)` : ''}${doc.errors ? `; ${doc.errors} chart(s) failed to load` : ''}`
        + `${doc.note ? `. ${doc.note}` : ''}`,
    });
    if (withAgents) {
      for (const f of fresh.slice(0, REVIEWS_PER_SCAN)) {
        try {
          const { cached } = await reviewSetup(f.id, f.s, f.bars, events);
          if (!cached) doc.reviewed++;
        } catch (e) {
          console.warn('desk review failed', f.id, e instanceof Error ? e.message : e);
        }
      }
    }
  }
  try {
    doc.closed = await trackOpen(events);
  } catch (e) {
    console.warn('tracker failed', e instanceof Error ? e.message : e);
  }
  if (events.length) await feedAdd(events);
  doc.ms = Date.now() - t0;
  await db.tx.update(META, [{ id: 'scanner', record: { ...doc } }]);
  return doc;
}

/** Cron: every 15 minutes. */
export const scanMarkets = async () => {
  try {
    await scan('cron', true);
  } catch (e) {
    console.error('scheduled scan failed', e);
  }
  return { statusCode: 200 };
};

export const handler = router({
  'GET /api/_healthcheck': [async () => json({ message: 'Success' })],

  'GET /api/meta': [async () => {
    try {
      const [scanner, used] = await Promise.all([getDoc<ScannerDoc>(META, 'scanner'), budgetUsed()]);
      return json({
        pairs: PAIRS, timeframes: Object.keys(TIMEFRAMES), clock: clock(), scanner,
        watchlist: WATCHLIST, scanTimeframes: SCAN_TFS, agentBudget: { used, cap: AGENT_RUNS_PER_HOUR },
      });
    } catch (e) {
      return fail(e);
    }
  }],

  'GET /api/analyze': [async ({ query }) => {
    try {
      const { bars, setup, minRR } = await runAnalysis(query.pair, query.tf, query.minRR);
      const chart = bars.slice(-CHART_BARS).map((b) => [b.t, b.open, b.high, b.low, b.close, b.vol]);
      const [review] = await db.get<DeskReview>(REVIEWS, [setupId(setup, minRR)]);
      return json({ setup, bars: chart, clock: clock(), analyzedAt: Date.now(), review: review ?? null });
    } catch (e) {
      return fail(e);
    }
  }],

  // Run the three-agent desk on the current reading (cached per reading).
  'POST /api/desk': [async ({ body }) => {
    try {
      const b = (body || {}) as Record<string, string | number | undefined>;
      const { setup, minRR, bars } = await runAnalysis(String(b.pair || ''), b.tf as string | undefined, b.minRR);
      const { review, cached } = await reviewSetup(setupId(setup, minRR), setup, bars);
      return json({ review, cached });
    } catch (e) {
      return fail(e);
    }
  }],

  'POST /api/size': [async ({ body }) => {
    try {
      const b = (body || {}) as Record<string, unknown>;
      const num = (k: string) => (b[k] === undefined || b[k] === null || b[k] === '' ? undefined : Number(b[k]));
      return json(await size({
        pair: normPair(String(b.pair || '')),
        entry: num('entry') as number, stop: num('stop') as number, target: num('target'),
        account: num('account') ?? 10000, riskPct: num('riskPct') ?? 1, leverage: num('leverage') ?? 30,
      }));
    } catch (e) {
      return fail(e);
    }
  }],

  // Saving re-runs the analysis on the server, so the log only ever holds real readings.
  'POST /api/signals': [async ({ body }) => {
    try {
      const b = (body || {}) as Record<string, string | number | undefined>;
      const { setup, minRR } = await runAnalysis(String(b.pair || ''), b.tf as string | undefined, b.minRR);
      const id = setupId(setup, minRR);
      const record: SignalRecord = { ...setup, minRR, createdAt: Date.now(), source: 'manual' };
      const [created] = await db.tx.add(SIGNALS, [{ ...record, id }]);
      await indexAdd(id);
      return json({ id, duplicate: created === null, signal: record }, created === null ? 200 : 201);
    } catch (e) {
      return fail(e);
    }
  }],

  'GET /api/signals': [async () => {
    try {
      const ids = await indexIds();
      if (!ids.length) return json({ signals: [], checkedAt: Date.now() });
      const [docs, reviews] = await Promise.all([db.get<SignalRecord>(SIGNALS, ids), db.get<DeskReview>(REVIEWS, ids)]);
      const cache = new Map<string, Promise<Bar[] | null>>();
      const out = await Promise.all(ids.map(async (id, i) => {
        const s = docs[i];
        if (!s) return null;
        const desk = reviews[i] ? { final: reviews[i]!.final, confidence: reviews[i]!.confidence } : null;
        if (s.decision !== 'trade' || s.outcome) return { ...s, id, live: null, desk };
        const key = `${s.pair}:${s.timeframe}`;
        if (!cache.has(key)) cache.set(key, fetchBars(s.pair, s.timeframe).catch(() => null));
        const bars = await cache.get(key);
        return { ...s, id, live: bars && bars.length ? track(s, bars) : null, desk };
      }));
      return json({ signals: out.filter(Boolean), checkedAt: Date.now() });
    } catch (e) {
      return fail(e);
    }
  }],

  'DELETE /api/signals/:id': [async ({ params }) => {
    try {
      const [deleted] = await db.delete(SIGNALS, [params.id]);
      await indexRemove(params.id);
      return deleted ? json({ deleted: true }) : error('That signal was not found', 404);
    } catch (e) {
      return fail(e);
    }
  }],

  'GET /api/activity': [async () => {
    try {
      return json({ events: await feedList() });
    } catch (e) {
      return fail(e);
    }
  }],

  'GET /api/performance': [async () => {
    try {
      const s = await stats();
      const decided = s.closed;
      return json({
        ...s,
        winRate: decided ? Math.round((s.targetHit / decided) * 1000) / 10 : null,
        avgR: decided ? Math.round((s.rSum / decided) * 100) / 100 : null,
        note: 'Forward test of logged trades. R assumes the whole position is held from entry to the final target or the stop; spread and slippage are not included.',
      });
    } catch (e) {
      return fail(e);
    }
  }],

  // Run the scanner now (charts + tracker only; agent reviews run on the 15-minute schedule).
  'POST /api/scanner/run': [async () => {
    try {
      const last = await getDoc<ScannerDoc>(META, 'scanner');
      if (last && Date.now() - last.lastRun < MANUAL_SCAN_COOLDOWN_MS) {
        return json({ scanner: last, fresh: false });
      }
      return json({ scanner: await scan('manual', false), fresh: true });
    } catch (e) {
      return fail(e);
    }
  }],
});
