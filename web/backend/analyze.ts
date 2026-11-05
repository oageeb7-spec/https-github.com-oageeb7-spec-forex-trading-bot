// Setup finder: a TypeScript port of .claude/skills/trader-forex/setup.py.
// Same rules, same thresholds - web/backend/parity.test.ts checks both give the
// same answer on the saved real EURUSD, gold and BTC bars.
//
// Reads swings, structure, the latest break of structure, liquidity sweeps and
// premium/discount; enters from the latest unfilled fair-value gap (else the order
// block before the break); stop beyond the zone and protecting swing plus 0.1 ATR;
// TP1/TP2 at the next resting liquidity. A trade needs a clear score lead and
// reward:risk >= minRR, otherwise No Trade with the reason.

import { Bar, decimals, fmt, isCrypto, isMetal, pipSize, roundTo } from './market';

const SWEEP_LOOKBACK = 30;
const ZONE_LOOKBACK = 60;

type Side = 'bull' | 'bear';

export type Setup = {
  pair: string;
  timeframe: string;
  decision: 'trade' | 'no_trade';
  side: 'buy' | 'sell' | null;
  reasons: string[];
  price: number | null;
  lastBarTime: number | null;
  score?: { bull: number; bear: number };
  entryType?: 'market' | 'limit';
  entry?: number;
  stop?: number;
  tp1?: number;
  tp2?: number | null;
  zone?: { kind: string; low: number; high: number };
  stopPips?: number;
  tp1Pips?: number;
  tp2Pips?: number | null;
  rrTp1?: number;
  rr?: number;
  atrPips?: number;
  rejected?: boolean;
};

export function atr(bars: Bar[], n = 14): number {
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const p = bars[i - 1];
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  const last = trs.slice(-n);
  const use = last.length ? last : [bars[bars.length - 1].high - bars[bars.length - 1].low];
  return use.reduce((s, x) => s + x, 0) / use.length;
}

/** Swing highs/lows: k bars each side. The last k bars are never pivots yet. */
export function pivots(bars: Bar[], k: number): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = k; i < bars.length - k; i++) {
    const h = bars[i].high;
    const l = bars[i].low;
    const left = bars.slice(i - k, i);
    const right = bars.slice(i + 1, i + k + 1);
    if (left.every((b) => h > b.high) && right.every((b) => h >= b.high)) highs.push(i);
    if (left.every((b) => l < b.low) && right.every((b) => l <= b.low)) lows.push(i);
  }
  return { highs, lows };
}

function structure(bars: Bar[], highs: number[], lows: number[]): { trend: Side | null; info: number[] | null } {
  if (highs.length < 2 || lows.length < 2) return { trend: null, info: null };
  const h1 = bars[highs[highs.length - 2]].high;
  const h2 = bars[highs[highs.length - 1]].high;
  const l1 = bars[lows[lows.length - 2]].low;
  const l2 = bars[lows[lows.length - 1]].low;
  if (h2 > h1 && l2 > l1) return { trend: 'bull', info: [h1, h2, l1, l2] };
  if (h2 < h1 && l2 < l1) return { trend: 'bear', info: [h1, h2, l1, l2] };
  return { trend: null, info: [h1, h2, l1, l2] };
}

/** Most recent close beyond a prior swing point. */
function lastBreak(bars: Bar[], highs: number[], lows: number[]): { kind: Side; level: number; idx: number } | null {
  let best: { kind: Side; level: number; idx: number } | null = null;
  const groups: Array<[Side, number[]]> = [['bull', highs], ['bear', lows]];
  for (const [kind, idxs] of groups) {
    for (const pi of idxs) {
      const level = kind === 'bull' ? bars[pi].high : bars[pi].low;
      for (let j = pi + 1; j < bars.length; j++) {
        const c = bars[j].close;
        if ((kind === 'bull' && c > level) || (kind === 'bear' && c < level)) {
          if (best === null || j > best.idx) best = { kind, level, idx: j };
          break;
        }
      }
    }
  }
  return best;
}

type Sweep = { level: number; wick: number; idx: number } | null;

function sweeps(bars: Bar[], highs: number[], lows: number[]): { bull: Sweep; bear: Sweep } {
  const start = Math.max(0, bars.length - SWEEP_LOOKBACK);
  const found: { bull: Sweep; bear: Sweep } = { bull: null, bear: null };
  for (let j = start; j < bars.length; j++) {
    const b = bars[j];
    for (const pi of lows) {
      if (pi < j && b.low < bars[pi].low && bars[pi].low < b.close) found.bull = { level: bars[pi].low, wick: b.low, idx: j };
    }
    for (const pi of highs) {
      if (pi < j && b.high > bars[pi].high && bars[pi].high > b.close) found.bear = { level: bars[pi].high, wick: b.high, idx: j };
    }
  }
  return found;
}

type Zone = { low: number; high: number; idx: number } | null;

/** Most recent unfilled fair-value gap for `side`. */
function fvg(bars: Bar[], side: Side): Zone {
  const start = Math.max(2, bars.length - ZONE_LOOKBACK);
  for (let i = bars.length - 1; i >= start; i--) {
    const a = bars[i - 2];
    const c = bars[i];
    const after = bars.slice(i + 1);
    if (side === 'bull' && c.low > a.high) {
      const lo = a.high;
      const hi = c.low;
      if (after.every((b) => b.low > lo)) return { low: lo, high: hi, idx: i - 1 };
    }
    if (side === 'bear' && c.high < a.low) {
      const lo = c.high;
      const hi = a.low;
      if (after.every((b) => b.high < hi)) return { low: lo, high: hi, idx: i - 1 };
    }
  }
  return null;
}

/** Last opposite-colour candle before the move that broke structure. */
function orderBlock(bars: Bar[], side: Side, breakIdx: number): Zone {
  for (let i = breakIdx - 1; i > Math.max(-1, breakIdx - 20); i--) {
    const b = bars[i];
    if (side === 'bull' && b.close < b.open) return { low: b.low, high: b.high, idx: i };
    if (side === 'bear' && b.close > b.open) return { low: b.low, high: b.high, idx: i };
  }
  return null;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function analyze(pair: string, bars: Bar[], swing: number, minRR: number, tf: string): Setup {
  const p = pair;
  const ps = pipSize(p);
  const dec = decimals(p);
  const r = (x: number) => roundTo(x, dec);
  const out: Setup = {
    pair: p, timeframe: tf, decision: 'no_trade', side: null, reasons: [],
    price: bars.length ? r(bars[bars.length - 1].close) : null,
    lastBarTime: bars.length ? bars[bars.length - 1].t : null,
  };
  if (bars.length < 4 * swing + 20) {
    out.reasons.push(`only ${bars.length} bars - not enough history on ${tf}`);
    return out;
  }
  const price = bars[bars.length - 1].close;
  const a = atr(bars);
  const { highs, lows } = pivots(bars, swing);
  const { trend, info } = structure(bars, highs, lows);
  const brk = lastBreak(bars, highs, lows);
  const swp = sweeps(bars, highs, lows);

  const score = { bull: 0, bear: 0 };
  const why: Record<Side, string[]> = { bull: [], bear: [] };
  if (trend && info) {
    const [h1, h2, l1, l2] = info;
    const word = trend === 'bull' ? 'higher highs and higher lows' : 'lower highs and lower lows';
    score[trend] += 2;
    why[trend].push(`${trend === 'bull' ? 'Bullish' : 'Bearish'} structure: ${word} `
      + `(highs ${fmt(p, h1)} -> ${fmt(p, h2)}, lows ${fmt(p, l1)} -> ${fmt(p, l2)})`);
  }
  if (brk) {
    score[brk.kind] += 2;
    why[brk.kind].push(`Break of structure: closed ${brk.kind === 'bull' ? 'above' : 'below'} `
      + `the swing ${brk.kind === 'bull' ? 'high' : 'low'} ${fmt(p, brk.level)} `
      + `${bars.length - 1 - brk.idx} bar(s) ago`);
  }
  if (swp.bull) {
    score.bull += 1;
    why.bull.push(`Sell-side liquidity taken: wick to ${fmt(p, swp.bull.wick)} under the swing low `
      + `${fmt(p, swp.bull.level)}, closed back above`);
  }
  if (swp.bear) {
    score.bear += 1;
    why.bear.push(`Buy-side liquidity taken: wick to ${fmt(p, swp.bear.wick)} over the swing high `
      + `${fmt(p, swp.bear.level)}, closed back below`);
  }
  if (highs.length && lows.length) {
    const rngHi = bars[highs[highs.length - 1]].high;
    const rngLo = bars[lows[lows.length - 1]].low;
    if (rngHi > rngLo) {
      const pos = (price - rngLo) / (rngHi - rngLo);
      if (pos < 0.5) {
        score.bull += 1;
        why.bull.push(`Price in discount: ${pct(pos)} of the range ${fmt(p, rngLo)}-${fmt(p, rngHi)}`);
      } else if (pos > 0.5) {
        score.bear += 1;
        why.bear.push(`Price in premium: ${pct(pos)} of the range ${fmt(p, rngLo)}-${fmt(p, rngHi)}`);
      }
    }
  }
  out.score = score;

  let side: Side | null = null;
  if (score.bull >= 4 && score.bull >= score.bear + 2) side = 'bull';
  else if (score.bear >= 4 && score.bear >= score.bull + 2) side = 'bear';
  if (side === null) {
    const all = [...why.bull, ...why.bear];
    out.reasons = all.length ? all : ['no swing structure on this timeframe'];
    out.reasons.push(`No clear edge: bullish score ${score.bull}, bearish ${score.bear} (a trade needs 4+ and a lead of 2)`);
    return out;
  }
  const sgn = side === 'bull' ? 1 : -1;
  const reasons = [...why[side]];

  let zone = fvg(bars, side);
  let kind = 'fair-value gap';
  if (zone === null && brk && brk.kind === side) {
    zone = orderBlock(bars, side, brk.idx);
    kind = 'order block';
  }
  if (zone === null) {
    reasons.push(`No unfilled ${side === 'bull' ? 'bullish' : 'bearish'} fair-value gap or order block to enter from`);
    out.reasons = reasons;
    return out;
  }
  const zLo = zone.low;
  const zHi = zone.high;
  let entry: number;
  let entryType: 'market' | 'limit';
  if (zLo <= price && price <= zHi) {
    entry = price;
    entryType = 'market';
    reasons.push(`Entry: price is inside the ${kind} ${fmt(p, zLo)}-${fmt(p, zHi)}`);
  } else {
    entry = (zLo + zHi) / 2;
    entryType = 'limit';
    if ((price - entry) * sgn < 0) {
      reasons.push(`Price ${fmt(p, price)} has already gone ${side === 'bull' ? 'below' : 'above'} `
        + `the ${kind} ${fmt(p, zLo)}-${fmt(p, zHi)}, so that `
        + `${side === 'bull' ? 'buy' : 'sell'} zone has failed - nothing to enter from`);
      out.reasons = reasons;
      return out;
    }
    reasons.push(`Entry: middle of the ${kind} ${fmt(p, zLo)}-${fmt(p, zHi)} (limit, wait for the pullback)`);
  }

  const buf = 0.1 * a;
  let stop: number;
  let where: string;
  if (side === 'bull') {
    const prot = lows.map((i) => bars[i].low).filter((x) => x < entry);
    const base = Math.min(zLo, ...prot.slice(-1));
    stop = base - buf;
    where = prot.length ? 'the zone and the last swing low' : 'the zone';
  } else {
    const prot = highs.map((i) => bars[i].high).filter((x) => x > entry);
    const base = Math.max(zHi, ...prot.slice(-1));
    stop = base + buf;
    where = prot.length ? 'the zone and the last swing high' : 'the zone';
  }
  let risk = Math.abs(entry - stop);
  // 5 pips on FX, 20 ($2) on metals, 0.1% of the price on crypto - same as setup.py
  const minStop = isCrypto(p) ? Math.ceil((entry * 0.001) / ps) * ps : isMetal(p) ? 20 * ps : 5 * ps;
  if (risk < minStop) {
    stop = entry - sgn * minStop;
    risk = minStop;
    where += `, widened to the ${Math.round(minStop / ps)}-pip minimum`;
  }
  reasons.push(`Stop ${side === 'bull' ? 'below' : 'above'} ${where}, plus a 0.1 ATR buffer`);

  const levels = side === 'bull' ? highs.map((i) => bars[i].high) : lows.map((i) => bars[i].low);
  const pool = [...new Set(levels)].sort((x, y) => (side === 'bull' ? x - y : y - x));
  let beyond = pool.filter((x) => (x - entry) * sgn > 0.5 * risk);
  const extreme = side === 'bull' ? Math.max(...bars.map((b) => b.high)) : Math.min(...bars.map((b) => b.low));
  if (!beyond.length && (extreme - entry) * sgn > 0.5 * risk) beyond = [extreme];
  if (!beyond.length) {
    reasons.push('No resting liquidity beyond the entry to target');
    out.reasons = reasons;
    return out;
  }
  let tp1 = beyond[0];
  let tp2: number | null = beyond.slice(1).find((x) => (x - tp1) * sgn > 0.3 * risk) ?? null;
  if (tp2 === null && (extreme - tp1) * sgn > 0.3 * risk) tp2 = extreme;

  // from here on, measure everything from the rounded prices the user sees
  entry = r(entry);
  stop = r(stop);
  tp1 = r(tp1);
  tp2 = tp2 === null ? null : r(tp2);
  risk = Math.abs(entry - stop);
  const final = tp2 ?? tp1;
  const rr = Math.abs(final - entry) / risk;
  reasons.push(`TP1: first ${side === 'bull' ? 'buy' : 'sell'}-side liquidity at ${fmt(p, tp1)}`);
  if (tp2 !== null) reasons.push(`TP2: next liquidity at ${fmt(p, tp2)}`);

  Object.assign(out, {
    side: side === 'bull' ? 'buy' : 'sell', entryType,
    entry, stop, tp1, tp2,
    zone: { kind, low: r(zLo), high: r(zHi) },
    stopPips: roundTo(risk / ps, 1),
    tp1Pips: roundTo(Math.abs(tp1 - entry) / ps, 1),
    tp2Pips: tp2 === null ? null : roundTo(Math.abs(tp2 - entry) / ps, 1),
    rrTp1: roundTo(Math.abs(tp1 - entry) / risk, 2),
    rr: roundTo(rr, 2),
    atrPips: roundTo(a / ps, 1),
  });
  if (rr < minRR) {
    reasons.push(`No Trade: reward:risk ${rr.toFixed(2)} is under the ${minRR} minimum`);
    out.reasons = reasons;
    out.decision = 'no_trade';
    out.rejected = true;
    return out;
  }
  out.decision = 'trade';
  out.reasons = reasons;
  return out;
}

export type TrackResult = {
  status: 'pending' | 'open' | 'TP1 hit' | 'target hit' | 'stopped' | 'stopped after TP1' | 'missed';
  price: number;
  events: string[];
  barsSince: number;
  toStopPips: number;
  toTp1Pips: number;
  toTp2Pips?: number;
  openPips?: number;
};

/** Walk the bars after the analysis: fill, TP1, target, or stop (stop first in a bar that hits both). */
export function track(s: Setup, bars: Bar[]): TrackResult {
  const p = s.pair;
  const ps = pipSize(p);
  const sgn = s.side === 'buy' ? 1 : -1;
  const entry = s.entry as number;
  const stop = s.stop as number;
  const tp1 = s.tp1 as number;
  const tp2 = s.tp2 ?? null;
  const after = bars.filter((b) => b.t > (s.lastBarTime ?? 0));
  let filled = s.entryType === 'market';
  let status: TrackResult['status'] = filled ? 'open' : 'pending';
  let tp1Hit = false;
  const events: string[] = [];
  const stamp = (t: number) => new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' ');
  for (const b of after) {
    const adverse = sgn > 0 ? b.low : b.high;
    const favour = sgn > 0 ? b.high : b.low;
    if (!filled) {
      if ((favour - tp1) * sgn >= 0 && (adverse - entry) * sgn > 0) {
        status = 'missed';
        events.push(`${stamp(b.t)} price reached TP1 without filling the entry - setup void`);
        break;
      }
      if ((adverse - entry) * sgn <= 0) {
        filled = true;
        status = 'open';
        events.push(`${stamp(b.t)} entry filled at ${fmt(p, entry)}`);
      } else {
        continue;
      }
    }
    if ((adverse - stop) * sgn <= 0) {
      status = tp1Hit ? 'stopped after TP1' : 'stopped';
      events.push(`${stamp(b.t)} stop hit at ${fmt(p, stop)}`);
      break;
    }
    const final = tp2 ?? tp1;
    if ((favour - final) * sgn >= 0) {
      status = 'target hit';
      events.push(`${stamp(b.t)} ${tp2 !== null ? 'TP2' : 'TP1'} hit at ${fmt(p, final)}`);
      break;
    }
    if (!tp1Hit && (favour - tp1) * sgn >= 0) {
      tp1Hit = true;
      status = 'TP1 hit';
      events.push(`${stamp(b.t)} TP1 hit at ${fmt(p, tp1)}`);
    }
  }
  const price = roundTo(bars[bars.length - 1].close, decimals(p));
  const pips = (x: number) => roundTo(x / ps, 1) + 0;
  const res: TrackResult = {
    status, price, events, barsSince: after.length,
    toStopPips: pips((price - stop) * sgn),
    toTp1Pips: pips((tp1 - price) * sgn),
  };
  if (tp2 !== null) res.toTp2Pips = pips((tp2 - price) * sgn);
  if (filled) res.openPips = pips((price - entry) * sgn);
  return res;
}
