import { $ } from '../ui.js';
import { decisionCard, bindDecisions } from './overview.js';

let root;

export default {
  mount(el, s) {
    root = el;
    el.innerHTML = `<div class="grid" style="grid-template-columns:1fr 1fr;align-items:start">
      <div class="panel"><div class="ph"><span class="t">Waiting on you</span><span class="r amber" id="dc-n"></span></div><div class="pb" id="dc-p"></div></div>
      <div class="panel"><div class="ph"><span class="t">Decided</span></div><div class="pb" id="dc-d"></div></div></div>`;
    bindDecisions($('#dc-p', el));
    this.update(s);
  },
  update(s) {
    if (!root) return;
    const pend = s.decisions.filter((d) => d.status === 'pending').reverse();
    const done = s.decisions.filter((d) => d.status !== 'pending').reverse();
    $('#dc-n', root).textContent = `${pend.length} pending`;
    $('#dc-p', root).innerHTML = pend.length ? pend.map(decisionCard).join('') : '<div class="empty">Nothing to decide.</div>';
    $('#dc-d', root).innerHTML = done.length ? done.map(decisionCard).join('') : '<div class="empty">No decisions yet.</div>';
  },
  unmount() { root = null; },
};
