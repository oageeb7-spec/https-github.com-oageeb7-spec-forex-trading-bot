import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@appdeploy/client';
import { Activity, Clock as ClockIcon, Play } from 'lucide-react';
import Chart from './components/Chart';
import SignalCard from './components/SignalCard';
import Sizer from './components/Sizer';
import SignalLog from './components/SignalLog';
import type { Analysis, Clock, Level, Signal } from './lib/types';
import { COLORS, decimals, errorText, pairLabel } from './lib/format';

const FALLBACK_PAIRS = ['EURUSD', 'XAUUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD', 'EURGBP', 'EURJPY', 'GBPJPY', 'XAGUSD'];
const TIMEFRAMES = [['15m', '15m'], ['1h', '1H'], ['4h', '4H'], ['1d', '1D']] as const;
const MIN_RR = [1.5, 2, 2.5, 3];
const REFRESH_MS = 60_000;

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function keep(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: preferences just are not remembered */
  }
}

function levelsFor(a: Analysis | null): Level[] {
  const s = a?.setup;
  if (!s || s.entry == null || s.stop == null || s.tp1 == null) return [];
  const f = (x: number) => x.toFixed(decimals(s.pair));
  const out: Level[] = [
    { price: s.entry, color: COLORS.entry, title: `Entry ${f(s.entry)}` },
    { price: s.stop, color: COLORS.down, title: `SL ${f(s.stop)}` },
    { price: s.tp1, color: COLORS.up, title: `TP1 ${f(s.tp1)}` },
  ];
  if (s.tp2 != null) out.push({ price: s.tp2, color: COLORS.tp2, title: `TP2 ${f(s.tp2)}` });
  if (s.zone) {
    out.push({ price: s.zone.high, color: COLORS.zone, title: 'Zone high' });
    out.push({ price: s.zone.low, color: COLORS.zone, title: 'Zone low' });
  }
  return out;
}

function ClockPill({ clock }: { clock: Clock | null }) {
  if (!clock) return null;
  const text = clock.open
    ? clock.sessions.length ? `${clock.sessions.join(' + ')}${clock.overlap ? ' overlap' : ''}` : 'Between sessions'
    : 'FX market closed';
  return (
    <div data-testid="market-clock" className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300">
      <span className={`h-2 w-2 rounded-full ${clock.open ? 'bg-emerald-400' : 'bg-slate-500'}`} aria-hidden />
      <span>{clock.open ? 'FX open' : 'FX closed'} · {text}</span>
      <span className="hidden items-center gap-1 text-slate-500 sm:inline-flex"><ClockIcon size={12} aria-hidden /> NY {clock.newYork}</span>
    </div>
  );
}

export default function TradingApp() {
  const [pairs, setPairs] = useState<string[]>(FALLBACK_PAIRS);
  const [clock, setClock] = useState<Clock | null>(null);
  const [pair, setPair] = useState<string>(() => load('osai.pair', 'EURUSD'));
  const [tf, setTf] = useState<string>(() => load('osai.tf', '15m'));
  const [minRR, setMinRR] = useState<number>(() => load('osai.minRR', 2));
  const [auto, setAuto] = useState<boolean>(() => load('osai.auto', true));
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  useEffect(() => keep('osai.pair', pair), [pair]);
  useEffect(() => keep('osai.tf', tf), [tf]);
  useEffect(() => keep('osai.minRR', minRR), [minRR]);
  useEffect(() => keep('osai.auto', auto), [auto]);

  useEffect(() => {
    api.get('/api/meta').then(({ data }) => {
      if (Array.isArray(data?.pairs) && data.pairs.length) setPairs(data.pairs);
      if (data?.clock) setClock(data.clock);
    }).catch(() => { /* the fallback pair list still works */ });
  }, []);

  const analyze = useCallback(async () => {
    setAnalyzing(true);
    setError(null);
    setSaveNote(null);
    try {
      const { data } = await api.get(`/api/analyze?pair=${pair}&tf=${tf}&minRR=${minRR}`);
      setAnalysis(data as Analysis);
      if (data?.clock) setClock(data.clock);
    } catch (e) {
      setAnalysis(null);
      setError(`Could not analyze ${pairLabel(pair)}: ${errorText(e, 'the price feed did not answer. Try again in a minute.')}`);
    } finally {
      setAnalyzing(false);
    }
  }, [pair, tf, minRR]);

  const loadSignals = useCallback(async () => {
    setLogLoading(true);
    setLogError(null);
    try {
      const { data } = await api.get('/api/signals');
      setSignals((data?.signals || []) as Signal[]);
      setCheckedAt(data?.checkedAt ?? Date.now());
    } catch (e) {
      setLogError(`Could not load the signal log: ${errorText(e, 'please refresh.')}`);
    } finally {
      setLogLoading(false);
    }
  }, []);

  useEffect(() => { void analyze(); }, [analyze]);
  useEffect(() => { void loadSignals(); }, [loadSignals]);
  useEffect(() => {
    if (!auto) return;
    const id = window.setInterval(() => { void analyze(); void loadSignals(); }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [auto, analyze, loadSignals]);

  async function save() {
    setSaving(true);
    setSaveNote(null);
    try {
      const { data } = await api.post('/api/signals', { pair, tf, minRR });
      setSaveNote(data?.duplicate ? 'This reading is already in the log.' : 'Saved to the signal log.');
      await loadSignals();
    } catch (e) {
      setSaveNote(`Could not save: ${errorText(e, 'please try again.')}`);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    try {
      await api.delete(`/api/signals/${encodeURIComponent(id)}`);
      setSignals((list) => list.filter((s) => s.id !== id));
    } catch (e) {
      setLogError(`Could not delete: ${errorText(e, 'please try again.')}`);
    }
  }

  const levels = useMemo(() => levelsFor(analysis), [analysis]);
  const shownSetup = analysis && analysis.setup.pair === pair ? analysis.setup : null;

  return (
    <div className="min-h-screen bg-[#0b0f17] text-slate-200">
      <header className="border-b border-white/10 bg-[#0d121c]">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <Activity className="text-blue-400" size={22} aria-hidden />
            <h1 className="text-lg font-bold tracking-tight text-white">OS AI Trading</h1>
            <span className="hidden text-xs text-slate-500 sm:inline">structure · liquidity · setups</span>
          </div>
          <ClockPill clock={clock} />
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-4 px-4 py-4">
        <section aria-label="Controls" className="flex flex-wrap items-end gap-3 rounded-xl border border-white/10 bg-[#111725] p-3">
          <label className="text-xs text-slate-400">
            Market
            <select aria-label="Market" value={pair} onChange={(e) => setPair(e.target.value)}
              className="mt-1 block rounded-lg border border-white/10 bg-[#0b0f17] px-3 py-2 text-sm font-semibold text-slate-100">
              {pairs.map((p) => <option key={p} value={p}>{pairLabel(p)}</option>)}
            </select>
          </label>
          <div className="text-xs text-slate-400">
            Timeframe
            <div role="group" aria-label="Timeframe" className="mt-1 flex overflow-hidden rounded-lg border border-white/10">
              {TIMEFRAMES.map(([v, label]) => (
                <button key={v} type="button" aria-pressed={tf === v} onClick={() => setTf(v)}
                  className={`px-3 py-2 text-sm font-semibold ${tf === v ? 'bg-blue-600 text-white' : 'bg-[#0b0f17] text-slate-300 hover:bg-white/10'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <label className="text-xs text-slate-400">
            Min reward:risk
            <select aria-label="Minimum reward to risk" value={minRR} onChange={(e) => setMinRR(Number(e.target.value))}
              className="mt-1 block rounded-lg border border-white/10 bg-[#0b0f17] px-3 py-2 text-sm text-slate-100">
              {MIN_RR.map((v) => <option key={v} value={v}>1 : {v}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => void analyze()} disabled={analyzing}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60">
            <Play size={16} aria-hidden /> {analyzing ? 'Analyzing...' : 'Analyze'}
          </button>
          <label className="ml-auto flex items-center gap-2 text-xs text-slate-400">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="h-4 w-4 accent-blue-600" />
            Live refresh every 60s
          </label>
        </section>

        {error && <p role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</p>}

        <div className="grid gap-4 lg:grid-cols-3">
          <section aria-label="Chart" className="rounded-xl border border-white/10 bg-[#111725] p-3 lg:col-span-2">
            <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
              <span className="font-semibold text-slate-300">{pairLabel(pair)} · {tf}</span>
              <span>MA20 · levels from the current reading</span>
            </div>
            {analysis && analysis.setup.pair === pair ? (
              <Chart bars={analysis.bars} levels={levels} priceDecimals={decimals(pair)} label={`${pairLabel(pair)} ${tf} candlestick chart`} />
            ) : (
              <div className="flex h-[360px] items-center justify-center rounded-lg bg-[#0f1420] text-sm text-slate-500 sm:h-[440px]">
                {analyzing ? 'Loading live prices...' : error ? 'No chart - the last analysis failed.' : 'Press Analyze to load the chart.'}
              </div>
            )}
          </section>
          {shownSetup && analysis ? (
            <SignalCard setup={shownSetup} analyzedAt={analysis.analyzedAt} minRR={minRR}
              onSave={() => void save()} saving={saving} saveNote={saveNote} />
          ) : (
            <section className="flex items-center justify-center rounded-xl border border-white/10 bg-[#111725] p-6 text-sm text-slate-500">
              {analyzing ? 'Reading the market...' : 'No reading yet.'}
            </section>
          )}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Sizer pair={pair} setup={shownSetup} />
          <SignalLog signals={signals} loading={logLoading} error={logError} checkedAt={checkedAt}
            onRefresh={() => void loadSignals()} onDelete={remove} />
        </div>
      </main>

      <footer className="mx-auto max-w-7xl px-4 pb-8 text-xs leading-relaxed text-slate-500">
        Analysis tool, not financial advice. Prices are free, delayed Yahoo data; gold and silver use COMEX
        futures, a few dollars off spot. The setup rules are not backtested, so no win rate is claimed, and No Trade
        is a normal answer. This site never places orders - trading carries risk and leverage magnifies losses.
      </footer>
    </div>
  );
}
