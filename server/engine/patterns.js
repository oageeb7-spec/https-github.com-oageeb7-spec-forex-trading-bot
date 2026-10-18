// Knowledge base: trading concepts with a plain-language definition, the detector code
// the brain uses, and live statistics measured on the market data.
import { atr, sma, stdev, swings } from './indicators.js';

const FOLLOW = 10;

export const CONCEPTS = [
  {
    id: 'bos', name: 'Break of structure', aka: 'BOS', category: 'Price action', tag: 'ICT',
    plain: 'Price closes beyond the last swing in the direction of the trend: the trend continues.',
    code: `def break_of_structure(k, swings):\n    last_top = swings.top.ffill()\n    return k.close > last_top`,
    detect(bars) {
      const { highs, lows } = swings(bars, 3), out = [];
      let hi = 0, lo = 0;
      for (let i = 10; i < bars.length; i++) {
        while (hi < highs.length && highs[hi] + 3 < i) hi++;
        while (lo < lows.length && lows[lo] + 3 < i) lo++;
        const sh = highs[hi - 1], sl = lows[lo - 1];
        if (sh != null && bars[i].c > bars[sh].h && bars[i - 1].c <= bars[sh].h)
          out.push({ i, dir: 1, ann: [{ type: 'line', from: sh, to: i, price: bars[sh].h, label: 'swing high' }, { type: 'mark', at: i, price: bars[i].h, label: 'break of structure' }] });
        if (sl != null && bars[i].c < bars[sl].l && bars[i - 1].c >= bars[sl].l)
          out.push({ i, dir: -1, ann: [{ type: 'line', from: sl, to: i, price: bars[sl].l, label: 'swing low' }, { type: 'mark', at: i, price: bars[i].l, label: 'break of structure' }] });
      }
      return out;
    },
  },
  {
    id: 'fvg', name: 'Fair value gap', aka: 'FVG · imbalance', category: 'Price action', tag: 'ICT',
    plain: 'Three candles where the wick of candle 1 and the wick of candle 3 do not overlap. The gap left behind often gets revisited and "filled".',
    code: `def fair_value_gap(k, min_atr=0.3):\n    bull = k.low > k.high.shift(2)\n    size = (k.low - k.high.shift(2)) / atr(k)\n    return bull & (size > min_atr)`,
    detect(bars) {
      const a = atr(bars), out = [];
      for (let i = 2; i < bars.length; i++) {
        const bull = bars[i].l - bars[i - 2].h, bear = bars[i - 2].l - bars[i].h;
        if (bull > a[i] * 0.3) out.push({ i, dir: 1, ann: [{ type: 'box', from: i - 2, to: i + 8, top: bars[i].l, bottom: bars[i - 2].h, label: 'gap' }] });
        else if (bear > a[i] * 0.3) out.push({ i, dir: -1, ann: [{ type: 'box', from: i - 2, to: i + 8, top: bars[i - 2].l, bottom: bars[i].h, label: 'gap' }] });
      }
      return out;
    },
  },
  {
    id: 'displacement', name: 'Displacement', aka: 'impulse candle', category: 'Price action', tag: 'ICT',
    plain: 'An unusually large, decisive candle — at least twice the average range — that shows real money moving the price.',
    code: `def displacement(k, mult=2.0):\n    body = (k.close - k.open).abs()\n    return body > mult * atr(k)`,
    detect(bars) {
      const a = atr(bars), out = [];
      for (let i = 15; i < bars.length; i++) {
        const body = bars[i].c - bars[i].o;
        if (Math.abs(body) > 2 * a[i - 1]) out.push({ i, dir: Math.sign(body), ann: [{ type: 'mark', at: i, price: body > 0 ? bars[i].h : bars[i].l, label: 'displacement' }] });
      }
      return out;
    },
  },
  {
    id: 'squeeze', name: 'Bollinger squeeze', aka: 'volatility contraction', category: 'Volatility', tag: 'Indicator',
    plain: 'The bands pull tighter than in the last 100 candles: the market is coiling and a large move often follows.',
    code: `def squeeze(k, n=20):\n    width = 4 * k.close.rolling(n).std() / k.close.rolling(n).mean()\n    return width < 0.6 * width.rolling(100).mean()`,
    detect(bars) {
      const c = bars.map((b) => b.c), m = sma(c, 20), sd = stdev(c, 20);
      const bw = c.map((_, i) => (4 * sd[i]) / m[i] || 0), avg = sma(bw, 100), out = [];
      let last = -50;
      for (let i = 120; i < bars.length; i++) {
        if (bw[i] < avg[i] * 0.6 && i - last > 30) {
          last = i;
          out.push({ i, dir: 0, ann: [{ type: 'band', from: i - 12, to: i + 4, top: m[i] + 2 * sd[i], bottom: m[i] - 2 * sd[i], label: 'squeeze' }] });
        }
      }
      return out;
    },
  },
  {
    id: 'choch', name: 'Change of character', aka: 'CHoCH', category: 'Market structure', tag: 'ICT',
    plain: 'After a run of higher highs, price breaks the last higher low: the first sign the trend is turning.',
    code: `def change_of_character(k, swings):\n    uptrend = swings.top.diff() > 0\n    return uptrend & (k.close < swings.bottom.ffill())`,
    detect(bars) {
      const { highs, lows } = swings(bars, 3), out = [];
      for (let n = 2; n < lows.length; n++) {
        const sl = lows[n - 1];
        const hs = highs.filter((h) => h < sl + 6 && h > sl - 40).slice(-2);
        if (hs.length < 2 || bars[hs[1]].h <= bars[hs[0]].h) continue;
        for (let i = sl + 4; i < Math.min(bars.length, lows[n] + 4); i++) {
          if (bars[i].c < bars[sl].l) {
            out.push({ i, dir: -1, ann: [{ type: 'mark', at: hs[1], price: bars[hs[1]].h, label: 'higher high' }, { type: 'line', from: sl, to: i, price: bars[sl].l, label: 'higher low' }, { type: 'mark', at: i, price: bars[i].l, label: 'change of character' }] });
            break;
          }
        }
      }
      return out;
    },
  },
  {
    id: 'hhhl', name: 'Higher high, higher low', aka: 'uptrend structure', category: 'Market structure', tag: 'Price action',
    plain: 'Each swing top is above the previous top and each swing bottom above the previous bottom.',
    code: `def higher_high_higher_low(swings):\n    return (swings.top.diff() > 0) & (swings.bottom.diff() > 0)`,
    detect(bars) {
      const { highs, lows } = swings(bars, 3), out = [];
      for (let n = 1; n < highs.length; n++) {
        const l2 = lows.filter((l) => l < highs[n]).slice(-2);
        if (l2.length === 2 && bars[highs[n]].h > bars[highs[n - 1]].h && bars[l2[1]].l > bars[l2[0]].l)
          out.push({ i: highs[n], dir: 1, ann: [{ type: 'mark', at: highs[n - 1], price: bars[highs[n - 1]].h, label: 'high' }, { type: 'mark', at: highs[n], price: bars[highs[n]].h, label: 'higher high' }, { type: 'mark', at: l2[1], price: bars[l2[1]].l, label: 'higher low', below: true }] });
      }
      return out;
    },
  },
  {
    id: 'sweep', name: 'Liquidity sweep', aka: 'stop hunt', category: 'Liquidity', tag: 'ICT',
    plain: 'The wick runs past a swing high where stops rest, but the candle closes back below it.',
    code: `def liquidity_sweep(k, swings):\n    top = swings.top.ffill()\n    return (k.high > top) & (k.close < top)`,
    detect(bars) {
      const { highs } = swings(bars, 3), out = [];
      let h = 0;
      for (let i = 10; i < bars.length; i++) {
        while (h < highs.length && highs[h] + 3 < i) h++;
        const sh = highs[h - 1];
        if (sh != null && bars[i].h > bars[sh].h && bars[i].c < bars[sh].h && bars[i - 1].h <= bars[sh].h)
          out.push({ i, dir: -1, ann: [{ type: 'line', from: sh, to: i, price: bars[sh].h, label: 'resting stops' }, { type: 'mark', at: i, price: bars[i].h, label: 'sweep' }] });
      }
      return out;
    },
  },
  {
    id: 'orderblock', name: 'Order block', aka: 'OB', category: 'Price action', tag: 'ICT',
    plain: 'The last opposite-colored candle before a displacement: the zone where large orders were placed.',
    code: `def order_block(k):\n    disp = displacement(k)\n    return (k.close < k.open).shift(1) & disp`,
    detect(bars) {
      const a = atr(bars), out = [];
      for (let i = 16; i < bars.length; i++) {
        const body = bars[i].c - bars[i].o, prev = bars[i - 1];
        if (body > 2 * a[i - 1] && prev.c < prev.o)
          out.push({ i, dir: 1, ann: [{ type: 'box', from: i - 1, to: i + 10, top: prev.h, bottom: prev.l, label: 'order block' }] });
      }
      return out;
    },
  },
  {
    id: 'range', name: 'Range', aka: 'consolidation', category: 'Market structure', tag: 'Price action',
    plain: 'For 24 candles price stays inside a band narrower than three average ranges.',
    code: `def in_range(k, n=24):\n    span = k.high.rolling(n).max() - k.low.rolling(n).min()\n    return span < 3 * atr(k)`,
    detect(bars) {
      const a = atr(bars), out = [];
      let last = -40;
      for (let i = 30; i < bars.length; i++) {
        let hi = -Infinity, lo = Infinity;
        for (let j = i - 23; j <= i; j++) { hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l); }
        if (hi - lo < 3 * a[i] && i - last > 24) {
          last = i;
          out.push({ i, dir: 0, ann: [{ type: 'box', from: i - 23, to: i, top: hi, bottom: lo, label: 'range' }] });
        }
      }
      return out;
    },
  },
  {
    id: 'london', name: 'London open', aka: 'session', category: 'Sessions', tag: 'Time',
    plain: 'The first hour of the London session (07:00 UTC), when FX volume and volatility jump.',
    code: `def london_open(k):\n    return k.index.hour == 7`,
    detect(bars) {
      const out = [];
      for (let i = 1; i < bars.length; i++)
        if (new Date(bars[i].t).getUTCHours() === 7) out.push({ i, dir: 0, ann: [{ type: 'vline', at: i, label: 'London open' }] });
      return out;
    },
  },
];

export function analyzeConcept(concept, bars, symbol) {
  const hits = concept.detect(bars);
  let follow = 0, counted = 0;
  for (const h of hits) {
    if (h.i + FOLLOW >= bars.length) continue;
    const move = bars[h.i + FOLLOW].c - bars[h.i].c;
    if (h.dir) { counted++; if (Math.sign(move) === h.dir) follow++; }
    else { counted++; if (Math.abs(move) > Math.abs(bars[h.i].h - bars[h.i].l) * 1.5) follow++; }
  }
  const pick = hits[Math.floor(hits.length * 0.62)] || hits[0];
  let example = null;
  if (pick) {
    const from = Math.max(0, pick.i - 24), to = Math.min(bars.length, pick.i + 10);
    example = {
      candles: bars.slice(from, to).map((b) => [b.o, b.h, b.l, b.c]),
      ann: pick.ann.map((a) => ({ ...a, from: a.from != null ? a.from - from : undefined, to: a.to != null ? Math.min(a.to, to - 1) - from : undefined, at: a.at != null ? a.at - from : undefined })),
    };
  }
  return {
    found: hits.length,
    followRate: counted ? follow / counted : 0,
    followLabel: hits[0]?.dir === 0 ? 'big move within 10 candles' : 'trend continues 10 candles',
    symbol,
    example,
  };
}
