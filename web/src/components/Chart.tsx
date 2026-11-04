import { useEffect, useRef } from 'react';
import type { BarRow, Level } from '../lib/types';

type Props = { bars: BarRow[]; levels: Level[]; ma?: number; label: string; priceDecimals: number };

const C = {
  up: '#26a69a', down: '#ef5350', ma: '#f5a623',
  grid: '#1e2533', text: '#8b93a7', panel: '#0f1420',
};
const ML = 8, MR = 92, MT = 12, MB = 26;

function sma(rows: BarRow[], n: number): Array<number | null> {
  const out: Array<number | null> = new Array(rows.length).fill(null);
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    sum += rows[i][4];
    if (i >= n) sum -= rows[i - n][4];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function timeLabel(sec: number): string {
  return new Date(sec * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function draw(cv: HTMLCanvasElement, bars: BarRow[], levels: Level[], ma: number, priceDec: number) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  if (!W || !H) return;
  cv.width = W * dpr;
  cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  if (!bars.length) return;

  const showVol = bars.some((b) => b[5] > 0);
  const volH = showVol ? Math.round((H - MT - MB) * 0.16) : 0;
  const gap = showVol ? 8 : 0;
  const cw = W - ML - MR;
  const ch = H - MT - MB - volH - gap;
  const volTop = MT + ch + gap;

  let lo = Infinity;
  let hi = -Infinity;
  for (const b of bars) {
    lo = Math.min(lo, b[3]);
    hi = Math.max(hi, b[2]);
  }
  for (const l of levels) {
    lo = Math.min(lo, l.price);
    hi = Math.max(hi, l.price);
  }
  const pad = (hi - lo) * 0.06 || hi * 0.001 || 1;
  lo -= pad;
  hi += pad;
  const dec = Math.min(6, Math.max(2, Math.ceil(-Math.log10((hi - lo) / 4)) + 1));
  const fmt = (v: number) => v.toFixed(dec);
  const x = (i: number) => ML + (bars.length === 1 ? cw / 2 : (i * cw) / (bars.length - 1));
  const y = (p: number) => MT + ((hi - p) / (hi - lo)) * ch;

  ctx.textBaseline = 'middle';
  for (let s = 0; s <= 4; s++) {
    const p = lo + ((hi - lo) * s) / 4;
    const yy = y(p);
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ML, yy);
    ctx.lineTo(W - MR, yy);
    ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.textAlign = 'left';
    ctx.fillText(fmt(p), W - MR + 6, yy);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labels = Math.max(2, Math.min(5, Math.floor(cw / 130)));   // ~130px per time label, so phones get 2
  const step = Math.max(1, Math.floor(bars.length / labels));
  for (let i = 0; i < bars.length; i += step) {
    ctx.fillStyle = C.text;
    ctx.fillText(timeLabel(bars[i][0]), x(i), H - MB + 7);
  }

  const bw = Math.max(1, Math.min(12, (cw / bars.length) * 0.7));
  if (showVol) {
    const vmax = Math.max(...bars.map((b) => b[5])) || 1;
    bars.forEach((b, i) => {
      const h = (b[5] / vmax) * volH;
      ctx.fillStyle = (b[4] >= b[1] ? C.up : C.down) + '55';
      ctx.fillRect(x(i) - bw / 2, volTop + volH - h, bw, Math.max(1, h));
    });
  }
  bars.forEach((b, i) => {
    const col = b[4] >= b[1] ? C.up : C.down;
    const px = x(i);
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, y(b[2]));
    ctx.lineTo(px, y(b[3]));
    ctx.stroke();
    const yo = y(b[1]);
    const yc = y(b[4]);
    ctx.fillStyle = col;
    ctx.fillRect(px - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
  });

  if (ma > 1 && bars.length > ma) {
    const m = sma(bars, ma);
    ctx.strokeStyle = C.ma;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    m.forEach((v, i) => {
      if (v == null) return;
      if (!started) {
        ctx.moveTo(x(i), y(v));
        started = true;
      } else {
        ctx.lineTo(x(i), y(v));
      }
    });
    ctx.stroke();
    ctx.fillStyle = C.ma;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`MA${ma}`, ML + 4, MT + 2);
  }

  type Tag = { y: number; ly: number; color: string; text: string };
  const tags: Tag[] = [];
  for (const l of levels) {
    const yy = y(l.price);
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = l.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ML, yy);
    ctx.lineTo(W - MR, yy);
    ctx.stroke();
    ctx.setLineDash([]);
    tags.push({ y: yy, ly: yy, color: l.color, text: l.title });
  }
  const last = bars[bars.length - 1];
  const yl = y(last[4]);
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = C.text;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ML, yl);
  ctx.lineTo(W - MR, yl);
  ctx.stroke();
  ctx.setLineDash([]);
  tags.push({ y: yl, ly: yl, color: last[4] >= last[1] ? C.up : C.down, text: `Last ${last[4].toFixed(priceDec)}` });

  // right-edge labels, nudged apart so levels a pip apart never hide each other
  const TH = 16;
  tags.sort((a, b) => a.y - b.y);
  tags.forEach((t, i) => {
    t.ly = Math.max(MT + TH / 2, t.y);
    if (i && t.ly < tags[i - 1].ly + TH + 1) t.ly = tags[i - 1].ly + TH + 1;
  });
  for (let i = tags.length - 1; i >= 0; i--) {
    const cap = i === tags.length - 1 ? MT + ch - TH / 2 : tags[i + 1].ly - TH - 1;
    if (tags[i].ly > cap) tags[i].ly = cap;
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const t of tags) {
    if (Math.abs(t.ly - t.y) > 1) {
      ctx.strokeStyle = t.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(W - MR - 6, t.y);
      ctx.lineTo(W - MR, t.ly);
      ctx.stroke();
    }
    ctx.fillStyle = t.color;
    ctx.fillRect(W - MR, t.ly - TH / 2, MR, TH);
    ctx.fillStyle = '#fff';
    ctx.fillText(t.text, W - MR + 4, t.ly);
  }
}

export default function Chart({ bars, levels, ma = 20, label, priceDecimals }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const paint = () => draw(cv, bars, levels, ma, priceDecimals);
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [bars, levels, ma, priceDecimals]);
  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={label}
      data-testid="price-chart"
      className="block h-[360px] w-full rounded-lg sm:h-[440px]"
      style={{ background: C.panel }}
    />
  );
}
