// Telegram bot for OS AI Trading (brought over from apex-signal-ai, minus its
// TradingView ratings). The bot token is an encrypted app secret.
//
// AppDeploy refuses Telegram's incoming webhooks, so the bot fetches its own
// messages with getUpdates from a 5-minute cron. The first private chat to send
// /start owns the bot; every other chat is told the bot is private. The web page
// shows status only - settings change from Telegram, by the owner.
import { secrets } from '@appdeploy/sdk';
import type { DeskReview } from './agents';
import type { Setup } from './analyze';
import { decimals, isCrypto, normPair, PAIRS, TIMEFRAMES } from './market';
import { getDoc, META, updateDoc } from './store';

const TOKEN_NAME = 'TELEGRAM_BOT_TOKEN';
const APP_URL = 'https://os-ai-trading-wg0h27.v2.appdeploy.ai/';

export type TgConfig = {
  ownerChatId: number | null;
  ownerName: string;
  alertsOn: boolean;
  offset: number;
  lastTestAt: number;
  alertsSent: number;
};

const DEFAULTS: TgConfig = { ownerChatId: null, ownerName: '', alertsOn: true, offset: 0, lastTestAt: 0, alertsSent: 0 };

type TgMessage = { message_id: number; text?: string; chat: { id: number; type: string; first_name?: string; title?: string } };
type TgUpdate = { update_id: number; message?: TgMessage };

export async function getToken(): Promise<string | null> {
  const names = await secrets.listSecretNames();
  if (!names.includes(TOKEN_NAME)) return null;
  const t = (await secrets.readSecret(TOKEN_NAME)).trim();
  return t || null;
}

export async function loadCfg(): Promise<TgConfig> {
  return { ...DEFAULTS, ...((await getDoc<Partial<TgConfig>>(META, 'telegram')) || {}) };
}

async function patchCfg(change: (c: TgConfig) => TgConfig): Promise<TgConfig> {
  return updateDoc<TgConfig>(META, 'telegram', DEFAULTS, (c) => change({ ...DEFAULTS, ...c }));
}

export async function tgCall<T>(token: string, method: string, payload: Record<string, unknown>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctrl.signal,
    });
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
    // never echo the token: Telegram's descriptions do not contain it, the URL does
    if (!body.ok) throw new Error(body.description || `Telegram error ${res.status}`);
    return body.result as T;
  } finally {
    clearTimeout(timer);
  }
}

const esc = (s: string | number) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function say(token: string, chatId: number, html: string): Promise<void> {
  await tgCall(token, 'sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true });
}

const label = (pair: string) => `${pair.slice(0, 3)}/${pair.slice(3)}`;

function dist(pair: string, pips: number | null | undefined): string {
  if (pips == null) return '';
  return isCrypto(pair) ? `$${pips}` : `${pips} pips`;
}

/** One setup as a Telegram message. Levels come from the engine, never from an agent. */
export function formatSetup(s: Setup, review: DeskReview | null): string {
  const p = s.pair;
  const f = (x: number | null | undefined) => (x == null ? '-' : `<code>${x.toFixed(decimals(p))}</code>`);
  const head = `<b>${esc(label(p))}</b> · ${esc(s.timeframe)}`;
  if (s.decision !== 'trade') {
    return `${head}\n<b>NO TRADE</b> at ${f(s.price)}\n${esc(s.reasons[s.reasons.length - 1] || '')}\n\n<a href="${APP_URL}">Open OS AI Trading</a>`;
  }
  const lines = [
    `${head}\n<b>${s.side === 'buy' ? '🟢 BUY' : '🔴 SELL'}</b> (${esc(s.entryType || '')} entry) · reward:risk 1:${s.rr}`,
    `Entry ${f(s.entry)}`,
    `Stop ${f(s.stop)}  -${esc(dist(p, s.stopPips))}`,
    `TP1 ${f(s.tp1)}  +${esc(dist(p, s.tp1Pips))}`,
  ];
  if (s.tp2 != null) lines.push(`TP2 ${f(s.tp2)}  +${esc(dist(p, s.tp2Pips))}`);
  if (review) {
    lines.push('', `<b>Agent desk: ${review.final.toUpperCase()}${review.final === 'take' ? ` ${review.confidence}%` : ''}</b>`);
    lines.push(esc(review.summary).slice(0, 400));
  }
  lines.push('', `<i>Rules-based reading of delayed data, not advice. Nothing is placed for you.</i>`, `<a href="${APP_URL}">Open OS AI Trading</a>`);
  return lines.join('\n');
}

const HELP = [
  '<b>OS AI Trading bot</b>',
  '/signal EURUSD 15m - read a market now (also: gold, bitcoin; 15m, 1h, 4h, 1d)',
  '/alerts on | off - agent-approved TAKE signals from the 15-minute scanner',
  '/status - what the bot is doing',
  '/help - this list',
].join('\n');

export type Analyzer = (pair: string, tf: string) => Promise<{ setup: Setup; review: DeskReview | null }>;

function parseSignalArgs(args: string[]): { pair: string; tf: string } | string {
  const tf = (args.find((a) => TIMEFRAMES[a.toLowerCase()]) || '15m').toLowerCase();
  const raw = args.filter((a) => !TIMEFRAMES[a.toLowerCase()]).join('');
  if (!raw) return `Which market? e.g. /signal EURUSD 15m\nMarkets: ${PAIRS.map(label).join(', ')}`;
  try {
    return { pair: normPair(raw), tf };
  } catch {
    return `I do not know "${esc(raw)}". Markets: ${PAIRS.map(label).join(', ')}`;
  }
}

async function handle(token: string, m: TgMessage, analyzeFn: Analyzer): Promise<void> {
  const text = (m.text || '').trim();
  if (!text.startsWith('/')) return;
  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase();
  let cfg = await loadCfg();
  if (cfg.ownerChatId === null && cmd === '/start' && m.chat.type === 'private') {
    cfg = await patchCfg((c) => ({ ...c, ownerChatId: m.chat.id, ownerName: m.chat.first_name || 'owner' }));
    await say(token, m.chat.id, `Linked. This chat now owns the bot, ${esc(cfg.ownerName)}.\n\n${HELP}`);
    return;
  }
  if (m.chat.id !== cfg.ownerChatId) {
    await say(token, m.chat.id, 'This bot is private.');
    return;
  }
  if (cmd === '/start' || cmd === '/help') {
    await say(token, m.chat.id, HELP);
  } else if (cmd === '/alerts') {
    const on = (args[0] || '').toLowerCase();
    if (on !== 'on' && on !== 'off') {
      await say(token, m.chat.id, `Alerts are ${cfg.alertsOn ? 'ON' : 'OFF'}. Use /alerts on or /alerts off.`);
      return;
    }
    await patchCfg((c) => ({ ...c, alertsOn: on === 'on' }));
    await say(token, m.chat.id, on === 'on'
      ? 'Alerts ON. You will get each setup the agent desk approves (TAKE) from the 15-minute scanner.'
      : 'Alerts OFF.');
  } else if (cmd === '/status') {
    await say(token, m.chat.id, `Alerts: ${cfg.alertsOn ? 'ON' : 'OFF'} · alerts sent: ${cfg.alertsSent}\n`
      + `The scanner reads EUR/USD, gold, BTC/USD, GBP/USD and USD/JPY on 15m and 1h every 15 minutes.\n<a href="${APP_URL}">Open OS AI Trading</a>`);
  } else if (cmd === '/signal') {
    const parsed = parseSignalArgs(args);
    if (typeof parsed === 'string') {
      await say(token, m.chat.id, parsed);
      return;
    }
    try {
      const { setup, review } = await analyzeFn(parsed.pair, parsed.tf);
      await say(token, m.chat.id, formatSetup(setup, review));
    } catch (e) {
      await say(token, m.chat.id, `Could not read ${esc(label(parsed.pair))}: ${esc(e instanceof Error ? e.message : 'error')}`);
    }
  } else {
    await say(token, m.chat.id, `Unknown command.\n\n${HELP}`);
  }
}

/** Fetch new bot messages and answer them; keeps the getUpdates offset in the config. */
export async function pollCommands(analyzeFn: Analyzer): Promise<number> {
  const token = await getToken();
  if (!token) return 0;
  const cfg = await loadCfg();
  const ups = await tgCall<TgUpdate[]>(token, 'getUpdates', { offset: cfg.offset, timeout: 0, allowed_updates: ['message'] });
  let handled = 0;
  for (const u of ups) {
    await patchCfg((c) => ({ ...c, offset: Math.max(c.offset, u.update_id + 1) }));
    if (!u.message) continue;
    try {
      await handle(token, u.message, analyzeFn);
      handled++;
    } catch (e) {
      console.warn('telegram reply failed', e instanceof Error ? e.message : e);
    }
  }
  return handled;
}

/** Send an agent-approved setup to the owner, if alerts are on. */
export async function alertTake(setup: Setup, review: DeskReview): Promise<boolean> {
  const token = await getToken();
  if (!token) return false;
  const cfg = await loadCfg();
  if (cfg.ownerChatId === null || !cfg.alertsOn) return false;
  await say(token, cfg.ownerChatId, `🔔 <b>New setup approved by the agent desk</b>\n\n${formatSetup(setup, review)}`);
  await patchCfg((c) => ({ ...c, alertsSent: c.alertsSent + 1 }));
  return true;
}

export async function telegramStatus() {
  const token = await getToken();
  const cfg = await loadCfg();
  const out = { tokenAdded: Boolean(token), botUsername: '', ownerLinked: cfg.ownerChatId !== null, ownerName: cfg.ownerName,
    alertsOn: cfg.alertsOn, alertsSent: cfg.alertsSent, problem: '' };
  if (token) {
    try {
      out.botUsername = (await tgCall<{ username: string }>(token, 'getMe', {})).username;
    } catch (e) {
      out.problem = e instanceof Error ? e.message : 'Telegram did not answer';
    }
  }
  return out;
}

/** A test message to the owner - at most one a minute, since the page is public. */
export async function sendTest(): Promise<string> {
  const token = await getToken();
  if (!token) return 'Add your bot token first.';
  const cfg = await loadCfg();
  if (cfg.ownerChatId === null) return 'Send /start to your bot in Telegram first.';
  if (Date.now() - cfg.lastTestAt < 60_000) return 'A test was sent less than a minute ago.';
  await patchCfg((c) => ({ ...c, lastTestAt: Date.now() }));
  await say(token, cfg.ownerChatId, `✅ OS AI Trading is connected. Alerts are ${cfg.alertsOn ? 'ON' : 'OFF'}.\n\n${HELP}`);
  return 'sent';
}
