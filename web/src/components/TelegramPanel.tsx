import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '@appdeploy/client';
import { CheckCircle2, Circle, Loader2, Send, RefreshCw } from 'lucide-react';
import { errorText } from '../lib/format';

type Status = {
  tokenAdded: boolean; botUsername: string; ownerLinked: boolean; ownerName: string;
  alertsOn: boolean; alertsSent: number; problem: string;
};

function Step({ done, children }: { done: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      {done ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-400" aria-hidden /> : <Circle size={16} className="mt-0.5 shrink-0 text-slate-600" aria-hidden />}
      <span className={done ? 'text-slate-300' : 'text-slate-400'}>{children}</span>
    </li>
  );
}

export default function TelegramPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'check' | 'test' | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/api/telegram');
      setStatus(data as Status);
      setError(null);
    } catch (e) {
      setError(`Could not read the Telegram status: ${errorText(e, 'please refresh.')}`);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function check() {
    setBusy('check');
    setNote(null);
    try {
      const { data } = await api.post('/api/telegram/check', {});
      setStatus(data.status as Status);
      setNote(data.answered ? `Answered ${data.answered} message(s).` : 'No new messages for the bot.');
    } catch (e) {
      setNote(`Could not check messages: ${errorText(e, 'please try again.')}`);
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy('test');
    setNote(null);
    try {
      await api.post('/api/telegram/test', {});
      setNote('Test message sent to your Telegram.');
    } catch (e) {
      setNote(errorText(e, 'Could not send the test message.'));
    } finally {
      setBusy(null);
    }
  }

  const s = status;
  return (
    <section aria-label="Telegram" data-testid="telegram-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-white">Telegram alerts</h3>
          <p className="text-xs text-slate-500">
            When the agent desk approves a setup (TAKE), the bot sends it to you. Ask it for a reading any time with
            {' '}<code className="text-slate-300">/signal BTCUSD 15m</code>. Commands are answered within 5 minutes.
          </p>
        </div>
        <span data-testid="telegram-state"
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${s?.ownerLinked && s.tokenAdded ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-500/15 text-slate-300'}`}>
          {!s ? 'Loading...' : !s.tokenAdded ? 'Not set up' : !s.ownerLinked ? 'Waiting for /start' : s.alertsOn ? 'Alerts on' : 'Alerts off'}
        </span>
      </div>
      {error && <p role="alert" className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
      {s && (
        <>
          <ol className="mt-4 space-y-2 text-sm">
            <Step done={s.tokenAdded}>Create a bot with @BotFather in Telegram and add its token to OS AI Trading (it is stored encrypted, never shown).</Step>
            <Step done={s.ownerLinked}>
              Open {s.botUsername ? <a className="text-sky-300 underline" href={`https://t.me/${s.botUsername}`} target="_blank" rel="noreferrer">@{s.botUsername}</a> : 'your bot'} and
              send <code className="text-slate-300">/start</code> - the first chat to do it owns the bot{s.ownerLinked && s.ownerName ? ` (now: ${s.ownerName})` : ''}.
            </Step>
            <Step done={s.ownerLinked && s.alertsOn}>Alerts are {s.alertsOn ? 'on' : 'off'} - switch them in Telegram with <code className="text-slate-300">/alerts on</code> or <code className="text-slate-300">/alerts off</code>.</Step>
          </ol>
          {s.problem && <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">Telegram said: {s.problem}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void check()} disabled={!s.tokenAdded || busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/10 disabled:opacity-40">
              {busy === 'check' ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />} Check messages now
            </button>
            <button type="button" onClick={() => void test()} disabled={!s.ownerLinked || busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-400 disabled:opacity-40">
              {busy === 'test' ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Send size={14} aria-hidden />} Send test message
            </button>
            <span className="text-xs text-slate-500">{s.alertsSent} alert(s) sent so far</span>
          </div>
          {note && <p role="status" className="mt-2 text-xs text-sky-300">{note}</p>}
        </>
      )}
    </section>
  );
}
