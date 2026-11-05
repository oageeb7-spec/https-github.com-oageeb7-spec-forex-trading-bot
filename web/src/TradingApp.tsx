import { useCallback, useEffect, useState } from 'react';
import { api } from '@appdeploy/client';
import { Activity, Bot, Clock as ClockIcon, LineChart, Play, Radar, Trophy } from 'lucide-react';
import LevelChart from './components/LevelChart';
import SignalCard from './components/SignalCard';
import Sizer from './components/Sizer';
import SignalLog from './components/SignalLog';
import AgentDesk from './components/AgentDesk';
import ActivityFeed from './components/ActivityFeed';
import PerformancePanel from './components/PerformancePanel';
import TelegramPanel from './components/TelegramPanel';
import type { Analysis, Clock, DeskReview, FeedEvent, Meta, Performance, Signal } from './lib/types';
import { errorText, pairLabel, price, timeAgo } from './lib/format';

const FALLBACK_PAIRS = ['EURUSD', 'XAUUSD', 'BTCUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD', 'EURGBP', 'EURJPY', 'GBPJPY', 'XAGUSD'];
const TIMEFRAMES = [['15m', '15m'], ['1h', '1H'], ['4h', '4H'], ['1d', '1D']] as const;
const MIN_RR = [1.5, 2, 2.5, 3];
const REFRESH_MS = 60_000;
const TABS = [['activity', 'Agent activity'], ['log', 'Signal log'], ['performance', 'Performance'], ['sizer', 'Position sizer'], ['telegram', 'Telegram']] as const;
type Tab = typeof TABS[number][0];

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

/** Minutes until the next quarter hour - the scanner's schedule. */
function nextScanIn(): number {
  const m = new Date().getUTCMinutes();
  return 15 - (m % 15);
}

function ClockPill({ clock }: { clock: Clock | null }) {
  if (!clock) return null;
  const text = clock.open
    ? clock.sessions.length ? `${clock.sessions.join(' + ')}${clock.overlap ? ' overlap' : ''}` : 'Between sessions'
    : 'Weekend - market closed';
  return (
    <div data-testid="market-clock" className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300">
      <span className={`h-2 w-2 rounded-full ${clock.open ? 'animate-pulse bg-emerald-400' : 'bg-slate-500'}`} aria-hidden />
      <span>{clock.open ? 'FX open' : 'FX closed'} · {text}</span>
      <span className="hidden items-center gap-1 text-slate-500 md:inline-flex"><ClockIcon size={12} aria-hidden /> NY {clock.newYork}</span>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, sub, accent }: { icon: typeof Activity; label: string; value: string; sub: string; accent: string }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0f1520] p-4">
      <div className={`absolute -right-6 -top-6 h-20 w-20 rounded-full opacity-20 blur-2xl ${accent}`} aria-hidden />
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500"><Icon size={13} aria-hidden /> {label}</p>
      <p className="mt-1.5 truncate text-xl font-bold text-white">{value}</p>
      <p className="mt-0.5 text-xs leading-snug text-slate-400">{sub}</p>
    </div>
  );
}

export default function TradingApp() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [pair, setPair] = useState<string>(() => load('osai.pair', 'EURUSD'));
  const [tf, setTf] = useState<string>(() => load('osai.tf', '15m'));
  const [minRR, setMinRR] = useState<number>(() => load('osai.minRR', 2));
  const [auto, setAuto] = useState<boolean>(() => load('osai.auto', true));
  const [tab, setTab] = useState<Tab>(() => load('osai.tab', 'activity'));
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [review, setReview] = useState<DeskReview | null>(null);
  const [deskRunning, setDeskRunning] = useState(false);
  const [deskError, setDeskError] = useState<string | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [perf, setPerf] = useState<Performance | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);

  useEffect(() => keep('osai.pair', pair), [pair]);
  useEffect(() => keep('osai.tf', tf), [tf]);
  useEffect(() => keep('osai.minRR', minRR), [minRR]);
  useEffect(() => keep('osai.auto', auto), [auto]);
  useEffect(() => keep('osai.tab', tab), [tab]);

  const loadMeta = useCallback(async () => {
    try {
      const { data } = await api.get('/api/meta');
      setMeta(data as Meta);
    } catch { /* the page still works with fallbacks */ }
  }, []);
  const loadActivity = useCallback(async () => {
    try {
      const { data } = await api.get('/api/activity');
      setEvents((data?.events || []) as FeedEvent[]);
    } catch { /* feed is optional */ }
  }, []);
  const loadPerf = useCallback(async () => {
    try {
      const { data } = await api.get('/api/performance');
      setPerf(data as Performance);
    } catch { /* stats are optional */ }
  }, []);
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

  const analyze = useCallback(async () => {
    setAnalyzing(true);
    setError(null);
    setSaveNote(null);
    try {
      const { data } = await api.get(`/api/analyze?pair=${pair}&tf=${tf}&minRR=${minRR}`);
      const a = data as Analysis;
      setAnalysis(a);
      setReview((cur) => a.review ?? (cur && cur.pair === a.setup.pair && cur.timeframe === a.setup.timeframe ? cur : null));
    } catch (e) {
      setAnalysis(null);
      setError(`Could not analyze ${pairLabel(pair)}: ${errorText(e, 'the price feed did not answer. Try again in a minute.')}`);
    } finally {
      setAnalyzing(false);
    }
  }, [pair, tf, minRR]);

  const refreshAll = useCallback(() => {
    void loadMeta();
    void loadActivity();
    void loadPerf();
    void loadSignals();
  }, [loadMeta, loadActivity, loadPerf, loadSignals]);

  useEffect(() => { setReview(null); setDeskError(null); }, [pair, tf, minRR]);
  useEffect(() => { void analyze(); }, [analyze]);
  useEffect(() => { refreshAll(); }, [refreshAll]);
  useEffect(() => {
    if (!auto) return;
    const id = window.setInterval(() => { void analyze(); refreshAll(); }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [auto, analyze, refreshAll]);

  async function runDesk() {
    setDeskRunning(true);
    setDeskError(null);
    try {
      const { data } = await api.post('/api/desk', { pair, tf, minRR });
      setReview(data.review as DeskReview);
      void loadActivity();
      void loadMeta();
    } catch (e) {
      setDeskError(`The agent desk could not finish: ${errorText(e, 'please try again in a minute.')}`);
    } finally {
      setDeskRunning(false);
    }
  }

  async function runScanner() {
    setScanning(true);
    setScanNote(null);
    try {
      const { data } = await api.post('/api/scanner/run', {});
      const s = data.scanner;
      setScanNote(data.fresh
        ? `Scanned ${s.scanned} charts: ${s.found} new setup(s) logged, ${s.closed} trade(s) closed.${s.note ? ` ${s.note}` : ''}`
        : `The scanner ran ${timeAgo(s.lastRun)} - showing that run. It can run again 2 minutes after the last scan.`);
      refreshAll();
    } catch (e) {
      setScanNote(`The scanner could not run: ${errorText(e, 'please try again.')}`);
    } finally {
      setScanning(false);
    }
  }

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

  const shownSetup = analysis && analysis.setup.pair === pair ? analysis.setup : null;
  const pairs = meta?.pairs?.length ? meta.pairs : FALLBACK_PAIRS;
  const clock = analysis?.clock ?? meta?.clock ?? null;
  const scanner = meta?.scanner ?? null;
  const decision = shownSetup ? (shownSetup.decision === 'trade' ? (shownSetup.side === 'buy' ? 'BUY' : 'SELL') : 'NO TRADE') : '-';

  return (
    <div className="min-h-screen bg-[#070a12] text-slate-200">
      <div className="pointer-events-none fixed inset-x-0 top-0 h-72 bg-[radial-gradient(ellipse_at_top,rgba(56,189,248,0.10),transparent_60%)]" aria-hidden />
      <header className="sticky top-0 z-20 border-b border-white/10 bg-[#070a12]/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-sky-400 to-indigo-600 shadow-lg shadow-indigo-900/50">
              <Activity className="text-white" size={20} aria-hidden />
            </span>
            <div className="leading-tight">
              <h1 className="text-lg font-bold tracking-tight text-white">OS AI Trading</h1>
              <p className="text-[11px] text-slate-500">AI agent desk · structure · liquidity</p>
            </div>
          </div>
          <nav className="hidden items-center gap-1 text-sm text-slate-400 md:flex" aria-label="Sections">
            <a href="#desk" className="rounded-lg px-3 py-1.5 hover:bg-white/5 hover:text-white">Desk</a>
            <a href="#agents" className="rounded-lg px-3 py-1.5 hover:bg-white/5 hover:text-white">Agents</a>
            <a href="#workspace" className="rounded-lg px-3 py-1.5 hover:bg-white/5 hover:text-white">Log &amp; stats</a>
          </nav>
          <ClockPill clock={clock} />
        </div>
      </header>

      <main className="relative mx-auto max-w-7xl space-y-5 px-4 py-5">
        <section aria-label="Overview" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi icon={LineChart} label={`${pairLabel(pair)} · ${tf}`} value={shownSetup ? price(pair, shownSetup.price) : '-'}
            sub={`Engine: ${decision}`} accent="bg-sky-400" />
          <Kpi icon={Radar} label="Scanner" value={scanner ? `${scanner.found} new` : 'waiting'}
            sub={scanner ? `${scanner.scanned} charts ${timeAgo(scanner.lastRun)} · next ~${nextScanIn()}m` : `every 15 min · next ~${nextScanIn()}m`} accent="bg-indigo-400" />
          <Kpi icon={Trophy} label="Forward test" value={perf?.winRate == null ? '-' : `${perf.winRate}% wins`}
            sub={!perf ? 'loading' : perf.closed ? `${perf.closed} closed · ${perf.avgR != null && perf.avgR > 0 ? '+' : ''}${perf.avgR}R avg` : 'no closed trades yet'} accent="bg-emerald-400" />
          <Kpi icon={Bot} label="Agent desk" value={review ? `${review.final.toUpperCase()}${review.final === 'take' ? ` ${review.confidence}%` : ''}` : '-'}
            sub={meta ? `${meta.agentBudget.used}/${meta.agentBudget.cap} reviews this hour` : 'three AI agents'} accent="bg-violet-400" />
        </section>

        <section id="desk" aria-label="Controls" className="flex flex-wrap items-end gap-3 rounded-2xl border border-white/10 bg-[#0f1520] p-3">
          <label className="text-xs text-slate-400">
            Market
            <select aria-label="Market" value={pair} onChange={(e) => setPair(e.target.value)}
              className="mt-1 block rounded-lg border border-white/10 bg-[#070a12] px-3 py-2 text-sm font-semibold text-slate-100">
              {pairs.map((p) => <option key={p} value={p}>{pairLabel(p)}</option>)}
            </select>
          </label>
          <div className="text-xs text-slate-400">
            Timeframe
            <div role="group" aria-label="Timeframe" className="mt-1 flex overflow-hidden rounded-lg border border-white/10">
              {TIMEFRAMES.map(([v, label]) => (
                <button key={v} type="button" aria-pressed={tf === v} onClick={() => setTf(v)}
                  className={`px-3 py-2 text-sm font-semibold ${tf === v ? 'bg-sky-500 text-white' : 'bg-[#070a12] text-slate-300 hover:bg-white/10'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <label className="text-xs text-slate-400">
            Min reward:risk
            <select aria-label="Minimum reward to risk" value={minRR} onChange={(e) => setMinRR(Number(e.target.value))}
              className="mt-1 block rounded-lg border border-white/10 bg-[#070a12] px-3 py-2 text-sm text-slate-100">
              {MIN_RR.map((v) => <option key={v} value={v}>1 : {v}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => void analyze()} disabled={analyzing}
            className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-200 disabled:opacity-60">
            <Play size={16} aria-hidden /> {analyzing ? 'Analyzing...' : 'Analyze'}
          </button>
          <label className="ml-auto flex items-center gap-2 text-xs text-slate-400">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="h-4 w-4 accent-sky-500" />
            Live refresh every 60s
          </label>
        </section>

        {error && <p role="alert" className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</p>}

        <div className="grid items-start gap-5 lg:grid-cols-3">
          <section aria-label="Levels" className="rounded-2xl border border-white/10 bg-[#0f1520] p-3 lg:col-span-2">
            <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
              <span className="font-semibold text-slate-300">{pairLabel(pair)} · {tf}</span>
              <span>Levels from the current reading · distance from now</span>
            </div>
            {shownSetup ? (
              <LevelChart setup={shownSetup} />
            ) : (
              <div className="flex h-[380px] items-center justify-center rounded-xl bg-[#0b1019] text-sm text-slate-500">
                {analyzing ? 'Loading live prices...' : error ? 'No levels - the last analysis failed.' : 'Press Analyze to read the market.'}
              </div>
            )}
          </section>
          {shownSetup && analysis ? (
            <SignalCard setup={shownSetup} analyzedAt={analysis.analyzedAt} minRR={minRR}
              onSave={() => void save()} saving={saving} saveNote={saveNote} />
          ) : (
            <section className="flex items-center justify-center rounded-2xl border border-white/10 bg-[#0f1520] p-6 text-sm text-slate-500">
              {analyzing ? 'Reading the market...' : 'No reading yet.'}
            </section>
          )}
        </div>

        <AgentDesk review={review} running={deskRunning} error={deskError} onRun={() => void runDesk()}
          budget={meta?.agentBudget ?? null} pair={pair} tf={tf} />

        <section id="workspace" aria-label="Workspace" className="rounded-2xl border border-white/10 bg-[#0f1520]">
          <div role="tablist" aria-label="Workspace" className="flex gap-1 overflow-x-auto border-b border-white/10 px-3 pt-3">
            {TABS.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                className={`whitespace-nowrap rounded-t-lg px-4 py-2 text-sm font-medium ${tab === id ? 'bg-white/[0.06] text-white shadow-[inset_0_-2px_0_#38bdf8]' : 'text-slate-400 hover:text-slate-200'}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="p-4" role="tabpanel">
            {tab === 'activity' && (
              <ActivityFeed events={events} scanner={scanner} scanning={scanning} scanNote={scanNote} onScan={() => void runScanner()}
                watchlist={meta?.watchlist ?? ['EURUSD', 'XAUUSD', 'BTCUSD', 'GBPUSD', 'USDJPY']} />
            )}
            {tab === 'log' && (
              <SignalLog signals={signals} loading={logLoading} error={logError} checkedAt={checkedAt}
                onRefresh={() => void loadSignals()} onDelete={remove} />
            )}
            {tab === 'performance' && <PerformancePanel perf={perf} />}
            {tab === 'sizer' && <Sizer pair={pair} setup={shownSetup} />}
            {tab === 'telegram' && <TelegramPanel />}
          </div>
        </section>
      </main>

      <footer className="mx-auto max-w-7xl px-4 pb-10 text-xs leading-relaxed text-slate-500">
        Analysis tool, not financial advice. Prices are free, delayed Yahoo data; gold and silver use COMEX futures, a few
        dollars off spot. The engine's rules and the AI agents are not backtested - the forward test above is the only track
        record, and No Trade is a normal answer. This site never places orders; trading carries risk and leverage magnifies losses.
      </footer>
    </div>
  );
}
