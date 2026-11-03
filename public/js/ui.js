export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const num = (n, d = 0) => (n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const usd = (n, d = 0) => `${n < 0 ? '-' : ''}$${num(Math.abs(n), d)}`;
export const pct = (x, d = 1) => `${num(x * 100, d)}%`;
export const signed = (n, d = 0) => `${n >= 0 ? '+' : ''}${num(n, d)}`;
export const time = (t) => new Date(t).toLocaleTimeString('en-GB', { hour12: false });
export const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

export function spark(values, { w = 120, h = 26, color = '#60a5fa', fill = false } = {}) {
  const v = values?.length ? values : [0, 0];
  const min = Math.min(...v), max = Math.max(...v), span = max - min || 1;
  const pts = v.map((y, i) => [(i / Math.max(1, v.length - 1)) * w, h - 2 - ((y - min) / span) * (h - 4)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const area = fill ? `<path d="${d}L${w},${h}L0,${h}Z" fill="${color}" opacity=".12"/>` : '';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${area}<path d="${d}" fill="none" stroke="${color}" stroke-width="1.3"/></svg>`;
}

export function gates(g) {
  return `<div class="gates">${g.map((x) => `<i class="${x === true ? 'ok' : x === false ? 'no' : ''}"></i>`).join('')}</div>`;
}

export const STATUS = {
  queued: 'queued', 'failed-lab': 'dropped in lab', 'failed-sieve': 'failed the sieve', expired: 'withdrawn on newer prices', validated: 'vault reached',
  paper: 'on paper', live: 'live', rejected: 'rejected by you',
};

export async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.ok;
}

export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: width, h: height };
}
