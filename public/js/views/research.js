import { $, esc, num, ago } from '../ui.js';
import { Galaxy } from '../charts.js';

let root, galaxy;

function reading(s) {
  const r = s.reading;
  if (!r) return '<div class="empty">Nothing being read right now.</div>';
  const prog = r.kind === 'youtube' && r.progress ? Math.min(1, r.progress / r.size) : 1;
  return `<div class="lbl">${r.kind === 'youtube' ? 'Now watching' : 'Last read'}</div>
    <h3 style="margin:6px 0;font-weight:500">${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)} ↗</a>` : esc(r.title)}</h3>
    <div class="dim" style="font-size:12px">${esc(r.topic)} · ${r.kind === 'youtube' && !r.live ? `${r.size} min video` : `${num(r.size)} words`}</div>
    <div style="height:4px;background:var(--line-2);margin:10px 0"><i style="display:block;height:100%;width:${prog * 100}%;background:var(--cyan)"></i></div>
    <div class="row" style="flex-wrap:wrap;gap:6px"><span class="chip">${r.kind}</span><span class="chip ${r.status === 'summarized' ? 'green' : 'amber'}">${r.status}</span></div>`;
}

function queues(s) {
  const q = s.queues;
  return `<div class="kv"><span>To read</span><span>${q.toRead}</span><span>To watch</span><span>${q.toWatch}</span><span>To summarize</span><span>${q.toSummarize}</span><span>To recipe</span><span>${q.toRecipe}</span><span>To lab</span><span>${q.toLab}</span></div>`;
}

function list(s) {
  if (!s.sources.length) return `<div class="empty">${s.research.mode === 'live' ? 'The scout runs its first search shortly.' : 'No sources yet.'}</div>`;
  return s.sources.slice(-40).reverse().map((x) => `<div class="srcrow"><span class="kind">${x.kind}</span><span>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>` : esc(x.title)}<div class="dim" style="font-size:11px">${esc(x.topic)} · ${ago(x.t)}${x.summary ? ` · ${esc(x.summary)}` : ''}</div></span><span class="st-${x.status} mono" style="font-size:11px;text-align:right">${x.status}</span></div>`).join('');
}

function terms(s) {
  return s.terms.length ? s.terms.slice().reverse().map((t) => `<div class="srcrow" style="grid-template-columns:1fr 70px"><span>${esc(t.term)}<div class="dim" style="font-size:11px">${esc(t.source || '')}</div></span><span class="dim mono" style="font-size:11px;text-align:right">${ago(t.t)}</span></div>`).join('') : '<div class="empty">No new terms yet.</div>';
}

export default {
  mount(el, s) {
    root = el;
    el.innerHTML = `
      <div class="grid" style="grid-template-columns:2fr 1fr">
        <div class="panel"><div class="ph"><span class="t">Research galaxy</span><span class="s">one cluster per topic · one star per source · hover a star</span>
          <span class="r"><span style="color:#f87171">●</span> YouTube &nbsp;<span style="color:#a78bfa">●</span> GitHub &nbsp;<span style="color:#60a5fa">●</span> arXiv &nbsp;<span style="color:#4ade80">●</span> web</span></div>
          <div class="galaxy"><canvas id="gal"></canvas></div></div>
        <div class="grid" style="align-content:start">
          <div class="panel"><div class="ph"><span class="t">Reading</span></div><div class="pb" id="rs-read"></div></div>
          <div class="panel"><div class="ph"><span class="t">Queues</span></div><div class="pb" id="rs-q"></div></div>
          <div class="panel"><div class="ph"><span class="t">New terms</span><span class="s">from the terms checker</span></div><div class="pb" id="rs-terms" style="max-height:180px;overflow:auto"></div></div>
        </div>
      </div>
      <div class="panel" style="margin-top:12px"><div class="ph"><span class="t">Sources</span><span class="s">newest first</span><span class="r" id="rs-tot"></span></div><div class="pb" id="rs-list"></div></div>`;
    galaxy = new Galaxy($('#gal', el));
    this.update(s);
  },
  update(s) {
    if (!root) return;
    galaxy.set(s.sources, s.topics, s.reading);
    $('#rs-read', root).innerHTML = reading(s);
    $('#rs-q', root).innerHTML = queues(s);
    $('#rs-terms', root).innerHTML = terms(s);
    $('#rs-list', root).innerHTML = list(s);
    $('#rs-tot', root).textContent = `${s.research.mode === 'live' ? `live · ${s.research.kinds.join(', ')} · analyst: ${s.research.analyst} · ` : 'simulated · '}${num(s.counts.sources)} found · ${num(s.counts.read)} read · ${num(s.counts.sourceRejected)} rejected`;
  },
  unmount() { galaxy?.stop(); root = null; },
};
