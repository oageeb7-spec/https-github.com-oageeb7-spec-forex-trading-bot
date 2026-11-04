import type { Performance } from '../lib/types';

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-white/[0.03] p-4 ring-1 ring-white/5">
      <p className="text-[11px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`mt-1 font-mono text-2xl font-bold ${tone || 'text-white'}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

export default function PerformancePanel({ perf }: { perf: Performance | null }) {
  if (!perf) return <p className="text-sm text-slate-500">Loading the forward test...</p>;
  const r = perf.avgR;
  return (
    <section aria-label="Performance" data-testid="performance">
      <h3 className="text-sm font-semibold text-white">Forward test</h3>
      <p className="text-xs text-slate-500">Every logged trade, tracked against live prices until it hits the final target or the stop. No backtest, no cherry-picking.</p>
      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Closed trades" value={String(perf.closed)} sub={`${perf.missed} missed (never filled)`} />
        <Stat label="Win rate" value={perf.winRate == null ? '-' : `${perf.winRate}%`} sub={`${perf.targetHit} reached the final target`}
          tone={perf.winRate == null ? 'text-slate-400' : perf.winRate >= 50 ? 'text-emerald-300' : 'text-amber-300'} />
        <Stat label="Average R" value={r == null ? '-' : `${r > 0 ? '+' : ''}${r}R`} sub={`total ${perf.rSum > 0 ? '+' : ''}${Math.round(perf.rSum * 100) / 100}R`}
          tone={r == null ? 'text-slate-400' : r > 0 ? 'text-emerald-300' : 'text-rose-300'} />
        <Stat label="Stopped out" value={String(perf.stopped + perf.stoppedAfterTp1)} sub={`${perf.stoppedAfterTp1} after reaching TP1`} tone="text-rose-300" />
      </div>
      <p className="mt-3 text-xs text-slate-500">
        {perf.closed === 0 ? 'No trades have closed yet - the record starts as the scanner logs setups and the tracker closes them. ' : ''}
        {perf.note} A small sample says little; judge it after dozens of trades.
      </p>
    </section>
  );
}
