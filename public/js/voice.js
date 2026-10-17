// Voice control: speak to OS AI and hear it answer. Uses the browser's built-in speech recognition
// and speech synthesis (Chrome, Edge, Safari). Anything that risks money needs a spoken "yes" and
// arming real trading or approving a live strategy is refused by voice: do those on screen.
import { $, post } from './ui.js';

const PAGES = {
  overview: 'overview', home: 'overview', dashboard: 'overview', lab: 'lab', research: 'research',
  strategies: 'strategies', strategy: 'strategies', knowledge: 'knowledge', 'knowledge base': 'knowledge',
  'agent room': 'room', agents: 'room', room: 'room', paper: 'paper', live: 'paper', trading: 'paper',
  decisions: 'decisions', costs: 'costs', budget: 'costs', machines: 'machines', data: 'machines',
};

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false, state = null, pending = null, announce = false, lastLogT = 0;

function say(text) {
  if (!window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.03;
  speechSynthesis.speak(u);
  show(text);
}

function show(text, heard) {
  const el = $('#voice-text');
  if (!el) return;
  el.textContent = heard ? `"${heard}"` : text;
  el.classList.toggle('heard', !!heard);
}

function status(s) {
  const c = s.counts, b = s.bridge;
  const waiting = s.decisions.filter((d) => d.status === 'pending').length;
  const live = !b?.configured ? 'MetaTrader is not connected' : b.armed ? 'live trading is armed' : 'live trading is disarmed';
  return `${c.recipes} recipes tested ${c.tested} times, ${c.validated} validated, ${c.onPaper} on paper. `
    + `${waiting} decision${waiting === 1 ? '' : 's'} waiting for you. ${live}. `
    + `Thinking budget used: ${s.budget.spent.toFixed(2)} of ${s.budget.limit} dollars.`;
}

const HELP = 'You can say: status. Go to lab, research, strategies, knowledge, agent room, paper, decisions, costs or machines. '
  + 'Read decisions. Approve, or reject. Kill switch. Announcements on, or off. Stop listening.';

export async function handle(raw) {
  const t = raw.toLowerCase().replace(/[.!?,]/g, '').trim();
  show('', raw);

  if (pending) {
    const p = pending;
    pending = null;
    if (/^(yes|yeah|confirm|do it|go ahead)\b/.test(t)) return p.run();
    return say('Cancelled.');
  }
  if (/\b(help|what can i say|commands)\b/.test(t)) return say(HELP);
  if (/\b(stop listening|go to sleep|mute)\b/.test(t)) { stop(); return say('Voice off.'); }
  if (/\bannouncements? (on|off)\b/.test(t)) { announce = /on$/.test(t); return say(`Announcements ${announce ? 'on' : 'off'}.`); }
  if (/\b(status|report|how are we doing|summary)\b/.test(t)) return say(status(state));

  const nav = t.match(/\b(?:go to|open|show(?: me)?|switch to)\s+(?:the\s+)?(.+)$/);
  if (nav) {
    const page = PAGES[nav[1].replace(/\s+(page|screen|tab)$/, '')];
    if (page) { location.hash = `#/${page}`; return say(`Opening ${nav[1]}.`); }
    return say(`I don't know the page ${nav[1]}.`);
  }

  const waiting = state.decisions.filter((d) => d.status === 'pending');
  if (/\bread (the )?decisions\b|\bwhat('s| is) waiting\b/.test(t)) {
    if (!waiting.length) return say('Nothing is waiting for you.');
    return say(waiting.slice(-5).reverse().map((d, i) => `${i + 1}. ${d.kind === 'skill' ? 'Skill' : d.kind === 'live' ? 'To live' : 'To paper'}: ${d.title}.`).join(' '));
  }

  const verb = t.match(/\b(approve|reject)\b/)?.[1];
  if (verb) {
    const d = waiting.at(-1);
    if (!d) return say('Nothing is waiting for you.');
    if (d.kind === 'live' && verb === 'approve') return say(`${d.title} would trade real money. Approve it on screen, under Decisions.`);
    pending = { run: async () => { await post(`/api/decisions/${d.id}`, { action: verb }); window.dispatchEvent(new Event('brain:refresh')); say(`${verb === 'approve' ? 'Approved' : 'Rejected'}: ${d.title}.`); } };
    return say(`${verb === 'approve' ? 'Approve' : 'Reject'} ${d.title}? Say yes to confirm.`);
  }

  if (/\b(kill switch|stop (all )?trading|close everything)\b/.test(t)) {
    if (!state.bridge?.configured) return say('MetaTrader is not connected, so there is nothing to stop.');
    pending = { run: async () => { await post('/api/bridge/kill', {}); window.dispatchEvent(new Event('brain:refresh')); say('Kill switch on. Trading stopped and all OS AI positions are being closed.'); } };
    return say('Stop all live trading and close every OS AI position? Say yes to confirm.');
  }
  if (/\barm\b/.test(t)) return say('For safety, arm live trading on screen, on the Paper and live page.');

  return say(`Sorry, I didn't catch a command in "${raw}". Say help to hear what I can do.`);
}

function start() {
  if (!Recognition) return;
  rec = new Recognition();
  rec.lang = navigator.language || 'en-US';
  rec.continuous = true;
  rec.interimResults = false;
  rec.onresult = (e) => {
    const r = e.results[e.results.length - 1];
    if (r.isFinal) handle(r[0].transcript).catch((err) => say(`Something went wrong: ${err.message}`));
  };
  rec.onerror = (e) => { if (e.error === 'not-allowed') { stop(); say('Microphone access was blocked. Allow it in the browser to use voice.'); } };
  rec.onend = () => { if (listening) try { rec.start(); } catch { /* already restarting */ } };
  listening = true;
  rec.start();
  $('#voice-btn').classList.add('on');
  say('Listening. Say help to hear what I can do.');
}

function stop() {
  listening = false;
  try { rec?.stop(); } catch { /* not running */ }
  $('#voice-btn')?.classList.remove('on');
}

// Called with every new state from the server; speaks new decisions and orders when announcements are on.
export function voiceState(s) {
  const first = !state;
  state = s;
  if (first) { lastLogT = s.log.at(-1)?.t || 0; return; }
  const fresh = s.log.filter((l) => l.t > lastLogT);
  if (fresh.length) lastLogT = fresh.at(-1).t;
  if (!announce) return;
  const worth = fresh.filter((l) => ['PROPOSAL', 'ORDER', 'LIVE', 'BUDGET'].includes(l.kind)).at(-1);
  if (worth && !speechSynthesis.speaking) say(worth.text);
}

export function initVoice() {
  const btn = $('#voice-btn');
  if (!btn) return;
  if (!Recognition) {
    btn.disabled = true;
    btn.title = 'Voice needs Chrome, Edge or Safari';
    return;
  }
  btn.addEventListener('click', () => (listening ? (stop(), say('Voice off.')) : start()));
}
