import { useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import type { Signal } from '../lib/types';
import { pairLabel, price, signedPips, timeAgo } from '../lib/format';

type Props = {
  signals: Signal[];
  loading: boolean;
  error: string | null;
  checkedAt: number | null;
  onRefresh: () => void;
  onDelete: (id: string) => Promise<void>;
};

const STATUS_TONE: Record<string, string> = {
  'target hit': 'bg-emerald-500/15 text-emerald-300',
  'TP1 hit': 'bg-teal-500/15 text-teal-300',
  open: 'bg-blue-500/15 text-blue-300',
  pending: 'bg-amber-500/15 text-amber-300',
  stopped: 'bg-rose-500/15 text-rose-300',
  'stopped after TP1': 'bg-orange-500/15 text-orange-300',
  missed: 'bg-slate-500/15 text-slate-300',
};

function status(s: Signal): { text: string; tone: string } {
  if (s.decision !== 'trade') return { text: 'no trade', tone: 'bg-slate-500/10 text-slate-400' };
  if (s.outcome) {
    const r = s.realizedR ?? 0;
    const tail = s.outcome === 'missed' ? '' : ` ${r > 0 ? '+' : ''}${r}R`;
    return { text: `closed: ${s.outcome}${tail}`, tone: STATUS_TONE[s.outcome] || 'bg-slate-500/15 text-slate-300' };
  }
  if (!s.live) return { text: 'no live data', tone: 'bg-slate-500/10 text-slate-400' };
  return { text: s.live.status, tone: STATUS_TONE[s.live.status] || 'bg-slate-500/15 text-slate-300' };
}

export default function SignalLog({ signals, loading, error, checkedAt, onRefresh, onDelete }: Props) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function remove(id: string) {
    setDeleting(id);
    try {
      await onDelete(id);
    } finally {
      setDeleting(null);
      setConfirming(null);
    }
  }

  return (
    <section aria-label="Signal log">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">Signal log</h3>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          {checkedAt && <span>checked {timeAgo(checkedAt)}</span>}
          <button type="button" onClick={onRefresh} disabled={loading} aria-label="Refresh signal log"
            className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-slate-300 hover:bg-white/10 disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden /> Refresh
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-slate-500">Readings saved by you or logged by the scanner, re-checked against live prices until they close.</p>
      {error && <p role="alert" className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
      {!error && !signals.length && !loading && (
        <p className="mt-4 text-sm text-slate-500">No saved signals yet. Analyze a pair and press "Save to signal log".</p>
      )}
      <ul className="mt-3 space-y-2">
        {signals.map((s) => {
          const st = status(s);
          const p = s.pair;
          return (
            <li key={s.id} data-testid="signal-row" className="rounded-lg border border-white/5 bg-white/[0.03] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-100">{pairLabel(p)}</span>
                  <span className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-slate-400">{s.timeframe}</span>
                  <span className={`text-xs font-bold ${s.side === 'buy' ? 'text-emerald-300' : s.side === 'sell' ? 'text-rose-300' : 'text-slate-400'}`}>
                    {s.decision === 'trade' ? s.side?.toUpperCase() : 'NO TRADE'}
                  </span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${s.source === 'scanner' ? 'bg-sky-500/10 text-sky-300' : 'bg-white/5 text-slate-400'}`}>
                    {s.source === 'scanner' ? 'Scanner' : 'You'}
                  </span>
                  {s.desk && (
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${s.desk.final === 'take' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-slate-500/15 text-slate-300'}`}>
                      Desk {s.desk.final}{s.desk.final === 'take' ? ` ${s.desk.confidence}%` : ''}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${st.tone}`}>{st.text}</span>
                  <span className="text-xs text-slate-500">{timeAgo(s.createdAt)}</span>
                  {confirming === s.id ? (
                    <span className="flex items-center gap-1">
                      <button type="button" onClick={() => remove(s.id)} disabled={deleting === s.id}
                        className="rounded-md bg-rose-600 px-2 py-1 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50">
                        {deleting === s.id ? 'Deleting...' : 'Confirm delete'}
                      </button>
                      <button type="button" onClick={() => setConfirming(null)} className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-white/10">Cancel</button>
                    </span>
                  ) : (
                    <button type="button" aria-label={`Delete ${pairLabel(p)} ${s.timeframe} signal`} onClick={() => setConfirming(s.id)}
                      className="rounded-md p-1 text-slate-500 hover:bg-white/10 hover:text-rose-300">
                      <Trash2 size={15} aria-hidden />
                    </button>
                  )}
                </div>
              </div>
              {s.decision === 'trade' ? (
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-slate-400 sm:grid-cols-4">
                  <span>Entry <span className="text-blue-300">{price(p, s.entry)}</span></span>
                  <span>SL <span className="text-rose-300">{price(p, s.stop)}</span></span>
                  <span>TP1 <span className="text-emerald-300">{price(p, s.tp1)}</span></span>
                  <span>TP2 <span className="text-teal-300">{price(p, s.tp2)}</span></span>
                  {s.live && (
                    <>
                      <span>Now <span className="text-slate-200">{price(p, s.live.price)}</span></span>
                      <span>P/L {s.live.openPips != null ? signedPips(s.live.openPips) : 'not filled'}</span>
                      <span>to TP1 {signedPips(s.live.toTp1Pips)}</span>
                      <span>to SL {signedPips(s.live.toStopPips)}</span>
                    </>
                  )}
                </div>
              ) : (
                <p className="mt-1 text-xs text-slate-500">{s.reasons[s.reasons.length - 1]}</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
