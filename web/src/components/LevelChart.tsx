import type { Setup } from '../lib/types';
import { decimals, isCrypto } from '../lib/format';

// The level chart: only the reading's levels and where price is now - no candles, no indicators.
// Bands: risk (entry to stop) in red, reward (entry to the final target) in green, the entry zone
// in grey. Each label gives the price and how far it is from the current price.

type Props = { setup: Setup };

type Level = { key: string; price: number; label: string; color: string; strong?: boolean };

const H = 380;
const PAD = 26;
const LABEL_GAP = 24;

function distance(pair: string, from: number, to: number): string {
  const d = to - from;
  const sign = d > 0 ? '+' : d < 0 ? '-' : '';
  if (isCrypto(pair)) return `${sign}$${Math.abs(d).toFixed(2)}`;
  const pip = pair.startsWith('XAU') ? 0.1 : pair.startsWith('XAG') ? 0.01 : pair.endsWith('JPY') ? 0.01 : 0.0001;
  return `${sign}${(Math.abs(d) / pip).toFixed(1)} pips`;
}

export default function LevelChart({ setup: s }: Props) {
  const p = s.pair;
  const dec = decimals(p);
  const now = s.price;
  const hasLevels = s.entry != null && s.stop != null && s.tp1 != null && now != null;

  if (!hasLevels) {
    return (
      <div data-testid="level-chart" className="flex h-[380px] flex-col items-center justify-center gap-3 rounded-xl bg-[#0b1019] px-6 text-center">
        <p className="text-xs uppercase tracking-wider text-slate-500">Now</p>
        <p className="font-mono text-3xl font-bold text-white">{now == null ? '-' : now.toFixed(dec)}</p>
        <p className="max-w-md text-sm text-slate-400">No levels for this reading - {s.reasons[s.reasons.length - 1] || 'the engine found no setup.'}</p>
      </div>
    );
  }

  const entry = s.entry as number;
  const stop = s.stop as number;
  const tp1 = s.tp1 as number;
  const final = s.tp2 ?? tp1;
  const price = now as number;
  const levels: Level[] = [
    { key: 'tp2', price: final, label: s.tp2 != null ? 'TP2' : 'TP1', color: '#14b8a6', strong: true },
    ...(s.tp2 != null ? [{ key: 'tp1', price: tp1, label: 'TP1', color: '#34d399' }] : []),
    { key: 'entry', price: entry, label: `Entry (${s.entryType})`, color: '#60a5fa', strong: true },
    { key: 'stop', price: stop, label: 'Stop', color: '#f87171', strong: true },
  ];
  const all = [...levels.map((l) => l.price), price, ...(s.zone ? [s.zone.low, s.zone.high] : [])];
  let hi = Math.max(...all);
  let lo = Math.min(...all);
  const span = hi - lo || hi * 0.001 || 1;
  hi += span * 0.06;
  lo -= span * 0.06;
  const y = (v: number) => PAD + ((hi - v) / (hi - lo)) * (H - 2 * PAD);
  const pct = (v: number) => `${(y(v) / H) * 100}%`;
  const band = (a: number, b: number) => ({ top: pct(Math.max(a, b)), height: `${(Math.abs(y(a) - y(b)) / H) * 100}%` });

  // labels sorted by position, nudged apart so close levels stay readable
  const tags = [...levels, { key: 'now', price, label: 'Now', color: '#f8fafc', strong: true }]
    .map((l) => ({ ...l, y: y(l.price), ly: y(l.price) }))
    .sort((a, b) => a.y - b.y);
  tags.forEach((t, i) => {
    if (i && t.ly < tags[i - 1].ly + LABEL_GAP) t.ly = tags[i - 1].ly + LABEL_GAP;
  });
  const overflow = tags.length ? tags[tags.length - 1].ly - (H - 12) : 0;
  if (overflow > 0) tags.forEach((t) => { t.ly -= overflow; });

  const summary = `${p} ${s.timeframe}: price ${price.toFixed(dec)}, entry ${entry.toFixed(dec)}, stop ${stop.toFixed(dec)}, `
    + `TP1 ${tp1.toFixed(dec)}${s.tp2 != null ? `, TP2 ${final.toFixed(dec)}` : ''}`;

  return (
    <div>
    <div data-testid="level-chart" role="img" aria-label={summary}
      className="relative h-[380px] overflow-hidden rounded-xl bg-[#0b1019]">
      {/* reward and risk bands */}
      <div className="absolute inset-x-0 bg-emerald-500/10" style={band(entry, final)} aria-hidden />
      <div className="absolute inset-x-0 bg-rose-500/10" style={band(entry, stop)} aria-hidden />
      {s.zone && (
        <div className="absolute inset-x-0 border-y border-dashed border-slate-500/40 bg-slate-400/[0.06]" style={band(s.zone.low, s.zone.high)} aria-hidden />
      )}
      {/* level lines */}
      {tags.map((t) => (
        <div key={`line-${t.key}`} className="absolute left-0 right-0" style={{ top: t.y }} aria-hidden>
          <div className={t.key === 'now' ? 'border-t-2 border-white/80' : 'border-t border-dashed'} style={{ borderColor: t.key === 'now' ? undefined : t.color }} />
        </div>
      ))}
      {/* now marker */}
      <span className="absolute h-3 w-3 -translate-y-1/2 animate-pulse rounded-full bg-white shadow-[0_0_12px_rgba(255,255,255,0.7)]"
        style={{ top: y(price), right: '46%' }} aria-hidden />
      {/* labels: name and price on the left, distance from now on the right */}
      {tags.map((t) => (
        <div key={`tag-${t.key}`} className="absolute left-3 right-3 flex -translate-y-1/2 items-center justify-between gap-2 text-xs" style={{ top: t.ly }}>
          <span className="rounded-md px-2 py-0.5 font-semibold text-slate-950" style={{ background: t.color }}>
            {t.label} <span className="font-mono">{t.price.toFixed(dec)}</span>
          </span>
          {t.key !== 'now' && (
            <span className="rounded-md bg-black/50 px-2 py-0.5 font-mono text-slate-300">{distance(p, price, t.price)}</span>
          )}
        </div>
      ))}
    </div>
    <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
      <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-500/50 align-middle" />reward: entry to {s.tp2 != null ? 'TP2' : 'TP1'}</span>
      <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-rose-500/50 align-middle" />risk: entry to stop</span>
      {s.zone && (
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm border border-dashed border-slate-400 align-middle" />
          {s.zone.kind} {s.zone.low.toFixed(dec)}-{s.zone.high.toFixed(dec)}</span>
      )}
    </p>
    </div>
  );
}
