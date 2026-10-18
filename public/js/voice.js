// Voice control: speak to OS AI and hear it answer. Uses the browser's built-in speech recognition
// and speech synthesis (Chrome, Edge, Safari). Commands run here; any other question goes to the
// server's assistant (/api/ask). Anything that risks money needs a spoken "yes", and arming real
// trading or approving a live strategy is refused by voice: do those on screen.
import { $, post } from './ui.js';

const PAGES = {
  overview: 'overview', home: 'overview', dashboard: 'overview', lab: 'lab', research: 'research',
  strategies: 'strategies', strategy: 'strategies', knowledge: 'knowledge', 'knowledge base': 'knowledge',
  'agent room': 'room', agents: 'room', room: 'room', paper: 'paper', live: 'paper', trading: 'paper',
  decisions: 'decisions', costs: 'costs', budget: 'costs', machines: 'machines', data: 'machines',
};

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const EMBEDDED = window.top !== window.self;
let rec = null, listening = false, speaking = false, state = null, pending = null, announce = false, lastLogT = 0, restartTimer = 0;

// Commands are English, so recognise English even when the browser is set to another language.
const LANG = /^en\b/i.test(navigator.language || '') ? navigator.language : 'en-GB';

// Prefer the most natural English voice the device has (neural voices in Edge and Chrome, Siri voices
// on Apple). "Change voice" steps through the rest; the choice is remembered on this device.
const GOOD = [/natural/i, /neural/i, /online/i, /google uk english female/i, /google us english/i, /siri/i, /samantha|daniel|serena|karen|moira/i, /google/i];
let voices = [], voiceIdx = -1;
function loadVoices() {
  if (!window.speechSynthesis?.getVoices) return;
  voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
  const rank = (v) => { const i = GOOD.findIndex((r) => r.test(v.name)); return i < 0 ? GOOD.length : i; };
  voices.sort((a, b) => rank(a) - rank(b) || (b.lang === LANG) - (a.lang === LANG));
  let saved = null;
  try { saved = localStorage.getItem('osai-voice'); } catch { /* storage blocked */ }
  const i = voices.findIndex((v) => v.name === saved);
  voiceIdx = i >= 0 ? i : voices.length ? 0 : -1;
}
function nextVoice() {
  if (!voices.length) return null;
  voiceIdx = (voiceIdx + 1) % voices.length;
  try { localStorage.setItem('osai-voice', voices[voiceIdx].name); } catch { /* storage blocked */ }
  return voices[voiceIdx].name;
}

// Speak a reply. The microphone is paused while OS AI talks so it never hears itself and
// mistakes its own answer for a new command.
function say(text) {
  show(text);
  if (!window.speechSynthesis) return;
  speechSynthesis.cancel();
  speaking = true;
  pauseMic();
  const parts = text.split(/(?<=[.?!])\s+/).filter(Boolean); // split at sentence ends, not decimal points // Chrome cuts long utterances, so speak sentence by sentence
  parts.forEach((part, i) => {
    const u = new SpeechSynthesisUtterance(part.trim());
    u.lang = LANG;
    if (voices[voiceIdx]) { u.voice = voices[voiceIdx]; u.lang = voices[voiceIdx].lang; }
    u.rate = 1.03;
    if (i === parts.length - 1) u.onend = u.onerror = () => { speaking = false; resumeMic(); };
    setTimeout(() => speechSynthesis.speak(u), 0); // speaking straight after cancel() is dropped in Chrome
  });
}

function show(text, heard) {
  const el = $('#voice-text');
  if (!el) return;
  el.textContent = heard ? `"${heard}"` : text;
  el.title = el.textContent;
  el.classList.toggle('heard', !!heard);
}

function status(s) {
  const c = s.counts, b = s.bridge;
  const waiting = s.decisions.filter((d) => d.status === 'pending').length;
  const live = !b?.configured ? 'no exchange is connected' : b.armed ? `live trading on ${b.name} is armed` : 'live trading is disarmed';
  return `${c.recipes} recipes tested ${c.tested} times, ${c.validated} validated, ${c.onPaper} on paper. `
    + `${waiting} decision${waiting === 1 ? '' : 's'} waiting for you. ${live}. `
    + `Thinking budget used: ${s.budget.spent.toFixed(2)} of ${s.budget.limit} dollars.`;
}

const HELP = 'You can say: status. Go to lab, research, strategies, knowledge, agent room, paper, decisions, costs or machines. '
  + 'Read decisions. Approve, or reject. Kill switch. Announcements on, or off. Change voice. Stop listening. '
  + 'Or just ask a question, like: what is gold at, which strategy is best, or how are the paper trades doing.';

export async function handle(raw) {
  const t = raw.toLowerCase().replace(/[.!?,]/g, '').trim();
  if (!t) return;
  show('', raw);
  if (!state) return say('Still connecting to OS AI. Try again in a moment.');

  if (pending) {
    const p = pending;
    pending = null;
    if (/^(yes|yeah|confirm|do it|go ahead)\b/.test(t)) return p.run();
    return say('Cancelled.');
  }
  if (/\b(help|what can i say|commands)\b/.test(t)) return say(HELP);
  if (/\b(stop listening|go to sleep|mute)\b/.test(t)) { stop(); return say('Voice off.'); }
  if (/\b(change|next|another|different) voice\b/.test(t)) { const v = nextVoice(); return say(v ? `This is ${v.replace(/\s*\(.*\)/, '')}.` : 'This device has no other English voices.'); }
  if (/\bannouncements? (on|off)\b/.test(t)) { announce = /on$/.test(t); return say(`Announcements ${announce ? 'on' : 'off'}.`); }
  if (/^(status|report|summary|how are we doing|give me (a |the )?(status|summary|report))$/.test(t)) return say(status(state));

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
    pending = { run: async () => {
      if (!(await post(`/api/decisions/${d.id}`, { action: verb }))) return say('That did not go through. It may already be decided; check the Decisions page.');
      window.dispatchEvent(new Event('brain:refresh'));
      say(`${verb === 'approve' ? 'Approved' : 'Rejected'}: ${d.title}.`);
    } };
    return say(`${verb === 'approve' ? 'Approve' : 'Reject'} ${d.title}? Say yes to confirm.`);
  }

  if (/\b(kill switch|stop (all )?trading|close everything)\b/.test(t)) {
    if (!state.bridge?.configured) return say('No exchange is connected, so there is nothing to stop.');
    pending = { run: async () => {
      if (!(await post('/api/live/kill', {}))) return say('The kill switch did not go through. Press it on the Paper and live page now.');
      window.dispatchEvent(new Event('brain:refresh'));
      say('Kill switch on. Trading stopped and every coin OS AI bought is being sold.');
    } };
    return say('Stop all live trading and sell every coin OS AI bought? Say yes to confirm.');
  }
  if (/\barm\b/.test(t)) return say('For safety, arm live trading on screen, on the Paper and live page.');

  return ask(raw);
}

async function ask(question) {
  show('Thinking…');
  try {
    const r = await fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: question }) });
    const { answer, error } = await r.json();
    return say(answer || error || 'I have no answer for that.');
  } catch {
    return say('I could not reach OS AI. Check your connection and try again.');
  }
}

const ERRORS = {
  'not-allowed': EMBEDDED
    ? 'Microphone is blocked inside this page. Open OS AI in its own tab at app.ostradingai.com, or type a command.'
    : 'Microphone access is blocked. Click the lock icon in the address bar, allow the microphone, then try again.',
  'service-not-allowed': 'This browser does not allow speech recognition here. Use Chrome or Edge, or type a command.',
  'audio-capture': 'No microphone was found. Plug one in, or type a command.',
  network: 'Speech recognition needs an internet connection. Type a command instead.',
};

function start() {
  rec = new Recognition();
  rec.lang = LANG;
  rec.continuous = false; // one phrase per session, restarted after each: steadier on Safari and Android
  rec.interimResults = true; // show words as they are heard; act only on the final result
  rec.maxAlternatives = 1;
  rec.onresult = (e) => {
    if (speaking) return;
    const r = e.results[e.results.length - 1];
    if (!r.isFinal) return show('', `${r[0].transcript}…`);
    handle(r[0].transcript).catch((err) => say(`Something went wrong: ${err.message}`));
  };
  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return; // silence: just listen again
    stop();
    say(ERRORS[e.error] || `Voice stopped: ${e.error}. Type a command instead.`);
  };
  rec.onend = () => resumeMic();
  listening = true;
  $('#voice-btn').classList.add('on');
  $('#voice-input').hidden = false;
  say('Listening. Say help to hear what I can do.');
}

function pauseMic() {
  clearTimeout(restartTimer);
  try { rec?.abort(); } catch { /* not running */ }
}

function resumeMic() {
  clearTimeout(restartTimer);
  if (!listening || speaking || !rec) return;
  restartTimer = setTimeout(() => { try { rec.start(); } catch { /* already running */ } }, 250);
}

function stop() {
  listening = false;
  pauseMic();
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
  const btn = $('#voice-btn'), input = $('#voice-input');
  if (!btn) return;
  loadVoices();
  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = loadVoices;
  // Keyboard: V turns the microphone on or off, / jumps to the typed command box.
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    if (e.key === '/') { e.preventDefault(); input.hidden = false; input.focus(); }
    else if (e.key.toLowerCase() === 'v' && !btn.disabled) btn.click();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const cmd = input.value;
    input.value = '';
    handle(cmd).catch((err) => say(`Something went wrong: ${err.message}`));
  });
  if (!Recognition) {
    btn.title = 'This browser cannot listen (use Chrome, Edge or Safari). Click to type commands instead.';
    btn.addEventListener('click', () => {
      input.hidden = !input.hidden;
      if (!input.hidden) { input.focus(); show('This browser cannot listen. Type a command, e.g. status or help.'); }
    });
    return;
  }
  btn.addEventListener('click', () => (listening ? (stop(), say('Voice off.')) : start()));
}
