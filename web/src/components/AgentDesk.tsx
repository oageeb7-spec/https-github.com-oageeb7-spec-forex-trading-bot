import { Bot, BrainCircuit, Crown, ShieldCheck, ShieldAlert, Wrench, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import type { AgentReport, DeskReview } from '../lib/types';
import { pairLabel, timeAgo } from '../lib/format';

type Props = {
  review: DeskReview | null;
  running: boolean;
  error: string | null;
  onRun: () => void;
  budget: { used: number; cap: number } | null;
  pair: string;
  tf: string;
};

const LOOK: Record<AgentReport['agent'], { icon: typeof Bot; ring: string; tint: string; role: string }> = {
  analyst: { icon: BrainCircuit, ring: 'ring-violet-400/30', tint: 'text-violet-300 bg-violet-500/10', role: 'Reads other timeframes and price action' },
  risk: { icon: ShieldCheck, ring: 'ring-amber-400/30', tint: 'text-amber-300 bg-amber-500/10', role: 'Sizes it, checks the stop and the session' },
  head: { icon: Crown, ring: 'ring-emerald-400/30', tint: 'text-emerald-300 bg-emerald-500/10', role: 'Weighs both reports, decides' },
};

function verdictTone(a: AgentReport): string {
  const v = a.verdict.toLowerCase();
  if (a.status === 'failed') return 'bg-rose-500/15 text-rose-300';
  if (a.status === 'skipped') return 'bg-slate-500/15 text-slate-400';
  if (v.startsWith('veto') || v === 'skip' || v.includes('disagrees')) return 'bg-rose-500/15 text-rose-300';
  if (v.startsWith('caution') || v.startsWith('neutral')) return 'bg-amber-500/15 text-amber-300';
  return 'bg-emerald-500/15 text-emerald-300';
}

function AgentCard({ a }: { a: AgentReport }) {
  const look = LOOK[a.agent];
  const Icon = a.agent === 'risk' && a.verdict === 'veto' ? ShieldAlert : look.icon;
  return (
    <article data-testid={`agent-${a.agent}`} className={`flex flex-col rounded-xl bg-[#0c111c] p-4 ring-1 ${look.ring}`}>
      <header className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className={`grid h-9 w-9 place-items-center rounded-lg ${look.tint}`}><Icon size={18} aria-hidden /></span>
          <div>
            <h3 className="text-sm font-semibold text-white">{a.title}</h3>
            <p className="text-[11px] text-slate-500">{look.role}</p>
          </div>
        </div>
        <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${verdictTone(a)}`}>{a.verdict}</span>
      </header>
      {a.confidence != null && (
        <div className="mt-3">
          <div className="flex justify-between text-[11px] text-slate-500"><span>Confidence</span><span className="font-mono text-slate-300">{a.confidence}%</span></div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/5">
            <div className="h-full rounded-full bg-gradient-to-r from-sky-500 to-emerald-400" style={{ width: `${a.confidence}%` }} />
          </div>
        </div>
      )}
      <ul className="mt-3 space-y-1.5 text-[13px] leading-snug text-slate-300">
        {a.points.map((p, i) => <li key={i} className="flex gap-2"><CheckCircle2 size={14} className="mt-0.5 shrink-0 text-slate-500" aria-hidden />{p}</li>)}
        {a.concerns.map((c, i) => <li key={`c${i}`} className="flex gap-2 text-amber-200/90"><XCircle size={14} className="mt-0.5 shrink-0 text-amber-400/70" aria-hidden />{c}</li>)}
      </ul>
      <footer className="mt-auto pt-3 text-[11px] text-slate-500">
        {a.tools.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            <Wrench size={12} aria-hidden /> Tools used:
            {a.tools.map((t, i) => <code key={i} title={t.args} className="rounded bg-white/5 px-1.5 py-0.5 text-slate-300">{t.name}</code>)}
          </div>
        ) : a.status === 'done' ? <span>Worked from the other agents' reports</span> : <span>{a.status === 'skipped' ? 'Not needed for this reading' : 'Did not report'}</span>}
        {a.ms > 0 && <span className="mt-1 block">{(a.ms / 1000).toFixed(1)}s</span>}
      </footer>
    </article>
  );
}

export default function AgentDesk({ review, running, error, onRun, budget, pair, tf }: Props) {
  const take = review?.final === 'take';
  return (
    <section id="agents" aria-label="Agent desk" className="rounded-2xl border border-white/10 bg-gradient-to-b from-[#111827] to-[#0d131f] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><Bot size={20} className="text-sky-400" aria-hidden /> Agent desk</h2>
          <p className="mt-0.5 max-w-xl text-sm text-slate-400">
            Three AI agents review the engine's reading of {pairLabel(pair)} {tf} using live data tools. They never set prices,
            and a risk veto or an engine No Trade always ends in SKIP.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {budget && <span className="text-xs text-slate-500">{budget.used}/{budget.cap} reviews this hour</span>}
          <button type="button" onClick={onRun} disabled={running}
            className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-sky-500 to-indigo-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-900/40 hover:brightness-110 disabled:opacity-60">
            {running ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Bot size={16} aria-hidden />}
            {running ? 'Agents working...' : 'Run agent desk'}
          </button>
        </div>
      </div>

      {error && <p role="alert" className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p>}

      {running && !review && (
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {(['analyst', 'risk', 'head'] as const).map((k) => (
            <div key={k} className="h-40 animate-pulse rounded-xl bg-white/[0.03] ring-1 ring-white/5" />
          ))}
        </div>
      )}

      {review && (
        <>
          <div data-testid="desk-final"
            className={`mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3 ring-1 ${take ? 'bg-emerald-500/10 ring-emerald-400/30' : 'bg-slate-500/10 ring-white/10'}`}>
            <div className="flex items-center gap-3">
              <span className={`rounded-lg px-3 py-1 text-xl font-black tracking-wide ${take ? 'bg-emerald-500 text-emerald-950' : 'bg-slate-600 text-white'}`}>
                {take ? 'TAKE' : 'SKIP'}
              </span>
              <p className="text-sm text-slate-200">{review.summary}</p>
            </div>
            <span className="text-xs text-slate-400">
              {take ? `Desk confidence ${review.confidence}% · ` : ''}reviewed {timeAgo(review.createdAt)}
            </span>
          </div>
          {review.guardrails.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-amber-200/90">
              {review.guardrails.map((g, i) => <li key={i} className="flex items-center gap-1.5"><ShieldAlert size={13} aria-hidden /> Guardrail: {g}</li>)}
            </ul>
          )}
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <AgentCard a={review.analyst} />
            <AgentCard a={review.risk} />
            <AgentCard a={review.head} />
          </div>
        </>
      )}

      {!review && !running && !error && (
        <p className="mt-4 rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-slate-500">
          No review for this reading yet. Run the desk, or let the scanner do it - it checks the watchlist every 15 minutes.
        </p>
      )}
    </section>
  );
}
