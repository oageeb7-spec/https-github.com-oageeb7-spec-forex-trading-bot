export function ema(values, n) {
  const k = 2 / (n + 1);
  const out = new Array(values.length);
  let prev = values[0];
  for (let i = 0; i < values.length; i++) out[i] = prev = i ? values[i] * k + prev * (1 - k) : values[0];
  return out;
}

export function sma(values, n) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function stdev(values, n) {
  const m = sma(values, n);
  const out = new Array(values.length).fill(NaN);
  for (let i = n - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (values[j] - m[i]) ** 2;
    out[i] = Math.sqrt(s / n);
  }
  return out;
}

export function atr(bars, n = 14) {
  const tr = bars.map((b, i) =>
    i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l
  );
  return ema(tr, n);
}

export function highest(values, n, i) {
  let m = -Infinity;
  for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.max(m, values[j]);
  return m;
}

export function lowest(values, n, i) {
  let m = Infinity;
  for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.min(m, values[j]);
  return m;
}

// Fractal swing points: a bar whose high/low is the extreme of `k` bars on each side.
export function swings(bars, k = 3) {
  const highs = [], lows = [];
  for (let i = k; i < bars.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) isH = false;
      if (bars[j].l <= bars[i].l) isL = false;
    }
    if (isH) highs.push(i);
    if (isL) lows.push(i);
  }
  return { highs, lows };
}
