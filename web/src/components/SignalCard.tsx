import { Save, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import type { Setup } from '../lib/types';
import { pairLabel, price, signedPips, timeAgo } from '../lib/format';

type Props = {
  setup: Setup;
  analyzedAt: number;
  minRR: number;
  onSave: () => void;
  saving: boolean;
  saveNote: string | null;
};

function Row({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-white/5 py-2 last:border-0">
      <span className="text-sm text-slate-400">{label}</span>
      <span className="text-right">
        <span className={`font-mono text-base font-semibold ${tone || 'text-slate-100'}`}>{value}</span>
        {sub && <span className="ml-2 font-mono text-xs text-slate-500">{sub}</span>}
      </span>
    </div>
  );
}

export default function SignalCard({ setup, analyzedAt, minRR, onSave, saving, saveNote }: Props) {
  const s = setup;
  const p = s.pair;
  const trade = s.decision === 'trade';
  const buy = s.side === 'buy';
  const heading = trade ? (buy ? 'BUY' : 'SELL') : 'NO TRADE';
  const badge = trade
    ? buy ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40' : 'bg-rose-500/15 text-rose-300 ring-rose-500/40'
    : 'bg-slate-500/15 text-slate-300 ring-slate-500/40';
  const Icon = trade ? (buy ? TrendingUp : TrendingDown) : Minus;
  const hasLevels = s.entry != null && s.stop != null && s.tp1 != null;

  return (
    <section aria-label="Signal" className="flex flex-col rounded-2xl border border-white/10 bg-[#0f1520] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-slate-500">{pairLabel(p)} · {s.timeframe}</p>
          <h2 data-testid="decision" className={`mt-1 inline-flex items-center gap-2 rounded-lg px-3 py-1 text-2xl font-bold ring-1 ${badge}`}>
            <Icon size={22} aria-hidden />
            {heading}
          </h2>
        </div>
        <div className="text-right text-xs text-slate-500">
          <div>Price <span className="font-mono text-sm text-slate-200">{price(p, s.price)}</span></div>
          <div className="mt-1">Analyzed {timeAgo(analyzedAt)}</div>
        </div>
      </div>

      {trade && hasLevels && (
        <div className="mt-4">
          <Row label={`Entry (${s.entryType})`} value={price(p, s.entry)} tone="text-blue-300" />
          <Row label="Stop loss" value={price(p, s.stop)} sub={signedPips(-(s.stopPips ?? 0), p)} tone="text-rose-300" />
          <Row label="Take profit 1" value={price(p, s.tp1)} sub={`${signedPips(s.tp1Pips, p)} · ${s.rrTp1}R`} tone="text-emerald-300" />
          {s.tp2 != null && (
            <Row label="Take profit 2" value={price(p, s.tp2)} sub={`${signedPips(s.tp2Pips, p)} · ${s.rr}R`} tone="text-teal-300" />
          )}
          <div className="mt-3 flex items-center justify-between rounded-lg bg-white/5 px-3 py-2">
            <span className="text-sm text-slate-400">Reward : risk</span>
            <span data-testid="reward-risk" className="font-mono text-lg font-bold text-slate-100">1 : {s.rr}</span>
          </div>
          {s.entryType === 'limit' && (
            <p className="mt-2 text-xs text-amber-300/90">Limit entry: wait for price to come back to {price(p, s.entry)}.</p>
          )}
        </div>
      )}

      {!trade && s.rejected && hasLevels && (
        <p className="mt-4 rounded-lg bg-white/5 px-3 py-2 text-xs text-slate-400">
          Levels it would have used: entry {price(p, s.entry)}, stop {price(p, s.stop)}, TP1 {price(p, s.tp1)}
          {s.tp2 != null ? `, TP2 ${price(p, s.tp2)}` : ''} - reward:risk {s.rr} is under your {minRR} minimum.
        </p>
      )}

      <div className="mt-4">
        <h3 className="text-sm font-semibold text-slate-300">Why</h3>
        <ol data-testid="reasons" className="mt-2 space-y-1.5 text-sm text-slate-400">
          {s.reasons.map((r, i) => (
            <li key={i} className="flex gap-2">
              <span className="font-mono text-xs text-slate-600">{String(i + 1).padStart(2, '0')}</span>
              <span>{r}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="mt-auto pt-4">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-white/10 disabled:opacity-50"
        >
          <Save size={16} aria-hidden />
          {saving ? 'Saving...' : 'Save to signal log'}
        </button>
        {saveNote && <p role="status" className="mt-2 text-center text-xs text-slate-400">{saveNote}</p>}
      </div>
    </section>
  );
}
