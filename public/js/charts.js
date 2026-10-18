import { fitCanvas, num } from './ui.js';

const GRID = '#151b22';
const AXIS = '#5d6773';

// Equity curve with drawdown underneath; `split` (0..1) marks where out-of-sample starts.
export function drawEquity(canvas, equity, drawdown, { split = null } = {}) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!equity?.length) return;
  const top = 26, eqH = h * 0.68, ddTop = top + eqH + 8, ddH = h - ddTop - 18;
  const min = Math.min(0, ...equity), max = Math.max(...equity, 1);
  const x = (i) => (i / (equity.length - 1)) * (w - 4) + 2;
  const y = (v) => top + eqH - ((v - min) / (max - min)) * eqH;

  ctx.strokeStyle = GRID;
  for (let k = 0; k <= 4; k++) { const yy = top + (eqH * k) / 4; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke(); }
  ctx.font = '10px JetBrains Mono'; ctx.fillStyle = AXIS;
  ctx.fillText('BALANCE IN $', 4, 14);

  if (split != null) {
    const sx = x(split * (equity.length - 1));
    ctx.fillStyle = 'rgba(96,165,250,.05)';
    ctx.fillRect(sx, top, w - sx, eqH);
    ctx.strokeStyle = '#2b3542'; ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(sx, top); ctx.lineTo(sx, top + eqH); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = AXIS; ctx.fillText('OUT OF SAMPLE →', sx + 6, top + 12);
  }

  const grad = ctx.createLinearGradient(0, top, 0, top + eqH);
  grad.addColorStop(0, 'rgba(74,222,128,.28)'); grad.addColorStop(1, 'rgba(74,222,128,0)');
  ctx.beginPath();
  equity.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.lineTo(x(equity.length - 1), top + eqH); ctx.lineTo(x(0), top + eqH); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath();
  equity.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = '#86efac'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1;

  const last = equity[equity.length - 1];
  const label = `$${num(last)}`;
  ctx.font = '11px JetBrains Mono';
  const tw = ctx.measureText(label).width + 10;
  ctx.fillStyle = '#0c0f13'; ctx.strokeStyle = '#2f6b45';
  ctx.fillRect(w - tw - 4, y(last) - 18, tw, 16); ctx.strokeRect(w - tw - 4, y(last) - 18, tw, 16);
  ctx.fillStyle = '#d1fae5'; ctx.fillText(label, w - tw + 1, y(last) - 6);

  if (drawdown?.length) {
    const ddMin = Math.min(...drawdown, -1);
    ctx.beginPath(); ctx.moveTo(x(0), ddTop);
    drawdown.forEach((v, i) => ctx.lineTo(x(i), ddTop + (v / ddMin) * ddH));
    ctx.lineTo(x(drawdown.length - 1), ddTop); ctx.closePath();
    ctx.fillStyle = 'rgba(240,82,82,.35)'; ctx.fill();
    ctx.strokeStyle = 'rgba(240,82,82,.8)'; ctx.stroke();
    ctx.fillStyle = AXIS; ctx.font = '10px JetBrains Mono';
    ctx.fillText('DRAWDOWN', 4, h - 4);
    const mi = drawdown.indexOf(ddMin);
    if (mi >= 0) ctx.fillText(`max drawdown -$${num(-ddMin)}`, Math.min(w - 150, x(mi) + 6), ddTop + ddH + 12);
  }
}

// Fan of variant equity curves, re-based so every curve passes through the in/out-of-sample split.
export function drawFan(canvas, variants, { splitX = 0.6, highlight = null } = {}) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const sx = w * splitX, cy = h * 0.5;
  ctx.fillStyle = 'rgba(255,255,255,.015)'; ctx.fillRect(sx, 0, w - sx, h);
  ctx.strokeStyle = '#2b3542'; ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, h); ctx.stroke();
  ctx.font = '10px JetBrains Mono'; ctx.fillStyle = AXIS;
  ctx.fillText('IN SAMPLE', 8, 14); ctx.fillText('OUT OF SAMPLE', sx + 8, 14);

  const rebased = variants.map((v) => {
    const e = v.equity, k = Math.round(v.split * (e.length - 1));
    const base = e[k] ?? 0;
    return { v, e: e.map((p) => p - base), k };
  });
  const scale = Math.max(1, ...rebased.flatMap((r) => r.e.map(Math.abs))) / (h * 0.46);
  ctx.globalCompositeOperation = 'lighter';
  for (const { v, e, k } of rebased) {
    const color = v.id === highlight ? '#ffffff' : v.passed === true ? '#4ade80' : v.passed === false ? '#9aa4b0' : '#facc15';
    ctx.strokeStyle = color;
    ctx.globalAlpha = v.id === highlight ? 1 : v.passed === true ? 0.75 : v.passed === false ? 0.16 : 0.45;
    ctx.lineWidth = v.id === highlight ? 2 : 1;
    ctx.beginPath();
    e.forEach((p, i) => {
      const xx = i <= k ? (k ? (i / k) * sx : sx) : sx + ((i - k) / Math.max(1, e.length - 1 - k)) * (w - sx - 4);
      const yy = cy - p / scale;
      i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
    });
    ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.lineWidth = 1; ctx.globalCompositeOperation = 'source-over';
}

// Candlestick chart with concept annotations (lines, boxes, marks, bands).
export function drawCandles(canvas, example) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!example) return;
  const { candles, ann } = example;
  let lo = Math.min(...candles.map((c) => c[2])), hi = Math.max(...candles.map((c) => c[1]));
  for (const a of ann) { if (a.top) hi = Math.max(hi, a.top); if (a.bottom) lo = Math.min(lo, a.bottom); }
  const pad = (hi - lo) * 0.18; lo -= pad; hi += pad;
  const cw = (w - 20) / candles.length;
  const x = (i) => 10 + i * cw + cw / 2;
  const y = (p) => 10 + (1 - (p - lo) / (hi - lo)) * (h - 20);

  for (const a of ann) {
    if (a.type === 'box' || a.type === 'band') {
      ctx.fillStyle = a.type === 'band' ? 'rgba(167,139,250,.10)' : 'rgba(96,165,250,.14)';
      ctx.strokeStyle = a.type === 'band' ? 'rgba(167,139,250,.5)' : 'rgba(96,165,250,.5)';
      const x0 = x(a.from) - cw / 2, x1 = x(Math.min(a.to, candles.length - 1)) + cw / 2;
      ctx.fillRect(x0, y(a.top), x1 - x0, y(a.bottom) - y(a.top));
      ctx.strokeRect(x0, y(a.top), x1 - x0, y(a.bottom) - y(a.top));
    }
    if (a.type === 'vline') {
      ctx.strokeStyle = 'rgba(245,165,36,.5)'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x(a.at), 0); ctx.lineTo(x(a.at), h); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  candles.forEach(([o, hh, l, c], i) => {
    const up = c >= o;
    ctx.strokeStyle = ctx.fillStyle = up ? '#d7dde5' : '#5d6773';
    ctx.beginPath(); ctx.moveTo(x(i), y(hh)); ctx.lineTo(x(i), y(l)); ctx.stroke();
    const bw = Math.max(2, cw * 0.55), by = y(Math.max(o, c)), bh = Math.max(1, Math.abs(y(o) - y(c)));
    ctx.fillRect(x(i) - bw / 2, by, bw, bh);
  });
  ctx.font = '10px JetBrains Mono';
  for (const a of ann) {
    ctx.fillStyle = '#c9d3de';
    if (a.type === 'line') {
      ctx.strokeStyle = 'rgba(215,221,229,.6)'; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x(a.from), y(a.price)); ctx.lineTo(x(a.to), y(a.price)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillText(a.label, x(a.from), y(a.price) - 5);
    } else if (a.type === 'mark') {
      const ty = a.below ? y(a.price) + 14 : y(a.price) - 8;
      ctx.fillText(a.label, Math.min(w - ctx.measureText(a.label).width - 4, Math.max(4, x(a.at) - ctx.measureText(a.label).width / 2)), ty);
    } else if (a.label) {
      const lx = a.type === 'vline' ? x(a.at) + 4 : x(a.from) - cw / 2 + 4;
      const ly = a.type === 'vline' ? 14 : y(a.top) - 5;
      ctx.fillText(a.label, lx, ly);
    }
  }
}

// Rotating point-cloud "brain core" with particles flowing in from sources and out to outputs.
export class Sphere {
  constructor(canvas, anchors) {
    this.canvas = canvas;
    this.anchors = anchors; // () => ({ inputs: [{x,y,color}], outputs: [...] })
    this.angle = 0;
    this.particles = [];
    const n = 1500, golden = Math.PI * (3 - Math.sqrt(5));
    this.points = Array.from({ length: n }, (_, i) => {
      const yy = 1 - (i / (n - 1)) * 2, r = Math.sqrt(1 - yy * yy), th = golden * i;
      const jitter = 1 + (Math.random() - 0.5) * 0.06;
      return [Math.cos(th) * r * jitter, yy * jitter, Math.sin(th) * r * jitter];
    });
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  pulse(side, index, count = 1) {
    for (let k = 0; k < Math.min(count, 6); k++) this.particles.push({ side, index, t: -k * 0.12 });
  }

  loop() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2 - 6, R = Math.min(w * 0.2, h * 0.36);
    this.angle += 0.0025;
    const ca = Math.cos(this.angle), sa = Math.sin(this.angle), tilt = 0.35, ct = Math.cos(tilt), st = Math.sin(tilt);
    const { inputs, outputs } = this.anchors();

    // Connection curves
    const curve = (a, b, color, alpha) => {
      ctx.strokeStyle = color; ctx.globalAlpha = alpha;
      for (let k = -1; k <= 1; k++) {
        ctx.beginPath(); ctx.moveTo(a.x, a.y + k * 2);
        ctx.bezierCurveTo((a.x + b.x) / 2, a.y + k * 2, (a.x + b.x) / 2, b.y + k * 3, b.x, b.y + k * 3); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    const entry = (a) => ({ x: cx + (a.x < cx ? -R * 0.92 : R * 0.92), y: cy + (a.y - cy) * 0.4 });
    inputs.forEach((a) => curve(a, entry(a), '#60a5fa', 0.22));
    outputs.forEach((a) => curve(entry(a), a, '#4ade80', 0.22));

    // Sphere
    for (const [px, py, pz] of this.points) {
      const x1 = px * ca + pz * sa, z1 = -px * sa + pz * ca;
      const y2 = py * ct - z1 * st, z2 = py * st + z1 * ct;
      const depth = (z2 + 1) / 2;
      ctx.fillStyle = `rgba(${200 + depth * 55},${210 + depth * 45},${225 + depth * 30},${0.12 + depth * 0.7})`;
      const s = 0.6 + depth * 0.9;
      ctx.fillRect(cx + x1 * R, cy + y2 * R, s, s);
    }

    // Particles
    const bez = (a, b, t) => {
      const c1 = { x: (a.x + b.x) / 2, y: a.y }, c2 = { x: (a.x + b.x) / 2, y: b.y }, u = 1 - t;
      return {
        x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
      };
    };
    this.particles = this.particles.filter((p) => (p.t += 0.012) < 1);
    for (const p of this.particles) {
      if (p.t < 0) continue;
      const a = p.side === 'in' ? inputs[p.index] : outputs[p.index];
      if (!a) continue;
      const pos = p.side === 'in' ? bez(a, entry(a), p.t) : bez(entry(a), a, p.t);
      ctx.fillStyle = p.side === 'in' ? '#bfdbfe' : '#bbf7d0';
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(pos.x, pos.y, 1.8, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  stop() { cancelAnimationFrame(this.raf); }
}

const KIND_COLOR = { youtube: [248, 113, 113], github: [167, 139, 250], arxiv: [96, 165, 250], web: [74, 222, 128] };
const STATUS_ALPHA = { queued: 0.35, reading: 1, read: 0.8, summarized: 0.95, rejected: 0.18 };

// Research galaxy: one glowing cluster per topic, one star per source.
export class Galaxy {
  constructor(canvas) {
    this.canvas = canvas;
    this.sources = [];
    this.topics = [];
    this.t = 0;
    this.hover = null;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    });
    canvas.addEventListener('mouseleave', () => (this.mouse = null));
  }

  set(sources, topics, reading) { this.sources = sources; this.topics = topics; this.reading = reading; }

  loop() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    this.t += 0.004;
    ctx.clearRect(0, 0, w, h);
    const centers = this.topics.map((_, i) => {
      const a = (i / this.topics.length) * Math.PI * 2 + this.t * 0.3;
      const rr = i % 2 ? 0.33 : 0.24;
      return { x: w / 2 + Math.cos(a) * w * rr, y: h / 2 + Math.sin(a) * h * rr * 1.1 };
    });
    ctx.globalCompositeOperation = 'lighter';
    let hovered = null;
    for (const s of this.sources) {
      const ci = this.topics.indexOf(s.topic), c = centers[ci];
      if (!c) continue;
      const seed = hash(s.id), ang = (seed % 1000) / 1000 * Math.PI * 2 + this.t * (0.5 + (seed % 7) / 10);
      const dist = 6 + ((seed >> 10) % 1000) / 1000 * 46;
      const x = c.x + Math.cos(ang) * dist, y = c.y + Math.sin(ang) * dist * 0.7;
      const [r, g, b] = KIND_COLOR[s.kind];
      const al = STATUS_ALPHA[s.status] ?? 0.5;
      const isReading = this.reading && this.reading.id === s.id;
      const size = isReading ? 4 : s.status === 'summarized' ? 2.2 : 1.5;
      const grd = ctx.createRadialGradient(x, y, 0, x, y, size * 5);
      grd.addColorStop(0, `rgba(${r},${g},${b},${al})`); grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grd; ctx.fillRect(x - size * 5, y - size * 5, size * 10, size * 10);
      ctx.fillStyle = `rgba(255,255,255,${al})`; ctx.fillRect(x - size / 3, y - size / 3, size / 1.5, size / 1.5);
      if (this.mouse && Math.hypot(this.mouse.x - x, this.mouse.y - y) < 6) hovered = { s, x, y };
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = '10px JetBrains Mono';
    centers.forEach((c, i) => {
      const n = this.sources.filter((s) => s.topic === this.topics[i]).length;
      ctx.fillStyle = 'rgba(201,211,222,.75)';
      const label = `${this.topics[i]} · ${n}`;
      ctx.fillText(label, c.x - ctx.measureText(label).width / 2, c.y + 50);
    });
    if (hovered) {
      const label = `${hovered.s.kind.toUpperCase()} · ${hovered.s.title} · ${hovered.s.status}`;
      const tw = ctx.measureText(label).width + 12;
      const lx = Math.min(w - tw - 4, hovered.x + 10);
      ctx.fillStyle = 'rgba(8,10,13,.92)'; ctx.fillRect(lx, hovered.y - 22, tw, 18);
      ctx.strokeStyle = '#2b3542'; ctx.strokeRect(lx, hovered.y - 22, tw, 18);
      ctx.fillStyle = '#e5e9ee'; ctx.fillText(label, lx + 6, hovered.y - 9);
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  stop() { cancelAnimationFrame(this.raf); }
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
