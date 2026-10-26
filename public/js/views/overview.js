import { $, $$, esc, num, pct, usd, time, spark, post } from '../ui.js';
import { Sphere, drawFan } from '../charts.js';

const SRC = [['youtube', 'YOUTUBE'], ['github', 'GITHUB'], ['arxiv', 'ARXIV'], ['web', 'WEB']];
const OUT = [['thought', 'THOUGHT UP', 'recipes thought up', 'recipes'], ['tested', 'VARIANTS TESTED', 'tests in the lab', 'variants'], ['validated', 'VALIDATED', 'recipes validated', 'validated']];

let sphere, prev, root;

export function decisionCard(d) {
  const kind = { paper: 'TO PAPER', live: 'TO LIVE', skill: 'SKILL PROPOSAL' }[d.kind];
  const done = d.status !== 'pending';
  return `<div class="decision ${done ? 'done' : ''}" data-id="${d.id}">
    <div class="kind">${kind}${done ? ` · ${d.status.toUpperCase()}` : ''}</div>
    <h4>${esc(d.title)}</h4><p>${esc(d.body)}</p>
    ${done ? '' : `<button class="btn go" data-act="approve">Approve</button> <button class="btn" data-act="reject">Back</button>`}
  </div>`;
}

export function bindDecisions(el) {
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    b.disabled = true;
    await post(`/api/decisions/${b.closest('.decision').dataset.id}`, { action: b.dataset.act });
    window.dispatchEvent(new Event('brain:refresh'));
  });
}

function kpis(s) {
  const c = s.counts;
  const k = (label, v, n, extra = '') => `<div class="kpi"><div class="lbl">${label}</div><div class="v">${v}</div><div class="n">${n}</div>${extra}</div>`;
  const paperDay = s.paper.filter((p) => p.status === 'paper').sort((a, b) => b.day - a.day)[0];
  return k('Thought up', num(c.recipes), 'recipes')
    + k('Tested', num(c.tested), `${pct(c.tested / Math.max(1, c.recipes), 0)} of thought up`)
    + k('<span class="green">●</span> Passed lab', num(c.sieved), `${pct(c.sieved / Math.max(1, c.tested), 0)} of tested`)
    + k('<span class="green">●</span> Validated', num(c.validated), `${pct(c.validated / Math.max(1, c.sieved), 0)} of passed lab`)
    + k('On paper', num(c.onPaper), paperDay ? `day ${paperDay.day} of ${paperDay.days}` : 'none yet',
      paperDay ? `<div class="meter"><i style="width:${(paperDay.day / paperDay.days) * 100}%"></i></div>` : '')
    + k('Live', c.live ? num(c.live) : '—', '', c.live ? '' : '<span class="wait">waiting on you</span>')
    + k('Profit live', c.live ? usd(c.liveNet) : '—', '', c.live ? '' : '<span class="wait">not started yet</span>')
    + k('Thinking budget', `${usd(s.budget.spent, 2)}<small>/$${s.budget.limit}</small>`, `$${s.budget.perHour.toFixed(2)} per hour at this pace`,
      `<div class="meter"><i style="width:${Math.min(100, (s.budget.spent / s.budget.limit) * 100)}%"></i></div>`);
}

function coreCols(s) {
  const left = SRC.map(([k, l]) => `<div class="src" data-src="${k}"><div class="top">${l}<b>${s.sourceTotals[k]}</b></div>${spark(s.buckets[k], { w: 132, h: 18 })}</div>`).join('');
  const right = OUT.map(([k, l, sub, ck]) => `<div class="src" data-out="${k}"><div class="top">${l}<b>${num(s.counts[ck])}</b></div><div class="sub">${sub}</div>${spark(s.buckets[k], { w: 132, h: 16, color: '#4ade80' })}</div>`).join('');
  return { left, right };
}

function pipeline(s) {
  const c = s.counts, st = s.sourceTotals;
  const nodes = [
    ['Read', c.read, 26], ['Summarized', c.summarized, 37], ['Thought up', c.recipes, 48],
    ['Tested', c.tested, 59, `${num(c.variants)} variants`], ['Passed lab', c.sieved, 70], ['Validated', c.validated, 81], ['On paper', c.paper, 92],
  ];
  const drops = [['Rejected', c.sourceRejected, 31.5], ['Dropped', c.labFailed, 59, 'in the lab'], ['Failed', c.sieveFailed, 75.5, 'in the sieve']];
  const srcY = [18, 40, 62, 84];
  const svgLines = SRC.map((_, i) => `<path d="M7,${srcY[i]} C14,${srcY[i]} 16,45 26,45" stroke="#2b3542" fill="none"/>`).join('')
    + `<line x1="26" y1="45" x2="92" y2="45" stroke="#2b3542"/>`
    + drops.map(([, , x]) => `<line x1="${x}" y1="45" x2="${x}" y2="75" stroke="#2b3542" stroke-dasharray="1.5 1.5"/>`).join('');
  const node = (label, v, x, y, sub, color = '#60a5fa') => `<div style="position:absolute;left:${x}%;top:${y}%;transform:translate(-50%,-50%);text-align:center">
      <div style="width:12px;height:12px;border-radius:50%;border:2px solid ${color};margin:0 auto 4px;background:#0c0f13;box-shadow:0 0 8px ${color}55"></div>
      <div class="lbl">${label}</div><div class="mono" style="font-size:13px">${num(v)}</div>${sub ? `<div class="dim" style="font-size:10px">${sub}</div>` : ''}</div>`;
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none">${svgLines}</svg>`
    + SRC.map(([k, l], i) => `<div style="position:absolute;left:1%;top:${srcY[i]}%;transform:translateY(-50%);display:flex;gap:8px;align-items:center"><div style="width:10px;height:10px;border-radius:50%;border:2px solid #60a5fa"></div><span class="lbl">${l}</span><span class="mono">${st[k]}</span></div>`).join('')
    + nodes.map(([l, v, x, sub], i) => node(l, v, x, 30, sub, i >= 5 ? '#4ade80' : i === 4 ? '#f5a524' : i === 3 ? '#e5e9ee' : '#60a5fa')).join('')
    + drops.map(([l, v, x, sub]) => node(l, v, x, 80, sub, '#5d6773')).join('');
}

function logbook(s) {
  return s.log.slice(-12).reverse().map((l) => `<div class="ln"><span class="dim">${time(l.t)}</span><span class="k-${l.kind}">${l.kind}</span><span>${esc(l.text)}</span></div>`).join('');
}

function variantsTable(s) {
  return `<table><tr><th>Variant</th><th>Pair</th><th class="num">Sharpe IS</th><th class="num">Trades</th><th class="num">Net</th></tr>
    ${s.variants.slice(-9).reverse().map((v) => `<tr class="click" onclick="location.hash='#/strategies/${v.strategyId}'"><td>${esc(v.name)}</td><td class="dim">${v.symbol}</td><td class="num ${v.passed ? 'green' : ''}">${v.sharpe.toFixed(2)}</td><td class="num">${v.trades}</td><td class="num ${v.net >= 0 ? 'green' : 'red'}">${usd(v.net)}</td></tr>`).join('')}</table>`;
}

function report(s) {
  const r = s.report;
  if (!r) return `<div class="pb" style="text-align:center"><span class="chip">not measured yet</span><p class="dim">Every morning Hermes's report appears here: what came in, what it cost, what stood out and his proposals.</p></div>`;
  return `<div class="pb grid" style="grid-template-columns:repeat(4,1fr)">
    <div><div class="lbl">Came in</div><p>${esc(r.cameIn)}</p></div>
    <div><div class="lbl">Cost</div><p>${esc(r.cost)}</p></div>
    <div><div class="lbl">Stood out</div><p>${esc(r.stoodOut)} ${esc(r.topic)}</p></div>
    <div><div class="lbl">Proposals</div><p>${r.proposals} waiting for you. <a href="#/decisions" class="green">Open decisions →</a></p></div></div>`;
}

export default {
  mount(el, s) {
    root = el;
    const cols = coreCols(s);
    el.innerHTML = `
      <div class="kpis" id="ov-kpis">${kpis(s)}</div>
      <div class="panel" style="margin-top:12px">
        <div class="ph"><span class="t">Brain core</span><span class="s">today · sources stream in, recipes and variants come out</span><span class="r"><i class="dot on"></i> brain running</span></div>
        <div class="core" id="core">
          <canvas></canvas>
          <div class="now" id="core-now"></div>
          <div class="col left"><div class="head"><span>SOURCES TODAY</span><span id="src-total"></span></div><div id="core-left">${cols.left}</div></div>
          <div class="col right"><div class="head"><span>OUTPUT TODAY</span></div><div id="core-right">${cols.right}</div></div>
          <div class="reading" id="core-reading"></div>
          <div class="legend"><span><i style="background:#60a5fa"></i>source or reading step</span><span><i style="background:#e5e9ee"></i>recipe or variant</span><span><i style="background:#f5a524"></i>through the lab</span><span><i style="background:#4ade80"></i>validated</span><span><i style="background:#f05252"></i>error</span>
            <span style="margin-left:auto">EVENTS PER MINUTE · LAST HALF HOUR</span><span class="activity" id="core-act"></span></div>
        </div>
      </div>
      <div class="panel" style="margin-top:12px"><div class="ph"><span class="t">Hermes report</span><span class="s">what came in, what it cost, what stood out</span></div><div id="ov-report">${report(s)}</div></div>
      <div class="grid" style="grid-template-columns:2fr 1fr;margin-top:12px">
        <div class="panel"><div class="ph"><span class="t">Pipeline</span><span class="s">total since start · source to paper</span><span class="r" id="pipe-r"></span></div>
          <div class="pipe" id="ov-pipe">${pipeline(s)}</div>
          <div class="ph" style="border-top:1px solid var(--line)"><span class="lbl">Logbook · activity</span><span class="r">what the brain does, step by step</span></div>
          <div class="pb logbook" id="ov-log">${logbook(s)}</div></div>
        <div class="panel"><div class="ph"><span class="t">Your decisions</span><span class="r amber" id="dec-count"></span></div><div class="pb" id="ov-dec"></div></div>
      </div>
      <div class="grid" style="grid-template-columns:1.4fr 1fr;margin-top:12px">
        <div class="panel"><div class="ph"><span class="t">Equity curves</span><span class="s">live · last 100 variants</span><a class="r" href="#/lab">Open the lab →</a></div><canvas class="chart" id="ov-fan" style="height:260px"></canvas></div>
        <div class="panel"><div class="ph"><span class="t">Latest variants</span><span class="s">from the lab, newest first</span></div><div id="ov-var">${variantsTable(s)}</div></div>
      </div>`;

    const core = $('#core', el);
    sphere = new Sphere($('canvas', core), () => {
      const base = core.getBoundingClientRect();
      const pt = (n, side) => {
        const r = n.getBoundingClientRect();
        return { x: (side === 'in' ? r.right : r.left) - base.left, y: r.top + r.height / 2 - base.top };
      };
      return { inputs: $$('[data-src]', core).map((n) => pt(n, 'in')), outputs: $$('[data-out]', core).map((n) => pt(n, 'out')) };
    });
    bindDecisions($('#ov-dec', el));
    prev = s;
    this.update(s);
  },

  update(s) {
    if (!root) return;
    $('#ov-kpis', root).innerHTML = kpis(s);
    const cols = coreCols(s);
    $('#core-left', root).innerHTML = cols.left;
    $('#core-right', root).innerHTML = cols.right;
    $('#src-total', root).textContent = `Σ ${Object.values(s.sourceTotals).reduce((a, b) => a + b, 0)}`;
    const lab = s.agents.find((a) => a.id === 'lab');
    $('#core-now', root).innerHTML = `<b>NOW</b>${esc(lab.task || 'the lab is waiting for recipes')}`;
    const rd = s.reading;
    $('#core-reading', root).innerHTML = rd ? `<b>READING</b>${esc(rd.title)}${rd.kind === 'youtube' && !rd.live && rd.progress ? ` · min ${Math.min(rd.progress, rd.size)} of ${rd.size}` : ''}` : '';
    const mx = Math.max(1, ...s.activity);
    $('#core-act', root).innerHTML = s.activity.map((n) => `<i style="height:${(n / mx) * 100}%"></i>`).join('');
    $('#ov-report', root).innerHTML = report(s);
    $('#ov-pipe', root).innerHTML = pipeline(s);
    $('#pipe-r', root).textContent = `${num(s.counts.sources)} sources · ${num(s.counts.recipes)} recipes`;
    $('#ov-log', root).innerHTML = logbook(s);
    const pend = s.decisions.filter((d) => d.status === 'pending');
    $('#dec-count', root).textContent = `${pend.length} waiting on you`;
    $('#ov-dec', root).innerHTML = pend.length ? pend.slice(-3).reverse().map(decisionCard).join('') : '<div class="empty">Nothing to decide right now.</div>';
    $('#ov-var', root).innerHTML = variantsTable(s);
    drawFan($('#ov-fan', root), s.variants);

    if (prev && prev !== s) {
      SRC.forEach(([k], i) => sphere.pulse('in', i, s.sourceTotals[k] - prev.sourceTotals[k]));
      OUT.forEach(([, , , ck], i) => sphere.pulse('out', i, Math.ceil((s.counts[ck] - prev.counts[ck]) / (ck === 'variants' ? 10 : 1))));
    }
    prev = s;
  },

  unmount() { sphere?.stop(); root = null; },
};
