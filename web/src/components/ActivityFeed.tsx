import { BrainCircuit, Crown, Radar, ShieldCheck, Target, Bot, Play, Loader2 } from 'lucide-react';
import type { FeedEvent, ScannerDoc } from '../lib/types';
import { timeAgo } from '../lib/format';

type Props = {
  events: FeedEvent[];
  scanner: ScannerDoc | null;
  scanning: boolean;
  scanNote: string | null;
  onScan: () => void;
  watchlist: string[];
};

const ICON = { scanner: Radar, analyst: BrainCircuit, risk: ShieldCheck, head: Crown, tracker: Target, desk: Bot };
const COLOR = {
  scanner: 'text-sky-300 bg-sky-500/10', analyst: 'text-violet-300 bg-violet-500/10', risk: 'text-amber-300 bg-amber-500/10',
  head: 'text-emerald-300 bg-emerald-500/10', tracker: 'text-slate-300 bg-slate-500/15', desk: 'text-sky-300 bg-sky-500/10',
};
const TONE = { good: 'border-l-emerald-400/60', bad: 'border-l-rose-400/60', warn: 'border-l-amber-400/60', info: 'border-l-white/10' };

export default function ActivityFeed({ events, scanner, scanning, scanNote, onScan, watchlist }: Props) {
  return (
    <section aria-label="Agent activity">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-white">What the agents did</h3>
          <p className="text-xs text-slate-500">
            The scanner reads {watchlist.map((p) => `${p.slice(0, 3)}/${p.slice(3)}`).join(', ')} on 15m and 1h every 15 minutes,
            logs new setups and sends the newest to the agent desk; the tracker closes finished trades.
          </p>
        </div>
        <button type="button" onClick={onScan} disabled={scanning}
          className="inline-flex items-center gap-1.5 rounded-lg border border-sky-400/30 bg-sky-500/10 px-3 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-500/20 disabled:opacity-50">
          {scanning ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Play size={14} aria-hidden />}
          {scanning ? 'Scanning...' : 'Run scanner now'}
        </button>
      </div>
      {scanner && (
        <p className="mt-2 text-xs text-slate-400">
          Last scan {timeAgo(scanner.lastRun)} ({scanner.trigger}): {scanner.scanned} charts, {scanner.found} new setup(s), {scanner.reviewed} reviewed,
          {' '}{scanner.closed} closed{scanner.note ? ` - ${scanner.note}` : ''}
        </p>
      )}
      {scanNote && <p role="status" className="mt-1 text-xs text-sky-300">{scanNote}</p>}
      {!events.length ? (
        <p className="mt-4 rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-slate-500">No agent activity yet.</p>
      ) : (
        <ol data-testid="activity-feed" className="mt-3 space-y-1.5">
          {events.map((e, i) => {
            const Icon = ICON[e.agent] || Bot;
            return (
              <li key={`${e.at}-${i}`} className={`flex items-start gap-3 rounded-lg border-l-2 bg-white/[0.02] px-3 py-2 ${TONE[e.tone || 'info']}`}>
                <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md ${COLOR[e.agent] || COLOR.desk}`}><Icon size={13} aria-hidden /></span>
                <span className="flex-1 text-[13px] leading-snug text-slate-300">{e.text}</span>
                <span className="whitespace-nowrap text-[11px] text-slate-500">{timeAgo(e.at)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
