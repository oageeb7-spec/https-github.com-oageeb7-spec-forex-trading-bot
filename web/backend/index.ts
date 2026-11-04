import { router, json, error, db } from '@appdeploy/sdk';
import { analyze, track, Setup } from './analyze';
import { Bar, MarketError, PAIRS, TIMEFRAMES, clock, fetchBars, normPair, size } from './market';

const SWING = 3;
const TABLE = 'signals';
const CHART_BARS = 220;

type SignalRecord = Setup & { minRR: number; createdAt: number };

function fail(e: unknown) {
  if (e instanceof MarketError) return error(e.message, 400);
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

/** Table-safe chosen ID: one saved record per pair, timeframe, closing bar and minimum. */
function signalId(s: Setup, minRR: number): string {
  return `${s.pair}_${s.timeframe}_${s.lastBarTime}_${String(minRR).replace('.', 'p')}`;
}

export const handler = router({
  'GET /api/_healthcheck': [async () => json({ message: 'Success' })],

  'GET /api/meta': [async () => json({ pairs: PAIRS, timeframes: Object.keys(TIMEFRAMES), clock: clock() })],

  'GET /api/analyze': [async ({ query }) => {
    try {
      const { bars, setup } = await runAnalysis(query.pair, query.tf, query.minRR);
      const chart = bars.slice(-CHART_BARS).map((b) => [b.t, b.open, b.high, b.low, b.close, b.vol]);
      return json({ setup, bars: chart, clock: clock(), analyzedAt: Date.now() });
    } catch (e) {
      return fail(e);
    }
  }],

  'POST /api/size': [async ({ body }) => {
    try {
      const b = (body || {}) as Record<string, unknown>;
      const num = (k: string) => (b[k] === undefined || b[k] === null || b[k] === '' ? undefined : Number(b[k]));
      const result = await size({
        pair: normPair(String(b.pair || '')),
        entry: num('entry') as number,
        stop: num('stop') as number,
        target: num('target'),
        account: num('account') ?? 10000,
        riskPct: num('riskPct') ?? 1,
        leverage: num('leverage') ?? 30,
      });
      return json(result);
    } catch (e) {
      return fail(e);
    }
  }],

  // Saving re-runs the analysis on the server, so the log only ever holds real readings.
  'POST /api/signals': [async ({ body }) => {
    try {
      const b = (body || {}) as Record<string, string | number | undefined>;
      const { setup, minRR } = await runAnalysis(String(b.pair || ''), b.tf as string | undefined, b.minRR);
      const id = signalId(setup, minRR);
      const record: SignalRecord = { ...setup, minRR, createdAt: Date.now() };
      const [created] = await db.tx.add(TABLE, [{ id, ...record }]);
      return json({ id, duplicate: created === null, signal: record }, created === null ? 200 : 201);
    } catch (e) {
      return fail(e);
    }
  }],

  // List the latest saved readings; trades are re-checked against live bars.
  'GET /api/signals': [async () => {
    try {
      const page = await db.list<SignalRecord>(TABLE, { limit: 50 });
      const items = [...page.items].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
      const needed = new Map<string, Promise<Bar[] | null>>();
      for (const s of items) {
        if (s.decision !== 'trade') continue;
        const key = `${s.pair}:${s.timeframe}`;
        if (!needed.has(key)) needed.set(key, fetchBars(s.pair, s.timeframe).catch(() => null));
      }
      const out = await Promise.all(items.map(async (s) => {
        if (s.decision !== 'trade') return { ...s, live: null };
        const bars = await needed.get(`${s.pair}:${s.timeframe}`);
        return { ...s, live: bars && bars.length ? track(s, bars) : null };
      }));
      return json({ signals: out, checkedAt: Date.now() });
    } catch (e) {
      return fail(e);
    }
  }],

  'DELETE /api/signals/:id': [async ({ params }) => {
    try {
      const [deleted] = await db.delete(TABLE, [params.id]);
      return deleted ? json({ deleted: true }) : error('That signal was not found', 404);
    } catch (e) {
      return fail(e);
    }
  }],
});
