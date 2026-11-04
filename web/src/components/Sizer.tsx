import { useEffect, useState, type FormEvent } from 'react';
import { api } from '@appdeploy/client';
import { Calculator } from 'lucide-react';
import type { Setup, SizeResult } from '../lib/types';
import { errorText, money, pairLabel } from '../lib/format';

type Props = { pair: string; setup: Setup | null };

const field = 'mt-1 w-full rounded-lg border border-white/10 bg-[#0b0f17] px-3 py-2 font-mono text-sm text-slate-100 focus:border-blue-500 focus:outline-none';

export default function Sizer({ pair, setup }: Props) {
  const [entry, setEntry] = useState('');
  const [stop, setStop] = useState('');
  const [target, setTarget] = useState('');
  const [account, setAccount] = useState('10000');
  const [risk, setRisk] = useState('1');
  const [leverage, setLeverage] = useState('30');
  const [result, setResult] = useState<SizeResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Once the user types, live refreshes stop overwriting their numbers (until they switch market).
  const [edited, setEdited] = useState(false);

  // A new market starts clean: another pair's prices would size the wrong thing.
  useEffect(() => {
    setEdited(false);
    setEntry('');
    setStop('');
    setTarget('');
    setResult(null);
    setErr(null);
  }, [pair]);

  // Prefill from a setup that has levels (a trade, or a rejected one the user may still want to size).
  useEffect(() => {
    if (edited) return;
    if (setup && setup.pair === pair && setup.entry != null && setup.stop != null) {
      setEntry(String(setup.entry));
      setStop(String(setup.stop));
      setTarget(String(setup.tp2 ?? setup.tp1 ?? ''));
      setResult(null);
      setErr(null);
    }
  }, [setup, pair, edited]);

  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    setEdited(true);
    set(e.target.value);
  };

  async function calculate(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setResult(null);
    if (!entry || !stop) {
      setErr('Enter an entry and a stop price.');
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post('/api/size', {
        pair, entry: Number(entry), stop: Number(stop), target: target === '' ? null : Number(target),
        account: Number(account), riskPct: Number(risk), leverage: Number(leverage),
      });
      setResult(data as SizeResult);
    } catch (e2) {
      setErr(errorText(e2, 'Could not calculate the size.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Position sizer">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
        <Calculator size={18} aria-hidden /> Position sizer
        <span className="text-xs font-normal text-slate-500">{pairLabel(pair)} · USD account</span>
      </h3>
      <form onSubmit={calculate} className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className="text-xs text-slate-400">Entry<input aria-label="Entry" className={field} inputMode="decimal" value={entry} onChange={edit(setEntry)} /></label>
        <label className="text-xs text-slate-400">Stop<input aria-label="Stop" className={field} inputMode="decimal" value={stop} onChange={edit(setStop)} /></label>
        <label className="text-xs text-slate-400">Target<input aria-label="Target" className={field} inputMode="decimal" value={target} onChange={edit(setTarget)} /></label>
        <label className="text-xs text-slate-400">Account (USD)<input aria-label="Account" className={field} inputMode="decimal" value={account} onChange={edit(setAccount)} /></label>
        <label className="text-xs text-slate-400">Risk %<input aria-label="Risk percent" className={field} inputMode="decimal" value={risk} onChange={edit(setRisk)} /></label>
        <label className="text-xs text-slate-400">Leverage<input aria-label="Leverage" className={field} inputMode="decimal" value={leverage} onChange={edit(setLeverage)} /></label>
        <button type="submit" disabled={busy} className="col-span-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50 sm:col-span-3">
          {busy ? 'Calculating...' : 'Calculate size'}
        </button>
      </form>
      {err && <p role="alert" className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{err}</p>}
      {result && (
        <div data-testid="size-result" className="mt-3 rounded-lg bg-white/5 p-3">
          <p className="text-lg font-bold text-slate-100">
            {result.lots.toFixed(2)} lots <span className="text-sm font-normal text-slate-400">= {result.units.toLocaleString()} {result.unitName} · {result.side}</span>
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-slate-400">Loss at stop</dt><dd className="text-right font-mono text-rose-300">{money(result.lossAtStop)}</dd>
            <dt className="text-slate-400">Gain at target</dt><dd className="text-right font-mono text-emerald-300">{money(result.gainAtTarget)}</dd>
            <dt className="text-slate-400">Stop distance</dt><dd className="text-right font-mono text-slate-200">{result.stopPips} pips</dd>
            <dt className="text-slate-400">Reward : risk</dt><dd className="text-right font-mono text-slate-200">{result.rewardRisk ?? '-'}</dd>
            <dt className="text-slate-400">Pip value / lot</dt><dd className="text-right font-mono text-slate-200">{money(result.pipValue)}</dd>
            <dt className="text-slate-400">Margin</dt><dd className="text-right font-mono text-slate-200">{money(result.margin)}</dd>
          </dl>
          <p className="mt-2 text-xs text-slate-500">
            Limited by {result.limit}: {result.byRisk.toFixed(2)} lots by your {money(result.maxLoss)} max loss,
            {' '}{result.byLeverage.toFixed(2)} by leverage. Spread, swap and slippage are not included.
          </p>
        </div>
      )}
    </section>
  );
}
